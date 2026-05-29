import { randomUUID } from "node:crypto";
import type { Args } from "./args.js";
import type { Observation, ObservationBackend } from "./backends/types.js";
import { PidWatcher, type PidWatcherCallbacks } from "./pid-watcher.js";
import {
  type ControlOp,
  type NormalOp,
  type PermissionResponseOp,
  type PromptOp,
  type SlashCommandOp,
  SessionOpQueue,
} from "./session-op-queue.js";
import {
  formatTranscriptApiError,
  formatTranscriptApiRetry,
  getTranscriptApiErrorInfo,
  getTranscriptAssistantText,
  isRetryExhausted,
  isTranscriptApiError,
  isTranscriptApiErrorMessage,
} from "./transcript-events.js";
import { TranscriptObserver } from "./transcript-observer.js";
import {
  sendInterrupt,
  sendPermissionAllow,
  sendPermissionDeny,
  sendPrompt,
  sendSlashCommand,
  type PtyHandle,
} from "./pty-host.js";
import * as output from "./output.js";

const TRANSCRIPT_EVENT_CLOCK_SKEW_MS = 5_000;
const READY_TIMEOUT_MS = 30_000;
const EMPTY_TURN_TRANSCRIPT_GRACE_MS = 1500;
const INTERRUPT_DISPATCH_ACK_TIMEOUT_MS = 2000;
const INTERRUPT_ESCAPE_ACK_TIMEOUT_MS = 1000;
const INTERRUPT_CTRL_C_ACK_TIMEOUT_MS = 1500;
const INTERRUPT_SIGINT_ACK_TIMEOUT_MS = 2000;

type PidWatcherLike = Pick<
  PidWatcher,
  "start" | "stop" | "getSessionId" | "getTranscriptPath" | "readTranscriptInit" | "readTranscriptEvents"
>;

type InterruptMethod = "pty_escape" | "pty_ctrl_c" | "process_sigint" | "process_sigterm";

type InterruptTransaction = {
  requestId: string;
  controlRequestId?: string;
  reason: string;
  startedAt: number;
  methods: InterruptMethod[];
  timer: ReturnType<typeof setTimeout> | null;
};

export type SessionControllerOptions = {
  ptyHandle: PtyHandle;
  pid: number;
  pidWatcherFactory?: (pid: number, callbacks: PidWatcherCallbacks) => PidWatcherLike;
  backend: ObservationBackend;
  args: Args;
  log?: (msg: string) => void;
  onExit: (code: number) => void;
};

/**
 * Coordinates the PTY, PID watcher, observation backend, session operation queue,
 * and stream-json output lifecycle for one Claude process.
 */
export class SessionController {
  private turnActive = false;
  private turnCount = 0;
  private turnStart = 0;
  private claudeReady = false;
  private waitingForAction = false;
  private processExited = false;
  private stdinClosed = false;
  private pendingPermissionRequestId: string | null = null;
  private permissionWarningShown = false;
  private opQueue = new SessionOpQueue();
  private pidWatcher: PidWatcherLike;
  private started = false;
  private shuttingDown = false;
  private cleanupStarted = false;
  private forceExitTimer: ReturnType<typeof setTimeout> | null = null;
  private pidWatcherTimer: ReturnType<typeof setTimeout> | null = null;
  private emptyTurnTimer: ReturnType<typeof setTimeout> | null = null;
  private readinessTimer: ReturnType<typeof setTimeout> | null = null;
  private cleanupPromise: Promise<void> | null = null;
  private cleanupResolve: (() => void) | null = null;
  private cleanupReject: ((err: unknown) => void) | null = null;
  private shutdownExitCode = 0;
  private interruptInFlight: InterruptTransaction | null = null;
  private interruptSequence = 0;
  private promptDispatchInFlight = false;
  private turnInterrupted = false;
  private prefixNextPromptWithInterruptedMarker = false;
  private interruptedOnlyExitCode: number | null = null;
  private readonly startedAt = Date.now();
  private backendObservationStarted = false;
  private transcriptObserver: TranscriptObserver | null = null;
  private observedTranscriptPath: string | null = null;
  private transcriptTurnError: { message: string; status?: number } | null = null;

