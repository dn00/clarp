import { randomUUID } from "node:crypto";
import type { Args } from "./args.js";
import type { Observation, ObservationBackend } from "./backends/types.js";
import { PidWatcher, type PidWatcherCallbacks } from "./pid-watcher.js";
import { PromptQueue } from "./prompt-queue.js";
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
  private turnCount = 0;
  private turnStart = 0;
  private claudeReady = false;
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
  private cleanupPromise: Promise<void> | null = null;
  private cleanupResolve: (() => void) | null = null;
  private cleanupReject: ((err: unknown) => void) | null = null;
  private shutdownExitCode = 0;

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
      output.emitTranscriptEvent(obs.line);
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
    output.emitStatus(status, waitingFor);

    if (status === "busy") {
      output.emitSessionStateChanged("running");
    } else if (status === "waiting") {
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
      this.completeTurn();
      return;
    }

    if (status === "idle" && !this.claudeReady) {
      this.markReady();
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
    if (!this.turnActive && this.promptQueue.length === 0) {
      this.requestShutdown(0);
    }
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
    await this.opts.backend.startObserving({
      transcriptPath: this.pidWatcher.getTranscriptPath() ?? undefined,
    });
  }

  private async runDispatchLoop(): Promise<void> {
    while (!this.processExited && !this.shuttingDown) {
      const hasItem = await this.promptQueue.waitForItem();
      if (!hasItem || this.processExited || this.shuttingDown) break;
      const item = this.promptQueue.dequeue();
      if (!item) continue;

      await this.waitForReady();
      if (this.processExited || this.shuttingDown) break;

      this.log(`Sending: ${item.content.slice(0, 80)}`);
      output.resetAccumulatedText();
      output.emitUserReplay(item.content);
      this.claudeReady = false;
      sendPrompt(this.opts.ptyHandle, item.content);
    }
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

  private completeTurn(): void {
    this.turnActive = false;
    const text = output.getAccumulatedText();
    const durationMs = Date.now() - this.turnStart;

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
    if (this.stdinClosed && this.promptQueue.length === 0) {
      this.log("stdin closed and queue empty, exiting");
      this.requestShutdown(0);
    }
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

    const cleanupPromise = this.ensureCleanupPromise();
    void (async () => {
      try {
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
