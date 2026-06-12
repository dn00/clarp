import { randomUUID } from "node:crypto";
import type { Args } from "./args.js";
import type { Observation, ObservationBackend } from "./backends/types.js";
import { PidWatcher, type PidWatcherCallbacks } from "./pid-watcher.js";
import { PromptQueue } from "./prompt-queue.js";
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

const READY_TIMEOUT_MS = 30_000;
const TRANSCRIPT_EVENT_CLOCK_SKEW_MS = 5_000;
const EMPTY_TURN_TRANSCRIPT_GRACE_MS = 1500;
const SUBMIT_VERIFY_INTERVAL_MS = 1500;
const SUBMIT_VERIFY_RETRIES = 3;
type PidWatcherLike = Pick<
  PidWatcher,
  "start" | "stop" | "getSessionId" | "getTranscriptPath" | "readTranscriptInit" | "readTranscriptEvents"
>;

type ReadyWaiter = {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
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
 * Coordinates the PTY, PID watcher, observation backend, stdin prompt queue,
 * and stream-json output lifecycle for one Claude process.
 */
export class SessionController {
  private turnActive = false;
  private submitVerifyTimer: ReturnType<typeof setTimeout> | null = null;
  private submitRetriesLeft = 0;
  private turnCount = 0;
  private turnStart = 0;
  private claudeReady = false;
  private waitingForAction = false;
  private processExited = false;
  private stdinClosed = false;
  private pendingPermissionRequestId: string | null = null;
  private permissionWarningShown = false;
  private promptQueue = new PromptQueue();
  private readyWaiter: ReadyWaiter | null = null;
  private pidWatcher: PidWatcherLike;
  private started = false;
  private shuttingDown = false;
  private cleanupStarted = false;
  private forceExitTimer: ReturnType<typeof setTimeout> | null = null;
  private pidWatcherTimer: ReturnType<typeof setTimeout> | null = null;
  private emptyTurnTimer: ReturnType<typeof setTimeout> | null = null;
  private cleanupPromise: Promise<void> | null = null;
  private cleanupResolve: (() => void) | null = null;
  private cleanupReject: ((err: unknown) => void) | null = null;
  private shutdownExitCode = 0;
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
      this.clearSubmitVerification();
      output.emitSessionStateChanged("running");
    } else if (status === "waiting") {
      this.waitingForAction = true;
      this.clearSubmitVerification();
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
      this.turnActive = true;
      this.turnCount++;
      this.turnStart = Date.now();

      if (this.turnCount > 1) {
        this.emitInitFromTranscriptOrFallback();
      }

      if (this.opts.args.maxTurns && this.turnCount > this.opts.args.maxTurns) {
        this.log(`Max turns (${this.opts.args.maxTurns}) reached`);
        sendInterrupt(this.opts.ptyHandle);
      }
    }

    if (status === "idle" && this.turnActive) {
      this.completeTurnOrWaitForTranscriptError();
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
    this.promptQueue.enqueue({ content });
  }

  /**
   * Handles stream-json control requests from stdin.
   */
  handleControlRequest(req: Record<string, unknown>, requestId?: string): void {
    if (this.processExited) return;
    if (req.subtype === "interrupt") {
      this.log("Interrupt");
      if (!this.shouldForwardControlInterrupt()) return;
      sendInterrupt(this.opts.ptyHandle);
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
        sendSlashCommand(this.opts.ptyHandle, `model ${model}`);
      }
    } else if (req.subtype === "stop_task") {
      this.log("Stop task");
      if (!this.shouldForwardControlInterrupt()) return;
      sendInterrupt(this.opts.ptyHandle);
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
      sendPermissionAllow(this.opts.ptyHandle);
    } else if (resp.behavior === "deny") {
      this.log(`Permission deny: ${requestId}`);
      sendPermissionDeny(this.opts.ptyHandle);
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
    this.clearSubmitVerification();
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
    if (!this.processExited) {
      sendInterrupt(this.opts.ptyHandle);
      setTimeout(() => {
        if (!this.processExited) this.opts.ptyHandle.kill("SIGTERM");
      }, 2000);
    }
  }

  /**
   * Requests graceful termination of Claude and backend resources.
   */
  async shutdown(exitCode = 0): Promise<void> {
    if (this.cleanupStarted) return this.cleanupPromise ?? Promise.resolve();
    if (this.shuttingDown) return this.ensureCleanupPromise();
    this.shuttingDown = true;
    this.shutdownExitCode = exitCode;
    this.promptQueue.close();
    this.wakeReady();

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
      const hasItem = await this.promptQueue.waitForItem();
      if (!hasItem || this.processExited || this.shuttingDown) break;
      await this.waitForReady();
      if (this.processExited || this.shuttingDown) break;
      const item = this.promptQueue.dequeue();
      if (!item) continue;

      this.log(`Sending: ${item.content.slice(0, 80)}`);
      output.resetAccumulatedText();
      output.emitUserReplay(item.content);
      this.claudeReady = false;
      sendPrompt(this.opts.ptyHandle, item.content);
      this.armSubmitVerification();
    }
  }

  /**
   * Watches that a dispatched prompt actually started a turn. Even with
   * bracketed paste, the submitting Enter can be lost to TUI input races;
   * the prompt text is then still sitting in Claude's composer, so pressing
   * Enter again submits it. Cancelled the moment a turn starts, and never
   * fires while Claude is waiting on a permission prompt (an extra Enter
   * there would approve it).
   */
  private armSubmitVerification(): void {
    this.clearSubmitVerification();
    this.submitRetriesLeft = SUBMIT_VERIFY_RETRIES;
    this.scheduleSubmitCheck();
  }

  private scheduleSubmitCheck(): void {
    this.submitVerifyTimer = setTimeout(() => {
      this.submitVerifyTimer = null;
      if (this.processExited || this.shuttingDown) return;
      if (this.turnActive || this.waitingForAction || this.pendingPermissionRequestId !== null) return;
      if (this.submitRetriesLeft <= 0) {
        this.log("Prompt did not start a turn after submit retries; giving up");
        return;
      }
      this.submitRetriesLeft--;
      this.log(
        `No turn ${SUBMIT_VERIFY_INTERVAL_MS}ms after dispatch — prompt likely stuck in composer; pressing Enter again`,
      );
      this.opts.ptyHandle.write("\r");
      this.scheduleSubmitCheck();
    }, SUBMIT_VERIFY_INTERVAL_MS);
  }

  private clearSubmitVerification(): void {
    if (this.submitVerifyTimer) {
      clearTimeout(this.submitVerifyTimer);
      this.submitVerifyTimer = null;
    }
    this.submitRetriesLeft = 0;
  }

  private waitForReady(): Promise<void> {
    if (this.claudeReady && !this.turnActive) return Promise.resolve();
    if (this.processExited || this.shuttingDown) return Promise.resolve();
    if (this.readyWaiter) {
      this.readyWaiter.reject(new Error("Superseded by a newer readiness wait"));
      clearTimeout(this.readyWaiter.timer);
      this.readyWaiter = null;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.readyWaiter?.timer === timer) {
          this.readyWaiter = null;
        }
        reject(new Error(
          `Timed out after ${READY_TIMEOUT_MS / 1000}s waiting for Claude to become ready. ` +
          `This can happen if Claude is showing a workspace trust dialog. ` +
          `Try --dangerously-skip-permissions or run from a trusted project directory.`
        ));
      }, READY_TIMEOUT_MS);
      this.readyWaiter = { resolve, reject, timer };
    });
  }

  private markReady(): void {
    this.claudeReady = true;
    this.wakeReady();
  }

  private wakeReady(): void {
    if (this.readyWaiter) {
      const waiter = this.readyWaiter;
      this.readyWaiter = null;
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  private shouldForwardControlInterrupt(): boolean {
    return this.turnActive || this.waitingForAction || this.pendingPermissionRequestId !== null;
  }

  private completeTurn(): void {
    this.clearEmptyTurnTimer();
    this.turnActive = false;
    const text = output.getAccumulatedText();
    const durationMs = Date.now() - this.turnStart;

    if (this.transcriptTurnError) {
      this.completeTurnWithError(this.transcriptTurnError.message, this.transcriptTurnError.status, durationMs);
      return;
    }

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
    if (!this.stdinClosed || this.turnActive || this.promptQueue.length > 0) return;
    this.log("stdin closed and queue empty, exiting");
    this.requestShutdown(0);
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
    this.promptQueue.close();
    this.wakeReady();
    if (this.forceExitTimer) {
      clearTimeout(this.forceExitTimer);
      this.forceExitTimer = null;
    }
    if (this.pidWatcherTimer) {
      clearTimeout(this.pidWatcherTimer);
      this.pidWatcherTimer = null;
    }
    this.clearEmptyTurnTimer();

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