  constructor(private opts: SessionControllerOptions) {
    this.pidWatcher = (opts.pidWatcherFactory ?? ((pid, callbacks) => new PidWatcher(pid, callbacks)))(
      opts.pid,
      { onStatusChange: (status, waitingFor, _data) => this.handleStatusChange(status, waitingFor) },
    );
  }

  /**
   * Starts observation and prompt dispatch. Safe to call more than once.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.opts.backend.onObservation((obs) => this.handleObservation(obs));
    this.pidWatcherTimer = setTimeout(() => {
      this.startPidWatcherAndBackend().catch((err: Error) => {
        this.reportAsyncError("Backend observation start failed", err);
        this.requestShutdown(1);
      });
    }, 1500);
    this.runDispatchLoop().catch((err: Error) => {
      this.reportAsyncError("Dispatch loop failed", err);
      this.requestShutdown(1);
    });
  }

  /**
   * Routes backend observations into the output layer.
   */
  handleObservation(obs: Observation): void {
    if (this.processExited) return;
    if (obs.kind === "sse") {
      output.emitSSE(obs.event);
    } else if (obs.kind === "transcript_line") {
      this.handleTranscriptLine(obs.line);
    } else if (obs.kind === "rate_limit") {
      output.emitRateLimitEvent({ statusCode: obs.statusCode, retryAfter: obs.retryAfter });
    } else if (obs.kind === "api_retry") {
      output.emitApiRetry(obs.statusCode);
    } else if (obs.kind === "error") {
      this.log(`Backend error: ${obs.message}`);
    }
  }

  /**
   * Updates turn state from Claude's PID status file.
   */
  handleStatusChange(status: string, waitingFor?: string): void {
    if (this.processExited) return;
    this.log(`Status: ${status}${waitingFor ? ` (${waitingFor})` : ""}`);
    this.startOrUpdateTranscriptObservation();
    output.emitStatus(status, waitingFor);

    if (status === "busy") {
      this.waitingForAction = false;
      output.emitSessionStateChanged("running");
    } else if (status === "waiting") {
      this.waitingForAction = true;
      output.emitSessionStateChanged("requires_action");
      if (this.opts.args.inputFormat !== "stream-json" && !this.permissionWarningShown) {
        this.permissionWarningShown = true;
        process.stderr.write(
          "clarp warning: Claude is waiting for permission, but stream-json control responses are not enabled. " +
          "Rerun with --input-format stream-json or use --dangerously-skip-permissions.\n",
        );
      }

      if (waitingFor && !this.pendingPermissionRequestId) {
        const toolInfo = output.getLastToolUse();
        if (toolInfo) {
          this.pendingPermissionRequestId = randomUUID();
          this.log(`Permission request: ${toolInfo.name} (${this.pendingPermissionRequestId})`);
          output.emitControlRequest(
            this.pendingPermissionRequestId,
            toolInfo.name,
            toolInfo.id,
            toolInfo.input,
          );
        }
      }
    } else if (status === "idle") {
      this.waitingForAction = false;
      output.emitSessionStateChanged("idle");
      this.pendingPermissionRequestId = null;
    }

    if (status === "busy" && !this.turnActive) {
      this.promptDispatchInFlight = false;
      this.turnActive = true;
      this.turnCount++;
      this.turnStart = Date.now();

      if (this.turnCount > 1) {
        this.emitInitFromTranscriptOrFallback();
      }

      if (this.opts.args.maxTurns && this.turnCount > this.opts.args.maxTurns) {
        this.log(`Max turns (${this.opts.args.maxTurns}) reached`);
        this.opQueue.enqueue({
          type: "interrupt",
          reason: "max_turns",
          emitControlResponse: false,
        });
      }

      this.sendPendingDispatchInterrupt("pid_busy");
    }

    if (status === "idle") {
      this.completeInterrupt("pid_idle");
    }

    if (status === "idle" && this.turnActive) {
      if (this.turnInterrupted) {
        this.completeTurn();
      } else {
        this.completeTurnOrWaitForTranscriptError();
      }
      return;
    }

    if (status === "idle" && !this.claudeReady) {
      this.markReady();
    }

    if (status === "idle") {
      this.maybeShutdownAfterInputDrained();
    }
  }

  /**
   * Queues a prompt to be sent once Claude is ready for input.
   */
  enqueuePrompt(content: string): void {
    this.opQueue.enqueue({ type: "prompt", content });
  }

  /**
   * Handles stream-json control requests from stdin.
   */
  handleControlRequest(req: Record<string, unknown>, requestId?: string): void {
    if (this.processExited) return;
    if (req.subtype === "interrupt") {
      this.log("Interrupt");
      this.opQueue.enqueue({
        type: "interrupt",
        reason: "control_request",
        requestId,
        emitControlResponse: true,
      });
    } else if (req.subtype === "get_context_usage" && requestId) {
      const usage = output.getContextUsage();
      this.log(`Context usage: ${usage.input_tokens} in, ${usage.output_tokens} out`);
      process.stdout.write(JSON.stringify({
        type: "control_response",
        request_id: requestId,
        response: { context_usage: usage },
        session_id: output.getSessionId(),
      }) + "\n");
    } else if (req.subtype === "set_model") {
      const model = req.model as string;
      if (model) {
        this.log(`Set model: ${model}`);
        this.opQueue.enqueue({ type: "slash_command", command: `model ${model}` });
      }
    } else if (req.subtype === "stop_task") {
      this.log("Stop task");
      this.opQueue.enqueue({
        type: "stop_task",
        reason: "stop_task",
        requestId,
        emitControlResponse: true,
      });
    }
  }

  /**
   * Applies a stream-json response to a pending permission request.
   */
  handleControlResponse(resp: Record<string, unknown>, requestId: string): void {
    if (this.processExited) return;
    if (requestId !== this.pendingPermissionRequestId) return;
    if (resp.behavior === "allow") {
      this.log(`Permission allow: ${requestId}`);
      this.opQueue.enqueue({ type: "permission_response", behavior: "allow", requestId });
    } else if (resp.behavior === "deny") {
      this.log(`Permission deny: ${requestId}`);
      this.opQueue.enqueue({ type: "permission_response", behavior: "deny", requestId });
    }
    this.pendingPermissionRequestId = null;
  }

  /**
   * Finalizes output and cleanup after the Claude process exits.
   */
  handleClaudeExit(code: number): void {
    if (this.processExited && this.cleanupStarted) return;
    this.processExited = true;
    this.log(`Claude exited: ${code}`);
    this.clearEmptyTurnTimer();
    this.completeInterrupt("process_exit");
    if (this.turnActive) {
      this.turnActive = false;
      if (!this.opts.backend.capabilities.emitsResults) {
        const text = output.getAccumulatedText();
        if (code === 0) {
          output.emitResult("success", text, { durationMs: Date.now() - this.turnStart, numTurns: this.turnCount });
        } else {
          output.emitResult("error", `Claude exited with code ${code}`, { durationMs: Date.now() - this.turnStart, numTurns: this.turnCount });
        }
      }
    }
    this.requestCleanup(this.shuttingDown ? this.shutdownExitCode : 0);
  }

  /**
   * Marks stdin closed and exits when no prompt or turn is pending.
   */
  handleStdinEof(): void {
    this.stdinClosed = true;
    this.maybeShutdownAfterInputDrained();
  }

  /**
   * Sends a soft interrupt, then escalates if Claude does not exit.
   */
  interrupt(): void {
    this.log("SIGINT");
    if (this.processExited) return;

    if (this.shouldForwardControlInterrupt()) {
      this.opQueue.enqueue({
        type: "interrupt",
        reason: "process_sigint",
        emitControlResponse: false,
      });
    } else {
      sendInterrupt(this.opts.ptyHandle);
    }
    setTimeout(() => {
      if (!this.processExited) this.opts.ptyHandle.kill("SIGTERM");
    }, 2000);
  }

  /**
   * Requests graceful termination of Claude and backend resources.
   */
  async shutdown(exitCode = 0): Promise<void> {
    if (this.cleanupStarted) return this.cleanupPromise ?? Promise.resolve();
    if (this.shuttingDown) return this.ensureCleanupPromise();
    this.shuttingDown = true;
    this.shutdownExitCode = exitCode;
    this.opQueue.close();
    this.clearInterruptTimer();

    if (!this.processExited) {
      const cleanupPromise = this.ensureCleanupPromise();
      this.opts.ptyHandle.kill("SIGTERM");
      this.forceExitTimer = setTimeout(() => {
        if (!this.processExited) {
          this.processExited = true;
          this.requestCleanup(exitCode);
        }
      }, 3000);
      return cleanupPromise;
    }

    await this.cleanup(exitCode);
  }

  private async startPidWatcherAndBackend(): Promise<void> {
    if (this.processExited || this.shuttingDown) return;
    this.pidWatcher.start();
    const sid = this.pidWatcher.getSessionId();
    if (sid) {
      this.emitInitFromTranscriptOrFallback();
      this.log(`Session: ${sid}`);
    }
    await this.startOrUpdateBackendObservation();
    this.startOrUpdateTranscriptObservation();
  }

  private async startOrUpdateBackendObservation(): Promise<void> {
    if (this.backendObservationStarted) return;
    this.backendObservationStarted = true;
    await this.opts.backend.startObserving();
  }

  private startOrUpdateTranscriptObservation(): void {
    const transcriptPath = this.pidWatcher.getTranscriptPath();
    if (!transcriptPath || transcriptPath === this.observedTranscriptPath) return;

    this.transcriptObserver?.stop();
    this.observedTranscriptPath = transcriptPath;
    this.transcriptObserver = new TranscriptObserver({
      transcriptPath,
      onLine: (line) => {
        if (this.isCurrentTranscriptErrorEvent(line)) {
          this.handleTranscriptLine(line);
        }
      },
      onError: (err) => this.log(`Transcript observer error: ${err.message}`),
    });
    this.transcriptObserver.start();
  }

  private isCurrentTranscriptErrorEvent(line: Record<string, unknown>): boolean {
    if (!isTranscriptApiError(line) && !isTranscriptApiErrorMessage(line)) return false;
    if (typeof line.timestamp !== "string") return true;
    const timestamp = Date.parse(line.timestamp);
    return !Number.isFinite(timestamp) || timestamp >= this.startedAt - TRANSCRIPT_EVENT_CLOCK_SKEW_MS;
  }

  private async runDispatchLoop(): Promise<void> {
    while (!this.processExited && !this.shuttingDown) {
      if (this.processNextSessionOp()) continue;
      if (this.opQueue.isClosed && this.opQueue.length === 0) break;
      await this.waitForSessionOpChange();
    }
  }

  private waitForSessionOpChange(): Promise<void> {
    if (this.opQueue.normalLength === 0 || this.isReadyForPrompt()) {
      this.clearReadinessTimer();
      return this.opQueue.waitForChange();
    }

    if (!this.readinessTimer) {
      this.readinessTimer = setTimeout(() => {
        this.readinessTimer = null;
        if (
          this.processExited ||
          this.shuttingDown ||
          this.opQueue.normalLength === 0 ||
          this.isReadyForPrompt()
        ) return;
        const err = new Error(
          `Timed out after ${READY_TIMEOUT_MS / 1000}s waiting for Claude to become ready. ` +
          `Claude may be showing a startup, trust, or permission prompt, or Clarp may be unable to observe Claude's PID status. ` +
          `Open Claude Code in this project to resolve any prompts, check that the project is trusted, ` +
          `or use --dangerously-skip-permissions only when that matches your security policy.`
        );
        this.reportAsyncError("Dispatch loop failed", err);
        this.requestShutdown(1);
        this.opQueue.wake();
      }, READY_TIMEOUT_MS);
    }

    return this.opQueue.waitForChange();
  }

  private processNextSessionOp(): boolean {
    const control = this.opQueue.dequeueControl();
    if (control) {
      this.applyControlOp(control);
      return true;
    }

    if (!this.isReadyForPrompt()) return false;
    const normal = this.opQueue.dequeueNormal();
    if (!normal) return false;
    this.applyNormalOp(normal);
    return true;
  }

  private applyNormalOp(op: NormalOp): void {
    if (op.type === "prompt") {
      this.dispatchPrompt(op);
    } else {
      this.dispatchSlashCommand(op);
    }
  }

  private dispatchPrompt(item: PromptOp): void {
    this.log(`Sending: ${item.content.slice(0, 80)}`);
    output.resetAccumulatedText();
    output.emitUserReplay(item.content);
    this.claudeReady = false;
    this.promptDispatchInFlight = true;
    const content = this.prefixNextPromptWithInterruptedMarker
      ? `[Request interrupted by user]\n\n${item.content}`
      : item.content;
    this.prefixNextPromptWithInterruptedMarker = false;
    sendPrompt(this.opts.ptyHandle, content);
  }

  private dispatchSlashCommand(op: SlashCommandOp): void {
    sendSlashCommand(this.opts.ptyHandle, op.command);
  }

  private applyControlOp(op: ControlOp): void {
    if (op.type === "permission_response") {
      this.applyPermissionResponseOp(op);
      return;
    }
    this.requestControlInterrupt(op.reason, op.requestId, op.emitControlResponse);
  }

  private applyPermissionResponseOp(op: PermissionResponseOp): void {
    this.claudeReady = false;
    if (op.behavior === "allow") {
      sendPermissionAllow(this.opts.ptyHandle);
    } else {
      sendPermissionDeny(this.opts.ptyHandle);
    }
  }

  private markReady(): void {
    this.clearReadinessTimer();
    this.claudeReady = true;
    if (this.isReadyForPrompt()) this.opQueue.wake();
  }

  private shouldForwardControlInterrupt(): boolean {
    return (
      this.turnActive ||
      this.promptDispatchInFlight ||
      this.waitingForAction ||
      this.pendingPermissionRequestId !== null ||
      this.opQueue.normalLength > 0
    );
  }

  private isReadyForPrompt(): boolean {
    const interruptWaitingForPromptDispatch = (
      this.interruptInFlight !== null &&
      this.interruptInFlight.methods.length === 0 &&
      !this.turnActive &&
      !this.promptDispatchInFlight &&
      !this.waitingForAction
    );
    return (
      this.claudeReady &&
      !this.turnActive &&
      !this.promptDispatchInFlight &&
      !this.waitingForAction &&
      this.pendingPermissionRequestId === null &&
      (this.interruptInFlight === null || interruptWaitingForPromptDispatch) &&
      !this.processExited &&
      !this.shuttingDown
    );
  }

  private requestControlInterrupt(reason: string, controlRequestId?: string, emitControlResponse = false): void {
    if (this.interruptInFlight) {
      if (emitControlResponse) output.emitControlResponseSuccess(controlRequestId);
      this.handleDuplicateInterrupt(reason);
      return;
    }
    if (!this.shouldForwardControlInterrupt()) return;

    const tx: InterruptTransaction = {
      requestId: `interrupt-${++this.interruptSequence}`,
      controlRequestId,
      reason,
      startedAt: Date.now(),
      methods: [],
      timer: null,
    };
    this.interruptInFlight = tx;
    this.turnInterrupted = true;
    this.interruptedOnlyExitCode = reason === "process_sigint" ? 0 : 1;
    if (emitControlResponse) output.emitControlResponseSuccess(controlRequestId);

    if (
      !this.turnActive &&
      !this.waitingForAction &&
      this.pendingPermissionRequestId === null &&
      (this.promptDispatchInFlight || this.opQueue.normalLength > 0)
    ) {
      this.log(`Interrupt deferred until prompt dispatch is accepted (${reason})`);
      this.scheduleInterruptEscalation(tx, INTERRUPT_DISPATCH_ACK_TIMEOUT_MS);
      return;
    }

    this.claudeReady = false;
    this.sendInterruptEscape(tx);
  }

  private sendPendingDispatchInterrupt(via: "pid_busy" | "dispatch_timeout"): void {
    const tx = this.interruptInFlight;
    if (!tx || tx.methods.includes("pty_escape")) return;
    this.log(`Interrupt dispatch accepted: ${via} (${tx.requestId})`);
    this.sendInterruptEscape(tx);
  }

  private sendInterruptEscape(tx: InterruptTransaction): void {
    if (this.interruptInFlight !== tx || tx.methods.includes("pty_escape")) return;
    tx.methods.push("pty_escape");
    sendInterrupt(this.opts.ptyHandle);
    this.log(`Interrupt sent: pty_escape (${tx.reason})`);
    this.scheduleInterruptEscalation(tx, INTERRUPT_ESCAPE_ACK_TIMEOUT_MS);
  }

  private handleDuplicateInterrupt(reason: string): void {
    const tx = this.interruptInFlight;
    if (!tx) return;
    const elapsedMs = Date.now() - tx.startedAt;
    if (elapsedMs < 500) {
      this.log(`Interrupt already in flight: ${tx.requestId} (${reason})`);
      return;
    }
    this.log(`Interrupt duplicate escalates: ${tx.requestId} (${reason})`);
    this.escalateInterrupt(tx);
  }

  private scheduleInterruptEscalation(tx: InterruptTransaction, delayMs: number): void {
    if (tx.timer) clearTimeout(tx.timer);
    tx.timer = setTimeout(() => {
      if (this.interruptInFlight === tx && !this.processExited) {
        this.escalateInterrupt(tx);
      }
    }, delayMs);
  }

  private escalateInterrupt(tx: InterruptTransaction): void {
    if (this.interruptInFlight !== tx) return;
    if (tx.timer) {
      clearTimeout(tx.timer);
      tx.timer = null;
    }

    if (!tx.methods.includes("pty_escape")) {
      this.sendPendingDispatchInterrupt("dispatch_timeout");
      return;
    }

    if (!tx.methods.includes("pty_ctrl_c")) {
      tx.methods.push("pty_ctrl_c");
      this.opts.ptyHandle.write("\x03");
      this.log(`Interrupt escalated: pty_ctrl_c (${tx.requestId})`);
      this.scheduleInterruptEscalation(tx, INTERRUPT_CTRL_C_ACK_TIMEOUT_MS);
      return;
    }

    if (!tx.methods.includes("process_sigint")) {
      tx.methods.push("process_sigint");
      this.opts.ptyHandle.kill("SIGINT");
      this.log(`Interrupt escalated: process_sigint (${tx.requestId})`);
      this.scheduleInterruptEscalation(tx, INTERRUPT_SIGINT_ACK_TIMEOUT_MS);
      return;
    }

    if (!tx.methods.includes("process_sigterm")) {
      tx.methods.push("process_sigterm");
      this.opts.ptyHandle.kill("SIGTERM");
      this.log(`Interrupt escalated: process_sigterm (${tx.requestId})`);
    }
  }

  private completeInterrupt(via: "pid_idle" | "process_exit"): void {
    const tx = this.interruptInFlight;
    if (!tx) return;
    if (via === "pid_idle" && !tx.methods.includes("pty_escape")) return;
    this.clearInterruptTimer();
    this.interruptInFlight = null;
    this.log(
      `Interrupt acknowledged: ${via} (${tx.methods.join(", ")}; ${Date.now() - tx.startedAt}ms)`
    );
    this.opQueue.wake();
  }

  private clearInterruptTimer(): void {
    if (!this.interruptInFlight?.timer) return;
    clearTimeout(this.interruptInFlight.timer);
    this.interruptInFlight.timer = null;
  }

  private completeTurn(): void {
    this.clearEmptyTurnTimer();
    this.turnActive = false;
    const text = output.getAccumulatedText();
    const durationMs = Date.now() - this.turnStart;

    if (this.turnInterrupted) {
      this.completeInterruptedTurn(durationMs);
      return;
    }

    if (this.transcriptTurnError) {
      this.completeTurnWithError(this.transcriptTurnError.message, this.transcriptTurnError.status, durationMs);
      return;
    }
    this.interruptedOnlyExitCode = null;

    if (!this.opts.backend.capabilities.emitsPostTurnSummary) {
      const transcriptSummaries = this.pidWatcher.readTranscriptEvents("post_turn_summary");
      if (transcriptSummaries.length > 0) {
        const latest = transcriptSummaries[transcriptSummaries.length - 1]!;
        output.emitTranscriptEvent(latest);
      } else {
        output.emitPostTurnSummary({
          statusCategory: "completed",
          statusDetail: "Turn completed successfully",
          title: text.split("\n")[0]?.slice(0, 80) || "Turn completed",
          description: text.slice(0, 200),
          recentAction: output.getLastToolUse()?.name
            ? `Used ${output.getLastToolUse()!.name}` : "Generated text response",
          needsAction: "",
        });
      }
    }

    if (!this.opts.backend.capabilities.emitsResults) {
      output.emitResult("success", text, { durationMs, numTurns: this.turnCount });
    }
    output.resetAccumulatedText();

    if (this.opts.args.inputFormat !== "stream-json") {
      this.log("Single prompt complete, exiting");
      this.requestShutdown(0);
      return;
    }

    this.markReady();
    this.maybeShutdownAfterInputDrained();
  }

  private completeInterruptedTurn(durationMs: number): void {
    this.turnInterrupted = false;
    this.transcriptTurnError = null;
    output.emitInterruptedUserMessage();

    if (!this.opts.backend.capabilities.emitsResults) {
      output.emitResult("error_during_execution", "", {
        durationMs,
        numTurns: this.turnCount,
        stopReason: null,
        terminalReason: "aborted_streaming",
        errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"],
      });
    }
    output.resetAccumulatedText();

    if (this.opts.args.inputFormat !== "stream-json") {
      this.log("Single prompt interrupted, exiting");
      this.requestShutdown(this.interruptedOnlyExitCode ?? 0);
      return;
    }

    this.prefixNextPromptWithInterruptedMarker = true;
    this.markReady();
    this.maybeShutdownAfterInputDrained();
  }

  private handleTranscriptLine(line: Record<string, unknown>): void {
    output.emitTranscriptEvent(line);

    if (isTranscriptApiError(line)) {
      this.handleTranscriptApiError(line);
      return;
    }

    if (isTranscriptApiErrorMessage(line)) {
      const text = getTranscriptAssistantText(line) || "Claude API error";
      const status = typeof line.apiErrorStatus === "number" ? line.apiErrorStatus : undefined;
      this.failCurrentTurnFromTranscript(text, status);
    }
  }

  private handleTranscriptApiError(line: Record<string, unknown>): void {
    const info = getTranscriptApiErrorInfo(line);
    if (!info) return;

    if (this.opts.args.outputFormat === "text") {
      process.stderr.write(formatTranscriptApiRetry(info) + "\n");
    }

    if (isRetryExhausted(info)) {
      this.failCurrentTurnFromTranscript(formatTranscriptApiError(info), info.status);
    }
  }

  private failCurrentTurnFromTranscript(message: string, status?: number): void {
    this.transcriptTurnError = { message, status };
    this.clearEmptyTurnTimer();
    if (this.turnCount === 0) {
      this.turnCount = 1;
      this.turnStart = Date.now();
    }

    if (this.turnActive || this.opts.args.inputFormat !== "stream-json") {
      const durationMs = this.turnStart ? Date.now() - this.turnStart : undefined;
      this.turnActive = false;
      this.completeTurnWithError(message, status, durationMs);
    }
  }

  private completeTurnOrWaitForTranscriptError(): void {
    if (!this.transcriptObserver || output.getAccumulatedText().length > 0 || this.transcriptTurnError) {
      this.completeTurn();
      return;
    }

    if (this.emptyTurnTimer) return;
    this.emptyTurnTimer = setTimeout(() => {
      this.emptyTurnTimer = null;
      if (!this.processExited && !this.shuttingDown && this.turnActive) {
        this.completeTurn();
      }
    }, EMPTY_TURN_TRANSCRIPT_GRACE_MS);
  }

  private clearEmptyTurnTimer(): void {
    if (!this.emptyTurnTimer) return;
    clearTimeout(this.emptyTurnTimer);
    this.emptyTurnTimer = null;
  }

  private completeTurnWithError(message: string, status?: number, durationMs?: number): void {
    this.transcriptTurnError = null;

    if (!this.opts.backend.capabilities.emitsPostTurnSummary) {
      output.emitPostTurnSummary({
        statusCategory: "failed",
        statusDetail: status != null ? `API error ${status}` : "API error",
        title: message.split("\n")[0]?.slice(0, 80) || "API error",
        description: message.slice(0, 200),
        recentAction: "Received Claude API error",
        needsAction: "",
        isNoteworthy: true,
      });
    }

    if (!this.opts.backend.capabilities.emitsResults) {
      output.emitResult("error", message, {
        durationMs,
        numTurns: this.turnCount,
        stopReason: "api_error",
        apiErrorStatus: status,
      });
    }
    output.resetAccumulatedText();

    if (this.opts.args.inputFormat !== "stream-json") {
      this.log("Single prompt failed, exiting");
      this.requestShutdown(1);
      return;
    }

    this.markReady();
    this.maybeShutdownAfterInputDrained();
  }

  private maybeShutdownAfterInputDrained(): void {
    if (
      !this.stdinClosed ||
      this.turnActive ||
      this.promptDispatchInFlight ||
      this.interruptInFlight !== null ||
      this.opQueue.length > 0
    ) return;
    this.log("stdin closed and queue empty, exiting");
    this.requestShutdown(this.interruptedOnlyExitCode ?? 0);
  }

  private emitInitFromTranscriptOrFallback(): void {
    const transcriptInit = this.pidWatcher.readTranscriptInit();
    if (transcriptInit) {
      output.emitTranscriptEvent(transcriptInit);
      this.log("Init from transcript");
    } else {
      const sid = this.pidWatcher.getSessionId();
      if (sid) output.emitInit(sid, this.opts.args.cwd);
    }
  }

  private cleanup(exitCode: number): Promise<void> {
    if (this.cleanupStarted) return this.ensureCleanupPromise();
    this.cleanupStarted = true;
    this.opQueue.close();
    if (this.forceExitTimer) {
      clearTimeout(this.forceExitTimer);
      this.forceExitTimer = null;
    }
    if (this.pidWatcherTimer) {
      clearTimeout(this.pidWatcherTimer);
      this.pidWatcherTimer = null;
    }
    this.clearEmptyTurnTimer();
    this.clearInterruptTimer();
    this.clearReadinessTimer();

    const cleanupPromise = this.ensureCleanupPromise();
    void (async () => {
      try {
        this.transcriptObserver?.stop();
        this.transcriptObserver = null;
        this.pidWatcher.stop();
        await this.opts.backend.stop();
        this.opts.onExit(exitCode);
        this.cleanupResolve?.();
      } catch (err) {
        this.reportAsyncError("Cleanup failed", err);
        this.cleanupReject?.(err);
      }
    })();
    return cleanupPromise;
  }

  private requestShutdown(exitCode: number): void {
    this.shutdown(exitCode).catch((err: Error) => {
      this.reportAsyncError("Shutdown failed", err);
    });
  }

  private requestCleanup(exitCode: number): void {
    this.cleanup(exitCode).catch((err: Error) => {
      this.reportAsyncError("Cleanup failed", err);
    });
  }

  private reportAsyncError(context: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.log(`${context}: ${message}`);
    process.stderr.write(`clarp error: ${context}: ${message}\n`);
  }

  private clearReadinessTimer(): void {
    if (!this.readinessTimer) return;
    clearTimeout(this.readinessTimer);
    this.readinessTimer = null;
  }

  private ensureCleanupPromise(): Promise<void> {
    if (!this.cleanupPromise) {
      this.cleanupPromise = new Promise<void>((resolve, reject) => {
        this.cleanupResolve = resolve;
        this.cleanupReject = reject;
      });
    }
    return this.cleanupPromise;
  }

  private log(msg: string): void {
    this.opts.log?.(msg);
  }
}
