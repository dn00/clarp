import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionController } from "./session.js";
import type { Args } from "./args.js";
import type { Observation, ObservationBackend, BackendCapabilities } from "./backends/types.js";
import type { PidWatcherCallbacks } from "./pid-watcher.js";
import type { PtyHandle } from "./pty-host.js";
import * as output from "./output.js";

class FakeBackend implements ObservationBackend {
  readonly capabilities: BackendCapabilities = {
    emitsAssistantMessages: false,
    emitsResults: false,
    emitsPostTurnSummary: false,
    updatesOutputState: true,
    streamsTokens: true,
  };

  subscriber: ((obs: Observation) => void) | null = null;
  startCalls = 0;
  stopCalls = 0;

  async prepare(): Promise<void> {}
  getClaudeEnv(): Record<string, string> { return {}; }
  async startObserving(): Promise<void> {
    this.startCalls++;
  }
  async stop(): Promise<void> {
    this.stopCalls++;
  }
  onObservation(cb: (obs: Observation) => void): void {
    if (this.subscriber) throw new Error("one subscriber");
    this.subscriber = cb;
  }
}

const defaultArgs: Args = {
  outputFormat: "stream-json",
  inputFormat: "stream-json",
  verbose: true,
  includePartial: true,
  replayUserMessages: false,
  maxTurns: null,
  maxBudgetUsd: null,
  permissionPromptTool: null,
  prompt: null,
  readPromptFromStdin: false,
  claudeArgs: [],
  cwd: "/tmp",
};

function mockPty(): { handle: PtyHandle; kills: string[] } {
  const kills: string[] = [];
  return {
    kills,
    handle: {
      write: () => {},
      resize: () => {},
      kill: (signal?: string) => { kills.push(signal ?? ""); },
      pid: 123,
    },
  };
}

describe("SessionController lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts injected pid watcher and does not require transcript path in proxy mode", async () => {
    vi.useFakeTimers();
    const backend = new FakeBackend();
    const starts: PidWatcherCallbacks[] = [];
    const { handle } = mockPty();
    const controller = new SessionController({
      ptyHandle: handle,
      pid: 123,
      backend,
      args: defaultArgs,
      onExit: () => {},
      pidWatcherFactory: (_pid, callbacks) => ({
        start: () => { starts.push(callbacks); },
        stop: () => {},
        getSessionId: () => null,
        getTranscriptPath: () => null,
        readTranscriptInit: () => null,
        readTranscriptEvents: () => [],
      }),
    });

    await controller.start();
    await vi.advanceTimersByTimeAsync(1500);

    expect(starts).toHaveLength(1);
    expect(backend.startCalls).toBe(1);
  });

  it("cleans up only once after repeated Claude exits", async () => {
    const backend = new FakeBackend();
    const stops = { pid: 0 };
    const exits: number[] = [];
    const { handle } = mockPty();
    const controller = new SessionController({
      ptyHandle: handle,
      pid: 123,
      backend,
      args: defaultArgs,
      onExit: (code) => { exits.push(code); },
      pidWatcherFactory: () => ({
        start: () => {},
        stop: () => { stops.pid++; },
        getSessionId: () => null,
        getTranscriptPath: () => null,
        readTranscriptInit: () => null,
        readTranscriptEvents: () => [],
      }),
    });

    controller.handleClaudeExit(0);
    controller.handleClaudeExit(0);

    await Promise.resolve();
    expect(stops.pid).toBe(1);
    expect(backend.stopCalls).toBe(1);
    expect(exits).toEqual([0]);
  });

  it("shutdown promise waits for eventual cleanup", async () => {
    const backend = new FakeBackend();
    const exits: number[] = [];
    const { handle, kills } = mockPty();
    const controller = new SessionController({
      ptyHandle: handle,
      pid: 123,
      backend,
      args: defaultArgs,
      onExit: (code) => { exits.push(code); },
      pidWatcherFactory: () => ({
        start: () => {},
        stop: () => {},
        getSessionId: () => null,
        getTranscriptPath: () => null,
        readTranscriptInit: () => null,
        readTranscriptEvents: () => [],
      }),
    });

    let resolved = false;
    const shutdownPromise = controller.shutdown(1).then(() => { resolved = true; });
    await Promise.resolve();

    expect(kills).toEqual(["SIGTERM"]);
    expect(resolved).toBe(false);

    controller.handleClaudeExit(143);
    await shutdownPromise;

    expect(resolved).toBe(true);
    expect(backend.stopCalls).toBe(1);
    expect(exits).toEqual([1]);
  });
});

// ---- Helpers for behavioral tests ----

function mockPtyFull(): PtyHandle & { writes: string[]; kills: string[] } {
  const writes: string[] = [];
  const kills: string[] = [];
  return {
    writes, kills,
    write: (data: string) => writes.push(data),
    resize: () => {},
    kill: (signal?: string) => kills.push(signal || "SIGTERM"),
    pid: 42,
  };
}

function makeFakeBackend(caps?: Partial<BackendCapabilities>): FakeBackend & { emit(obs: Observation): void } {
  const b = new FakeBackend();
  Object.assign(b.capabilities, caps);
  return Object.assign(b, {
    emit(obs: Observation) { if (b.subscriber) b.subscriber(obs); },
  });
}

function makeFakeWatcher() {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    getSessionId: vi.fn(() => "sess-test"),
    getTranscriptPath: vi.fn(() => null as string | null),
    readTranscriptInit: vi.fn(() => null as Record<string, unknown> | null),
    readTranscriptEvents: vi.fn((_subtype: string) => [] as Record<string, unknown>[]),
  };
}

function createTestController(overrides?: {
  args?: Partial<Args>;
  caps?: Partial<BackendCapabilities>;
  transcriptPath?: string | null;
}) {
  const ptyHandle = mockPtyFull();
  const backend = makeFakeBackend(overrides?.caps);
  let statusCb: PidWatcherCallbacks["onStatusChange"] | null = null;
  const watcher = makeFakeWatcher();
  watcher.getTranscriptPath.mockReturnValue(overrides?.transcriptPath ?? null);

  const exitCodes: number[] = [];
  const args: Args = {
    outputFormat: "stream-json",
    inputFormat: "text",
    verbose: true,
    includePartial: true,
    replayUserMessages: false,
    maxTurns: null,
    maxBudgetUsd: null,
    permissionPromptTool: null,
    prompt: "hello",
    readPromptFromStdin: false,
    claudeArgs: [],
    cwd: "/tmp",
    ...overrides?.args,
  };

  const controller = new SessionController({
    ptyHandle,
    pid: 42,
    pidWatcherFactory: (_pid, callbacks) => {
      statusCb = callbacks.onStatusChange;
      return watcher;
    },
    backend,
    args,
    log: () => {},
    onExit: (code) => exitCodes.push(code),
  });

  const fireStatus = (status: string, waitingFor?: string) => {
    statusCb?.(status, waitingFor, { pid: 42, sessionId: "sess-test", cwd: "/tmp", kind: "cli", status, waitingFor });
  };

  return { controller, ptyHandle, backend, watcher, fireStatus, exitCodes };
}

let written: string[] = [];

function parsedLines(): any[] {
  return written.map(w => { try { return JSON.parse(w); } catch { return null; } }).filter(Boolean);
}

// ---- Turn state machine ----

describe("turn state machine", () => {
  beforeEach(() => {
    written = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      written.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
    output.configureOutput({ format: "stream-json", verbose: true, includePartial: true });
    output.resetOutputState();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("busy starts a turn and emits running state", () => {
    const { fireStatus } = createTestController();
    fireStatus("busy");

    const lines = parsedLines();
    const sc = lines.find(l => l.type === "system" && l.subtype === "session_state_changed" && l.state === "running");
    expect(sc).toBeDefined();
  });

  it("idle after busy completes a turn and emits result", () => {
    const { fireStatus } = createTestController();
    fireStatus("busy");
    fireStatus("idle");

    const result = parsedLines().find(l => l.type === "result");
    expect(result).toBeDefined();
    expect(result.subtype).toBe("success");
  });

  it("post_turn_summary emitted before result", () => {
    const { fireStatus } = createTestController();
    fireStatus("busy");
    fireStatus("idle");

    const lines = parsedLines();
    const summaryIdx = lines.findIndex(l => l.type === "system" && l.subtype === "post_turn_summary");
    const resultIdx = lines.findIndex(l => l.type === "result");
    expect(summaryIdx).toBeGreaterThan(-1);
    expect(summaryIdx).toBeLessThan(resultIdx);
  });

  it("first idle without prior busy marks ready (no result)", () => {
    const { fireStatus } = createTestController();
    fireStatus("idle");

    expect(parsedLines().find(l => l.type === "result")).toBeUndefined();
  });

  it("increments turn count across multi-turn", () => {
    const { fireStatus } = createTestController({ args: { inputFormat: "stream-json" } });
    fireStatus("busy");
    fireStatus("idle");
    fireStatus("busy");
    fireStatus("idle");

    const results = parsedLines().filter(l => l.type === "result");
    expect(results).toHaveLength(2);
    expect(results[0].num_turns).toBe(1);
    expect(results[1].num_turns).toBe(2);
  });

  it("re-emits init on turn 2+", () => {
    const { fireStatus } = createTestController({ args: { inputFormat: "stream-json" } });
    fireStatus("busy");
    fireStatus("idle");
    const initsBefore = parsedLines().filter(l => l.type === "system" && l.subtype === "init").length;

    fireStatus("busy");
    const initsAfter = parsedLines().filter(l => l.type === "system" && l.subtype === "init").length;
    expect(initsAfter).toBeGreaterThan(initsBefore);
  });
});

// ---- Max turns ----

describe("max turns enforcement", () => {
  beforeEach(() => {
    written = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      written.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
    output.configureOutput({ format: "stream-json", verbose: true, includePartial: true });
    vi.useFakeTimers();
  });

  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("sends interrupt when turnCount exceeds maxTurns", async () => {
    const { controller, fireStatus, ptyHandle } = createTestController({
      args: { inputFormat: "stream-json", maxTurns: 1 },
    });
    await controller.start();
    fireStatus("busy");
    fireStatus("idle");
    fireStatus("busy");
    await Promise.resolve();
    await Promise.resolve();

    expect(ptyHandle.writes).toContain("\x1b");
  });

  it("does not interrupt within maxTurns", () => {
    const { fireStatus, ptyHandle } = createTestController({ args: { maxTurns: 3 } });
    fireStatus("busy");

    expect(ptyHandle.writes.filter(w => w === "\x1b")).toHaveLength(0);
  });
});

// ---- Single prompt vs multi-turn ----

describe("single prompt mode", () => {
  beforeEach(() => {
    written = [];
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    output.configureOutput({ format: "stream-json", verbose: true, includePartial: true });
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("shuts down after first turn completes", () => {
    const { fireStatus, ptyHandle } = createTestController({ args: { inputFormat: "text" } });
    fireStatus("busy");
    fireStatus("idle");

    expect(ptyHandle.kills.length).toBeGreaterThan(0);
  });
});

describe("multi-turn mode", () => {
  beforeEach(() => {
    written = [];
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    output.configureOutput({ format: "stream-json", verbose: true, includePartial: true });
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("does not shut down after first turn", () => {
    const { fireStatus, ptyHandle } = createTestController({ args: { inputFormat: "stream-json" } });
    fireStatus("busy");
    fireStatus("idle");

    expect(ptyHandle.kills).toHaveLength(0);
  });
});

// ---- Control requests ----

describe("handleControlRequest", () => {
  beforeEach(() => {
    written = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      written.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
    output.configureOutput({ format: "stream-json", verbose: true, includePartial: true });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("startup interrupt is a no-op before any active turn", () => {
    const { controller, ptyHandle } = createTestController();
    controller.handleControlRequest({ subtype: "interrupt" });
    expect(ptyHandle.writes).not.toContain("\x1b");
  });

  it("idle interrupt is a no-op", () => {
    const { controller, fireStatus, ptyHandle } = createTestController();
    fireStatus("idle");
    controller.handleControlRequest({ subtype: "interrupt" });
    expect(ptyHandle.writes).not.toContain("\x1b");
  });

  it("interrupt still sends ESC while a turn is active", async () => {
    const { controller, fireStatus, ptyHandle } = createTestController();
    await controller.start();
    fireStatus("busy");
    controller.handleControlRequest({ subtype: "interrupt" });
    await Promise.resolve();
    await Promise.resolve();
    expect(ptyHandle.writes).toContain("\x1b");
  });

  it("interrupt still sends ESC while Claude is waiting for action", async () => {
    const { controller, fireStatus, ptyHandle } = createTestController();
    await controller.start();
    fireStatus("waiting", "permission");
    controller.handleControlRequest({ subtype: "interrupt" });
    await Promise.resolve();
    await Promise.resolve();
    expect(ptyHandle.writes).toContain("\x1b");
  });

  it("startup stop_task is a no-op before any active turn", () => {
    const { controller, ptyHandle } = createTestController();
    controller.handleControlRequest({ subtype: "stop_task" });
    expect(ptyHandle.writes).not.toContain("\x1b");
  });

  it("idle stop_task is a no-op", () => {
    const { controller, fireStatus, ptyHandle } = createTestController();
    fireStatus("idle");
    controller.handleControlRequest({ subtype: "stop_task" });
    expect(ptyHandle.writes).not.toContain("\x1b");
  });

  it("stop_task still sends ESC while a turn is active", async () => {
    const { controller, fireStatus, ptyHandle } = createTestController();
    await controller.start();
    fireStatus("busy");
    controller.handleControlRequest({ subtype: "stop_task" });
    await Promise.resolve();
    await Promise.resolve();
    expect(ptyHandle.writes).toContain("\x1b");
  });

  it("set_model sends slash command to PTY when ready", async () => {
    const { controller, fireStatus, ptyHandle } = createTestController();
    await controller.start();
    fireStatus("idle");
    controller.handleControlRequest({ subtype: "set_model", model: "claude-sonnet-4-6" });
    await Promise.resolve();
    await Promise.resolve();
    expect(ptyHandle.writes).toContain("/model claude-sonnet-4-6\r");
  });

  it("set_model waits for idle and does not block interrupt", async () => {
    const { controller, fireStatus, ptyHandle } = createTestController({
      args: { inputFormat: "stream-json" },
    });
    await controller.start();

    fireStatus("busy");
    controller.handleControlRequest({ subtype: "set_model", model: "claude-sonnet-4-6" });
    controller.handleControlRequest({ subtype: "interrupt" }, "int-before-model");
    await Promise.resolve();
    await Promise.resolve();

    const escIndex = ptyHandle.writes.findIndex(w => w === "\x1b");
    const slashIndex = ptyHandle.writes.findIndex(w => w === "/model claude-sonnet-4-6\r");
    expect(escIndex).toBeGreaterThan(-1);
    expect(slashIndex).toBe(-1);

    fireStatus("idle");
    await Promise.resolve();
    await Promise.resolve();

    expect(ptyHandle.writes.findIndex(w => w === "/model claude-sonnet-4-6\r")).toBeGreaterThan(escIndex);
  });

  it("set_model does not time out while a turn is still running", async () => {
    vi.useFakeTimers();
    try {
      const { controller, fireStatus, ptyHandle } = createTestController({
        args: { inputFormat: "stream-json" },
      });
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      await controller.start();

      fireStatus("busy");
      controller.handleControlRequest({ subtype: "set_model", model: "claude-sonnet-4-6" });
      await Promise.resolve();
      await Promise.resolve();

      await vi.advanceTimersByTimeAsync(60_000);

      expect(stderr.mock.calls.map(c => String(c[0])).join("")).not.toContain("Timed out after 30s waiting for Claude");
      expect(ptyHandle.kills).toHaveLength(0);
      expect(ptyHandle.writes).not.toContain("/model claude-sonnet-4-6\r");

      fireStatus("idle");
      await Promise.resolve();
      await Promise.resolve();
      expect(ptyHandle.writes).toContain("/model claude-sonnet-4-6\r");
    } finally {
      vi.useRealTimers();
    }
  });

  it("get_context_usage emits control_response on stdout", () => {
    const { controller } = createTestController();
    controller.handleControlRequest({ subtype: "get_context_usage" }, "req-123");

    const resp = parsedLines().find(l => l.type === "control_response");
    expect(resp).toBeDefined();
    expect(resp.request_id).toBe("req-123");
    expect(resp.response.context_usage).toBeDefined();
  });

  it("ignores after process exit", () => {
    const { controller, ptyHandle } = createTestController();
    controller.handleClaudeExit(0);
    controller.handleControlRequest({ subtype: "interrupt" });
    expect(ptyHandle.writes.filter(w => w === "\x1b")).toHaveLength(0);
  });
});

describe("interrupt transaction", () => {
  beforeEach(() => {
    written = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      written.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
    output.configureOutput({ format: "stream-json", verbose: true, includePartial: true });
    output.resetOutputState();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not dispatch a queued prompt until interrupt is acknowledged idle", async () => {
    const { controller, fireStatus, ptyHandle } = createTestController({
      args: { inputFormat: "stream-json" },
    });
    await controller.start();

    fireStatus("busy");
    controller.handleControlRequest({ subtype: "interrupt" });
    controller.enqueuePrompt("next prompt");
    await Promise.resolve();
    await Promise.resolve();

    expect(ptyHandle.writes).toContain("\x1b");
    expect(ptyHandle.writes.join("")).not.toContain("next prompt");

    fireStatus("idle");
    await Promise.resolve();
    await Promise.resolve();

    const interrupted = parsedLines().find(l => l.type === "result");
    expect(interrupted).toMatchObject({
      subtype: "error_during_execution",
      terminal_reason: "aborted_streaming",
      is_error: true,
    });
    expect(ptyHandle.writes.join("")).toContain("next prompt");
  });

  it("emits control_response success when accepting interrupt", async () => {
    const { controller, fireStatus } = createTestController({
      args: { inputFormat: "stream-json" },
    });
    await controller.start();

    fireStatus("busy");
    controller.handleControlRequest({ subtype: "interrupt" }, "int-123");
    await Promise.resolve();
    await Promise.resolve();

    const response = parsedLines().find(l => l.type === "control_response");
    // Native nests request_id inside `response` (control-protocol-misc golden).
    expect(response).toMatchObject({
      response: { subtype: "success", request_id: "int-123" },
    });
  });

  it("accepts interrupt while a prompt is dispatched before busy status", async () => {
    const { controller, fireStatus, ptyHandle } = createTestController({
      args: { inputFormat: "stream-json" },
    });
    await controller.start();

    fireStatus("idle");
    controller.enqueuePrompt("slow prompt");
    await Promise.resolve();
    await Promise.resolve();

    expect(ptyHandle.writes.join("")).toContain("slow prompt");
    controller.handleControlRequest({ subtype: "interrupt" }, "int-dispatch");
    await Promise.resolve();
    await Promise.resolve();

    expect(ptyHandle.writes).not.toContain("\x1b");
    expect(parsedLines().find(l => l.type === "control_response")).toMatchObject({
      response: { subtype: "success", request_id: "int-dispatch" },
    });

    fireStatus("busy");
    expect(ptyHandle.writes).toContain("\x1b");
    fireStatus("idle");

    const result = parsedLines().find(l => l.type === "result");
    expect(result).toMatchObject({
      subtype: "error_during_execution",
      terminal_reason: "aborted_streaming",
    });
  });

  it("queues prompt after dispatch interrupt until ESC is sent and idle acknowledges it", async () => {
    const { controller, fireStatus, ptyHandle } = createTestController({
      args: { inputFormat: "stream-json" },
    });
    await controller.start();

    fireStatus("idle");
    controller.enqueuePrompt("slow prompt");
    await Promise.resolve();
    await Promise.resolve();

    controller.handleControlRequest({ subtype: "interrupt" }, "int-dispatch");
    controller.enqueuePrompt("next prompt");
    await Promise.resolve();
    await Promise.resolve();

    expect(ptyHandle.writes.join("")).not.toContain("next prompt");
    expect(ptyHandle.writes).not.toContain("\x1b");

    fireStatus("busy");
    expect(ptyHandle.writes).toContain("\x1b");
    expect(ptyHandle.writes.join("")).not.toContain("next prompt");

    fireStatus("idle");
    await Promise.resolve();
    await Promise.resolve();

    expect(parsedLines().find(l => l.type === "result")).toMatchObject({
      subtype: "error_during_execution",
      terminal_reason: "aborted_streaming",
    });
    expect(ptyHandle.writes.join("")).toContain("[Request interrupted by user]\n\nnext prompt");
  });

  it("accepts duplicate interrupts while a queued prompt is waiting for first dispatch", async () => {
    const { controller, fireStatus, ptyHandle } = createTestController({
      args: { inputFormat: "stream-json" },
    });
    await controller.start();

    controller.enqueuePrompt("pending prompt");
    controller.handleControlRequest({ subtype: "interrupt" }, "int-one");
    controller.handleControlRequest({ subtype: "interrupt" }, "int-two");
    await Promise.resolve();
    await Promise.resolve();

    const responses = parsedLines().filter(l => l.type === "control_response");
    expect(responses).toHaveLength(2);
    expect(ptyHandle.writes).not.toContain("\x1b");

    fireStatus("idle");
    await Promise.resolve();
    await Promise.resolve();
    expect(ptyHandle.writes.join("")).toContain("pending prompt");

    fireStatus("busy");
    expect(ptyHandle.writes).toContain("\x1b");
  });

  it("prioritizes interrupt over queued prompt backlog", async () => {
    const { controller, fireStatus, ptyHandle } = createTestController({
      args: { inputFormat: "stream-json" },
    });
    await controller.start();

    fireStatus("idle");
    controller.enqueuePrompt("active prompt");
    await Promise.resolve();
    await Promise.resolve();
    fireStatus("busy");

    for (let i = 0; i < 25; i++) {
      controller.enqueuePrompt(`queued prompt ${i}`);
    }
    controller.handleControlRequest({ subtype: "interrupt" }, "int-backlog");
    await Promise.resolve();
    await Promise.resolve();

    const escIndex = ptyHandle.writes.findIndex(w => w === "\x1b");
    expect(escIndex).toBeGreaterThan(-1);
    expect(ptyHandle.writes.slice(0, escIndex).join("")).not.toContain("queued prompt");
  });

  it("cancels interrupt escalation when Claude acknowledges idle", async () => {
    const { controller, fireStatus, ptyHandle } = createTestController({
      args: { inputFormat: "stream-json" },
    });
    await controller.start();

    fireStatus("busy");
    controller.handleControlRequest({ subtype: "interrupt" });
    await Promise.resolve();
    await Promise.resolve();
    fireStatus("idle");
    vi.advanceTimersByTime(5000);

    expect(ptyHandle.writes).toContain("\x1b");
    expect(ptyHandle.writes).not.toContain("\x03");
    expect(ptyHandle.kills).toHaveLength(0);
  });

  it("escalates interrupt when Claude does not acknowledge idle", async () => {
    const { controller, fireStatus, ptyHandle } = createTestController({
      args: { inputFormat: "stream-json" },
    });
    await controller.start();

    fireStatus("busy");
    controller.handleControlRequest({ subtype: "interrupt" });
    await Promise.resolve();
    await Promise.resolve();

    vi.advanceTimersByTime(1000);
    expect(ptyHandle.writes).toContain("\x03");
    expect(ptyHandle.kills).toHaveLength(0);

    vi.advanceTimersByTime(1500);
    expect(ptyHandle.kills).toContain("SIGINT");

    vi.advanceTimersByTime(2000);
    expect(ptyHandle.kills).toContain("SIGTERM");
  });
});

// ---- Permission forwarding ----

describe("permission forwarding", () => {
  beforeEach(() => {
    written = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      written.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
    output.configureOutput({ format: "stream-json", verbose: true, includePartial: true });
    output.resetOutputState();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  function simulateToolUse() {
    const events = [
      { type: "message_start", message: { id: "m1", model: "test", content: [] } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_01", name: "Bash" } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' } },
      { type: "content_block_stop", index: 0 },
      { type: "message_stop" },
    ];
    for (const e of events) output.emitSSE({ data: JSON.stringify(e), parsed: e });
  }

  // Native only forwards can_use_tool when started with
  // --permission-prompt-tool stdio over stream-json input.
  const permissionArgs = { inputFormat: "stream-json" as const, permissionPromptTool: "stdio" };

  it("emits control_request when waiting with tool info", () => {
    const { fireStatus } = createTestController({ args: permissionArgs });
    simulateToolUse();
    fireStatus("waiting", "approve Bash");

    const req = parsedLines().find(l => l.type === "control_request");
    expect(req).toBeDefined();
    expect(req.request.subtype).toBe("can_use_tool");
    expect(req.request.tool_name).toBe("Bash");
    expect(req.request.tool_use_id).toBe("toolu_01");
    expect(req.request.input).toEqual({ command: "ls" });
  });

  it("allow response sends CR to PTY", async () => {
    const { controller, fireStatus, ptyHandle } = createTestController({ args: permissionArgs });
    await controller.start();
    simulateToolUse();
    fireStatus("waiting", "approve Bash");

    const req = parsedLines().find(l => l.type === "control_request");
    controller.handleControlResponse({ behavior: "allow" }, req.request_id);
    await Promise.resolve();
    await Promise.resolve();
    expect(ptyHandle.writes).toContain("\r");
  });

  it("deny response sends ESC to PTY", async () => {
    const { controller, fireStatus, ptyHandle } = createTestController({ args: permissionArgs });
    await controller.start();
    simulateToolUse();
    fireStatus("waiting", "approve Bash");

    const req = parsedLines().find(l => l.type === "control_request");
    controller.handleControlResponse({ behavior: "deny" }, req.request_id);
    await Promise.resolve();
    await Promise.resolve();
    expect(ptyHandle.writes).toContain("\x1b");
  });

  it("mismatched request_id is ignored", () => {
    const { controller, ptyHandle } = createTestController({ args: permissionArgs });
    controller.handleControlResponse({ behavior: "allow" }, "wrong-id");
    expect(ptyHandle.writes.filter(w => w === "\r")).toHaveLength(0);
  });

  it("clears pending permission on idle", () => {
    const { controller, fireStatus, ptyHandle } = createTestController({ args: permissionArgs });
    simulateToolUse();
    fireStatus("waiting", "approve Bash");
    const req = parsedLines().find(l => l.type === "control_request");

    fireStatus("idle");
    controller.handleControlResponse({ behavior: "allow" }, req.request_id);
    expect(ptyHandle.writes.filter(w => w === "\r")).toHaveLength(0);
  });

  it("allow with identical updatedInput sends CR", async () => {
    const { controller, fireStatus, ptyHandle } = createTestController({ args: permissionArgs });
    await controller.start();
    simulateToolUse();
    fireStatus("waiting", "approve Bash");

    const req = parsedLines().find(l => l.type === "control_request");
    controller.handleControlResponse(
      { behavior: "allow", updatedInput: { command: "ls" } },
      req.request_id,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(ptyHandle.writes).toContain("\r");
  });

  it("allow with modified updatedInput is denied, not approved", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { controller, fireStatus, ptyHandle } = createTestController({ args: permissionArgs });
    await controller.start();
    simulateToolUse();
    fireStatus("waiting", "approve Bash");

    const req = parsedLines().find(l => l.type === "control_request");
    // The TUI dialog can only approve the input it is showing; a rewritten
    // command must not be executed as if the original were authorized.
    controller.handleControlResponse(
      { behavior: "allow", updatedInput: { command: "rm -rf /" } },
      req.request_id,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(ptyHandle.writes).not.toContain("\r");
    expect(ptyHandle.writes).toContain("\x1b");
  });

  it("auto-denies instead of emitting control_request when the flag is absent", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { controller, fireStatus, ptyHandle } = createTestController({
      args: { inputFormat: "stream-json" },
    });
    await controller.start();
    simulateToolUse();
    fireStatus("waiting", "approve Bash");
    await Promise.resolve();
    await Promise.resolve();

    expect(parsedLines().find(l => l.type === "control_request")).toBeUndefined();
    expect(ptyHandle.writes).toContain("\x1b");
  });

  it("auto-denies a pending permission on stdin EOF instead of hanging", async () => {
    const { controller, fireStatus, ptyHandle, exitCodes } = createTestController({ args: permissionArgs });
    await controller.start();
    simulateToolUse();
    fireStatus("waiting", "approve Bash");
    expect(parsedLines().find(l => l.type === "control_request")).toBeDefined();

    controller.handleStdinEof();
    await Promise.resolve();
    await Promise.resolve();
    expect(ptyHandle.writes).toContain("\x1b");

    fireStatus("idle");
    expect(ptyHandle.kills).toContain("SIGTERM");
    controller.handleClaudeExit(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(exitCodes).toContain(0);
  });

  it("auto-denies instead of emitting control_request after stdin closed", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { controller, fireStatus, ptyHandle } = createTestController({ args: permissionArgs });
    await controller.start();
    // An active turn keeps the session alive past EOF; the permission prompt
    // then arrives with nobody left to answer it.
    fireStatus("busy");
    controller.handleStdinEof();
    simulateToolUse();
    fireStatus("waiting", "approve Bash");
    await Promise.resolve();
    await Promise.resolve();

    expect(parsedLines().find(l => l.type === "control_request")).toBeUndefined();
    expect(ptyHandle.writes).toContain("\x1b");
  });

  it("auto-denies instead of leaving an invisible request when output is not stream-json", async () => {
    // stdio permission tool over stream-json input, but text output — the
    // control_request has no channel to reach the client, so it must not be
    // set pending (which would wedge); deny-by-default completes the turn.
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { controller, fireStatus, ptyHandle } = createTestController({
      args: { ...permissionArgs, outputFormat: "text" },
    });
    await controller.start();
    simulateToolUse();
    fireStatus("waiting", "approve Bash");
    await Promise.resolve();
    await Promise.resolve();

    expect(parsedLines().find(l => l.type === "control_request")).toBeUndefined();
    expect(ptyHandle.writes).toContain("\x1b");
  });

  it("does not drop the permission request when waiting precedes tool assembly", () => {
    vi.useFakeTimers();
    try {
      const { fireStatus } = createTestController({ args: permissionArgs });
      // `waiting` is observed before the tool_use finished assembling over SSE.
      fireStatus("waiting", "approve Bash");
      expect(parsedLines().find(l => l.type === "control_request")).toBeUndefined();

      // The tool finishes assembling; the retry window must resolve it rather
      // than leaving the dialog unanswered until stdin EOF.
      simulateToolUse();
      vi.advanceTimersByTime(25);

      const req = parsedLines().find(l => l.type === "control_request");
      expect(req).toBeDefined();
      expect(req.request.tool_use_id).toBe("toolu_01");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not approve a stale tool against a newly focused dialog", () => {
    vi.useFakeTimers();
    try {
      const { controller, fireStatus } = createTestController({ args: permissionArgs });
      simulateToolUse();
      fireStatus("waiting", "approve Bash");
      const first = parsedLines().filter(l => l.type === "control_request");
      expect(first).toHaveLength(1);
      expect(first[0].request.tool_use_id).toBe("toolu_01");

      // Client answers the first dialog, clearing the pending request.
      controller.handleControlResponse({ behavior: "allow" }, first[0].request_id);

      // A second dialog opens, but getLastToolUse() still returns toolu_01
      // (the second tool_use hasn't assembled yet). It must NOT be re-approved
      // as if it were the new request.
      fireStatus("waiting", "approve Edit");
      expect(parsedLines().filter(l => l.type === "control_request")).toHaveLength(1);

      // The real second tool assembles; only now does a new request go out.
      const secondTool = [
        { type: "message_start", message: { id: "m2", model: "test", content: [] } },
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_02", name: "Edit" } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"file_path":"/tmp/x"}' } },
        { type: "content_block_stop", index: 0 },
        { type: "message_stop" },
      ];
      for (const e of secondTool) output.emitSSE({ data: JSON.stringify(e), parsed: e });
      vi.advanceTimersByTime(25);

      const all = parsedLines().filter(l => l.type === "control_request");
      expect(all).toHaveLength(2);
      expect(all[1].request.tool_use_id).toBe("toolu_02");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---- Observation routing ----

describe("handleObservation", () => {
  beforeEach(() => {
    written = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      written.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
    output.configureOutput({ format: "stream-json", verbose: true, includePartial: true });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("routes SSE to output.emitSSE", () => {
    const { controller } = createTestController();
    const spy = vi.spyOn(output, "emitSSE");
    const event = { data: '{"type":"ping"}', parsed: { type: "ping" } };
    controller.handleObservation({ kind: "sse", event });
    expect(spy).toHaveBeenCalledWith(event);
  });

  it("routes transcript_line to output.emitTranscriptEvent", () => {
    const { controller } = createTestController();
    const spy = vi.spyOn(output, "emitTranscriptEvent");
    controller.handleObservation({ kind: "transcript_line", line: { type: "system" } });
    expect(spy).toHaveBeenCalled();
  });

  it("reshapes transcript tool_result user lines into native user events", () => {
    const { controller } = createTestController();
    controller.handleObservation({
      kind: "transcript_line",
      line: {
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "ok", is_error: false }] },
        uuid: "uuid-tr-1",
        timestamp: "2026-06-09T00:00:00.000Z",
        sessionId: "sess-tr",
        toolUseResult: { stdout: "ok", stderr: "", interrupted: false },
        parentUuid: "uuid-parent",
        isSidechain: false,
      },
    });

    const user = parsedLines().find(l => l.type === "user");
    expect(user).toBeDefined();
    expect(user.message.content[0].type).toBe("tool_result");
    expect(user.tool_use_result).toEqual({ stdout: "ok", stderr: "", interrupted: false });
    expect(user.uuid).toBe("uuid-tr-1");
    expect(user.timestamp).toBe("2026-06-09T00:00:00.000Z");
    expect(user.session_id).toBe("sess-tr");
    expect(user.parent_tool_use_id).toBeNull();
    // transcript-internal fields must not leak through
    expect(user.toolUseResult).toBeUndefined();
    expect(user.parentUuid).toBeUndefined();
    expect(user.isSidechain).toBeUndefined();
  });

  it("does not reshape sidechain tool_result lines into user events", () => {
    const { controller } = createTestController();
    const spy = vi.spyOn(output, "emitTranscriptEvent");
    controller.handleObservation({
      kind: "transcript_line",
      line: {
        type: "user",
        isSidechain: true,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "x" }] },
      },
    });
    // sidechain lines fall through to verbatim forwarding, not user reshaping
    expect(spy).toHaveBeenCalled();
    expect(parsedLines().find(l => l.type === "user" && l.tool_use_result)).toBeUndefined();
  });

  it("turns synthetic transcript API errors into error results", () => {
    const { controller, fireStatus, ptyHandle } = createTestController();
    fireStatus("busy");

    controller.handleObservation({
      kind: "transcript_line",
      line: {
        type: "assistant",
        isApiErrorMessage: true,
        apiErrorStatus: 404,
        message: {
          content: [{ type: "text", text: "There's an issue with the selected model." }],
        },
      },
    });

    const result = parsedLines().find(l => l.type === "result");
    // Native parity (invalid-model golden): subtype "success" with
    // is_error: true, not subtype "error".
    expect(result).toMatchObject({
      subtype: "success",
      is_error: true,
      api_error_status: 404,
      stop_reason: "api_error",
      result: "There's an issue with the selected model.",
    });
    expect(ptyHandle.kills).toContain("SIGTERM");
  });

  it("lets a transcript API error beat an empty idle completion race", async () => {
    vi.useFakeTimers();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clarp-session-"));
    const transcriptPath = path.join(tmpDir, "session.jsonl");
    fs.writeFileSync(transcriptPath, "");
    try {
      const { fireStatus, ptyHandle } = createTestController({ transcriptPath });
      fireStatus("busy");
      fireStatus("idle");

      fs.appendFileSync(transcriptPath, JSON.stringify({
        type: "assistant",
        isApiErrorMessage: true,
        apiErrorStatus: 404,
        timestamp: new Date().toISOString(),
        message: {
          content: [{ type: "text", text: "There's an issue with the selected model." }],
        },
      }) + "\n");
      await vi.advanceTimersByTimeAsync(1000);

      const results = parsedLines().filter(l => l.type === "result");
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        subtype: "success",
        is_error: true,
        result: "There's an issue with the selected model.",
      });
      expect(ptyHandle.kills).toContain("SIGTERM");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it("turns exhausted transcript API retries into error results", () => {
    const { controller, fireStatus, ptyHandle } = createTestController();
    fireStatus("busy");

    controller.handleObservation({
      kind: "transcript_line",
      line: {
        type: "system",
        subtype: "api_error",
        retryAttempt: 10,
        maxRetries: 10,
        error: {
          status: 529,
          error: { error: { type: "overloaded_error", message: "Overloaded" } },
        },
      },
    });

    const result = parsedLines().find(l => l.type === "result");
    expect(result).toMatchObject({
      subtype: "success",
      is_error: true,
      api_error_status: 529,
      result: "API Error: 529 Overloaded.",
    });
    expect(ptyHandle.kills).toContain("SIGTERM");
  });

  it("prints transcript retry status in text output mode", () => {
    const stderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
      stderr.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
    output.configureOutput({ format: "text", verbose: false, includePartial: false });
    const { controller } = createTestController({ args: { outputFormat: "text" } });

    controller.handleObservation({
      kind: "transcript_line",
      line: {
        type: "system",
        subtype: "api_error",
        retryAttempt: 1,
        maxRetries: 10,
        retryInMs: 1200,
        error: {
          status: 529,
          error: { error: { type: "overloaded_error", message: "Overloaded" } },
        },
      },
    });

    expect(stderr.join("")).toContain("API Error: 529 Overloaded. retrying in 1s, attempt 1/10.");
  });

  it("routes rate_limit to output.emitRateLimitEvent", () => {
    const { controller } = createTestController();
    const spy = vi.spyOn(output, "emitRateLimitEvent");
    controller.handleObservation({ kind: "rate_limit", statusCode: 429, retryAfter: "5" });
    expect(spy).toHaveBeenCalledWith({ statusCode: 429, retryAfter: "5" });
  });

  it("routes api_retry to output.emitApiRetry", () => {
    const { controller } = createTestController();
    const spy = vi.spyOn(output, "emitApiRetry");
    controller.handleObservation({ kind: "api_retry", statusCode: 529 });
    expect(spy).toHaveBeenCalledWith(529);
  });

  it("ignores observations after process exit", () => {
    const { controller } = createTestController();
    const spy = vi.spyOn(output, "emitSSE");
    controller.handleClaudeExit(0);
    controller.handleObservation({ kind: "sse", event: { data: "x", parsed: {} } });
    expect(spy).not.toHaveBeenCalled();
  });
});

// ---- Claude exit ----

describe("handleClaudeExit", () => {
  beforeEach(() => {
    written = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      written.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
    output.configureOutput({ format: "stream-json", verbose: true, includePartial: true });
    output.resetOutputState();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("emits success result on code 0 during active turn", () => {
    const { controller, fireStatus } = createTestController();
    fireStatus("busy");
    controller.handleClaudeExit(0);

    const result = parsedLines().find(l => l.type === "result");
    expect(result).toBeDefined();
    expect(result.subtype).toBe("success");
  });

  it("emits error result on non-zero code during active turn", () => {
    const { controller, fireStatus } = createTestController();
    fireStatus("busy");
    controller.handleClaudeExit(1);

    const result = parsedLines().find(l => l.type === "result");
    expect(result.subtype).toBe("error");
    expect(result.result).toContain("code 1");
  });

  it("skips result when backend emitsResults", () => {
    const { controller, fireStatus } = createTestController({ caps: { emitsResults: true } });
    fireStatus("busy");
    controller.handleClaudeExit(0);

    expect(parsedLines().find(l => l.type === "result")).toBeUndefined();
  });

  it("triggers onExit callback", async () => {
    const { controller, exitCodes } = createTestController();
    controller.handleClaudeExit(0);
    await Promise.resolve();
    expect(exitCodes).toEqual([0]);
  });
});

// ---- Stdin EOF ----

describe("handleStdinEof", () => {
  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    output.configureOutput({ format: "stream-json", verbose: true, includePartial: true });
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("shuts down when idle and queue empty", () => {
    const { controller, ptyHandle } = createTestController({ args: { inputFormat: "stream-json" } });
    controller.handleStdinEof();
    vi.advanceTimersByTime(100);
    expect(ptyHandle.kills.length).toBeGreaterThan(0);
  });

  it("does not shut down when turn is active", () => {
    const { controller, fireStatus, ptyHandle } = createTestController({ args: { inputFormat: "stream-json" } });
    fireStatus("busy");
    controller.handleStdinEof();
    vi.advanceTimersByTime(100);
    expect(ptyHandle.kills).toHaveLength(0);
  });

  it("does not shut down while a prompt is dispatched but not busy yet", async () => {
    const { controller, fireStatus, ptyHandle } = createTestController({ args: { inputFormat: "stream-json" } });
    await controller.start();

    fireStatus("idle");
    controller.enqueuePrompt("pending busy");
    await Promise.resolve();
    await Promise.resolve();

    controller.handleStdinEof();
    vi.advanceTimersByTime(100);

    expect(ptyHandle.writes.join("")).toContain("pending busy");
    expect(ptyHandle.kills).toHaveLength(0);
  });

  it("shuts down after active turn completes when stdin is closed", () => {
    const { controller, fireStatus, ptyHandle } = createTestController({ args: { inputFormat: "stream-json" } });
    fireStatus("busy");
    controller.handleStdinEof();
    fireStatus("idle");
    vi.advanceTimersByTime(100);
    expect(ptyHandle.kills.length).toBeGreaterThan(0);
  });

  it("exits 1 when stdin closes after a control-request interrupted-only turn", async () => {
    const { controller, fireStatus, exitCodes } = createTestController({ args: { inputFormat: "stream-json" } });
    await controller.start();

    fireStatus("busy");
    controller.handleControlRequest({ subtype: "interrupt" });
    await Promise.resolve();
    await Promise.resolve();
    controller.handleStdinEof();
    fireStatus("idle");
    controller.handleClaudeExit(0);
    await Promise.resolve();

    expect(exitCodes).toEqual([1]);
  });

  it("exits 0 when stdin closes after a SIGINT interrupted-only turn", async () => {
    const { controller, fireStatus, exitCodes } = createTestController({ args: { inputFormat: "stream-json" } });
    await controller.start();

    fireStatus("busy");
    controller.interrupt();
    await Promise.resolve();
    await Promise.resolve();
    controller.handleStdinEof();
    fireStatus("idle");
    controller.handleClaudeExit(0);
    await Promise.resolve();

    expect(exitCodes).toEqual([0]);
  });

  it("does not drop queued prompts while waiting for the previous turn to finish", async () => {
    const { controller, fireStatus, ptyHandle } = createTestController({ args: { inputFormat: "stream-json" } });
    await controller.start();
    controller.enqueuePrompt("one");
    controller.enqueuePrompt("two");
    controller.handleStdinEof();

    fireStatus("idle");
    await Promise.resolve();
    await Promise.resolve();
    expect(ptyHandle.writes.join("")).toContain("one");

    fireStatus("busy");
    fireStatus("idle");
    await Promise.resolve();
    await Promise.resolve();
    expect(ptyHandle.writes.join("")).toContain("two");
  });

  it("does not time out queued prompts while a turn is still running", async () => {
    const { controller, fireStatus, ptyHandle } = createTestController({ args: { inputFormat: "stream-json" } });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await controller.start();

    fireStatus("busy");
    controller.enqueuePrompt("queued behind long turn");
    controller.handleStdinEof();
    await Promise.resolve();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(stderr.mock.calls.map(c => String(c[0])).join("")).not.toContain("Timed out after 30s waiting for Claude");
    expect(ptyHandle.kills).toHaveLength(0);

    fireStatus("idle");
    await Promise.resolve();
    await Promise.resolve();
    expect(ptyHandle.writes.join("")).toContain("queued behind long turn");
  });

  it("does not shut down when queue has items", () => {
    const { controller, ptyHandle } = createTestController({ args: { inputFormat: "stream-json" } });
    controller.enqueuePrompt("pending");
    controller.handleStdinEof();
    vi.advanceTimersByTime(100);
    expect(ptyHandle.kills).toHaveLength(0);
  });

  it("times out via the startup watchdog when Claude is never observed", async () => {
    // No status is ever observed (the Windows pid-mismatch / unobservable-session
    // case), so the generous startup watchdog (120s) applies — not the 30s
    // in-turn timeout — and it fails fast instead of hanging forever.
    const { controller, ptyHandle, exitCodes } = createTestController({ args: { inputFormat: "stream-json" } });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await controller.start();

    controller.enqueuePrompt("pending");
    controller.handleStdinEof();
    await Promise.resolve();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(30_000);
    // Still within the startup window — must not have fired yet.
    expect(ptyHandle.kills).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(90_000);
    expect(stderr.mock.calls.map(c => String(c[0])).join("")).toContain("Timed out after 120s waiting for Claude");
    expect(ptyHandle.kills).toContain("SIGTERM");

    controller.handleClaudeExit(143);
    await Promise.resolve();
    expect(exitCodes).toEqual([1]);
  });

  it("emits a terminal error result on startup timeout so stream-json has a terminator", async () => {
    const lines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      lines.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { controller } = createTestController({ args: { inputFormat: "stream-json" } });
    await controller.start();
    controller.enqueuePrompt("pending");
    controller.handleStdinEof();
    await Promise.resolve();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(120_000);

    const results = lines
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .filter((e: any) => e.type === "result");
    expect(results).toHaveLength(1);
    expect(results[0].subtype).toBe("error");
    expect(results[0].is_error).toBe(true);

    // The terminal exit must not emit a second result.
    controller.handleClaudeExit(143);
    await Promise.resolve();
    expect(lines.map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter((e: any) => e?.type === "result")).toHaveLength(1);
  });

  it("times out instead of hanging when queued prompt waits on unresolved permission", async () => {
    const { controller, fireStatus, ptyHandle, exitCodes } = createTestController({ args: { inputFormat: "stream-json" } });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await controller.start();

    fireStatus("busy");
    fireStatus("waiting", "approve Bash");
    controller.enqueuePrompt("queued behind permission");
    controller.handleStdinEof();
    await Promise.resolve();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(stderr.mock.calls.map(c => String(c[0])).join("")).toContain("Timed out after 30s waiting for Claude");
    expect(ptyHandle.kills).toContain("SIGTERM");
    expect(ptyHandle.writes.join("")).not.toContain("queued behind permission");

    controller.handleClaudeExit(143);
    await Promise.resolve();
    expect(exitCodes).toEqual([1]);
  });
});

// ---- Interrupt (SIGINT) ----

describe("interrupt", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("sends ESC to PTY", () => {
    const { controller, ptyHandle } = createTestController();
    controller.interrupt();
    expect(ptyHandle.writes).toContain("\x1b");
  });

  it("routes SIGINT through dispatch interrupt when a prompt is being accepted", async () => {
    const { controller, fireStatus, ptyHandle } = createTestController({
      args: { inputFormat: "stream-json" },
    });
    await controller.start();

    fireStatus("idle");
    controller.enqueuePrompt("slow prompt");
    await Promise.resolve();
    await Promise.resolve();

    controller.interrupt();
    await Promise.resolve();
    await Promise.resolve();

    expect(ptyHandle.writes).not.toContain("\x1b");
    fireStatus("busy");
    expect(ptyHandle.writes).toContain("\x1b");
  });

  it("escalates to SIGTERM after 2s", () => {
    const { controller, ptyHandle } = createTestController();
    controller.interrupt();
    expect(ptyHandle.kills).toHaveLength(0);
    vi.advanceTimersByTime(2000);
    expect(ptyHandle.kills).toContain("SIGTERM");
  });

  it("does not escalate if process already exited", () => {
    const { controller, ptyHandle } = createTestController();
    controller.handleClaudeExit(0);
    controller.interrupt();
    vi.advanceTimersByTime(2000);
    expect(ptyHandle.kills).toHaveLength(0);
  });
});

// ---- Shutdown ----

describe("shutdown", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("kills PTY with SIGTERM", () => {
    const { controller, ptyHandle } = createTestController();
    void controller.shutdown(0);
    expect(ptyHandle.kills).toContain("SIGTERM");
  });

  it("force exits after 3s if PTY doesn't die", async () => {
    const { controller, exitCodes } = createTestController();
    void controller.shutdown(0);
    vi.advanceTimersByTime(3100);
    await vi.advanceTimersByTimeAsync(0);
    expect(exitCodes).toEqual([0]);
  });

  it("is idempotent", () => {
    const { controller, ptyHandle } = createTestController();
    void controller.shutdown(0);
    void controller.shutdown(0);
    expect(ptyHandle.kills.filter(s => s === "SIGTERM")).toHaveLength(1);
  });
});

// ---- Backend capabilities ----

describe("backend capabilities", () => {
  beforeEach(() => {
    written = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      written.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
    output.configureOutput({ format: "stream-json", verbose: true, includePartial: true });
    output.resetOutputState();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("skips result synthesis when emitsResults=true", () => {
    const { fireStatus } = createTestController({ caps: { emitsResults: true } });
    fireStatus("busy");
    fireStatus("idle");
    expect(parsedLines().find(l => l.type === "result")).toBeUndefined();
  });

  it("skips post_turn_summary when emitsPostTurnSummary=true", () => {
    const { fireStatus } = createTestController({ caps: { emitsPostTurnSummary: true } });
    fireStatus("busy");
    fireStatus("idle");
    expect(parsedLines().find(l => l.type === "system" && l.subtype === "post_turn_summary")).toBeUndefined();
  });

  it("synthesizes both when capabilities are false (proxy mode)", () => {
    const { fireStatus } = createTestController({ caps: { emitsResults: false, emitsPostTurnSummary: false } });
    fireStatus("busy");
    fireStatus("idle");
    const lines = parsedLines();
    expect(lines.find(l => l.type === "result")).toBeDefined();
    expect(lines.find(l => l.type === "system" && l.subtype === "post_turn_summary")).toBeDefined();
  });

  it("uses transcript summary when available", () => {
    const { fireStatus, watcher } = createTestController();
    watcher.readTranscriptEvents.mockReturnValue([
      { type: "system", subtype: "post_turn_summary", title: "From transcript", status_category: "completed" },
    ]);
    fireStatus("busy");
    fireStatus("idle");

    const summary = parsedLines().find(l => l.type === "system" && l.subtype === "post_turn_summary");
    expect(summary).toBeDefined();
    expect(summary.title).toBe("From transcript");
  });
});

// ---- Prompt dispatch deadline ----

// A prompt typed into the pty can be silently eaten when Claude's status file
// reports idle a beat before the TUI input box accepts keystrokes. Busy then
// never arrives, and the readiness watchdog is suppressed while a dispatch is
// in flight — previously an unbounded silent wedge (seen live in the parity
// replay). The deadline re-sends once, then fails with a terminal result.
describe("prompt dispatch deadline", () => {
  beforeEach(() => {
    written = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      written.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    output.configureOutput({ format: "stream-json", verbose: true, includePartial: true });
    output.resetOutputState();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  const PROMPT = "DISPATCH_DEADLINE_PROBE";

  function sends(ptyHandle: { writes: string[] }): number {
    return ptyHandle.writes.join("").split(PROMPT).length - 1;
  }

  async function dispatchProbe() {
    const ctx = createTestController({ args: { inputFormat: "stream-json" } });
    await ctx.controller.start();
    ctx.fireStatus("idle");
    ctx.controller.enqueuePrompt(PROMPT);
    await vi.advanceTimersByTimeAsync(0);
    expect(sends(ctx.ptyHandle)).toBe(1);
    return ctx;
  }

  it("re-sends the prompt once when no turn starts within the deadline", async () => {
    const { fireStatus, ptyHandle } = await dispatchProbe();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(sends(ptyHandle)).toBe(2);

    // The retry takes: turn starts, no error result, no third send.
    fireStatus("busy");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sends(ptyHandle)).toBe(2);
    expect(parsedLines().filter(l => l.type === "result")).toHaveLength(0);
    expect(ptyHandle.kills).toHaveLength(0);
  });

  it("fails with a terminal error result when the retry also produces no turn", async () => {
    const { controller, ptyHandle, exitCodes } = await dispatchProbe();

    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);

    const results = parsedLines().filter(l => l.type === "result");
    expect(results).toHaveLength(1);
    expect(results[0].subtype).toBe("error");
    expect(ptyHandle.kills).toContain("SIGTERM");

    controller.handleClaudeExit(143);
    await vi.advanceTimersByTimeAsync(0);
    expect(exitCodes).toEqual([1]);
    // No duplicate result from the exit path.
    expect(parsedLines().filter(l => l.type === "result")).toHaveLength(1);
  });

  it("does not re-send when the turn starts promptly", async () => {
    const { fireStatus, ptyHandle } = await dispatchProbe();

    fireStatus("busy");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sends(ptyHandle)).toBe(1);
    expect(parsedLines().filter(l => l.type === "result")).toHaveLength(0);
  });

  it("stands down when the prompt produces a permission dialog instead of a turn", async () => {
    const { fireStatus, ptyHandle } = await dispatchProbe();

    // The prompt reached Claude — it opened a dialog. The permission machinery
    // owns the session now; re-typing the prompt would corrupt the dialog.
    fireStatus("waiting", "approve Bash");
    await vi.advanceTimersByTimeAsync(25_000);
    expect(sends(ptyHandle)).toBe(1);
  });
});

// ---- Tier-2 parity: max-turns, control acks ----

describe("native parity shapes", () => {
  beforeEach(() => {
    written = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      written.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    output.configureOutput({ format: "stream-json", verbose: true, includePartial: true });
    output.resetOutputState();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("ends the session with result.error_max_turns and exit 1 when --max-turns is exhausted", async () => {
    const { controller, fireStatus, exitCodes } = createTestController({
      args: { inputFormat: "stream-json", maxTurns: 1 },
    });
    await controller.start();

    // Turn 1 completes normally.
    fireStatus("busy");
    fireStatus("idle");
    // Turn 2 exceeds the limit: clarp interrupts it, then must report
    // error_max_turns (native: is_error, NO result field, exit code 1).
    fireStatus("busy");
    await Promise.resolve();
    await Promise.resolve();
    fireStatus("idle");
    await Promise.resolve();
    await Promise.resolve();

    const results = parsedLines().filter(l => l.type === "result");
    const maxTurns = results.find(r => r.subtype === "error_max_turns");
    expect(maxTurns).toBeDefined();
    expect(maxTurns.is_error).toBe(true);
    expect("result" in maxTurns).toBe(false);

    controller.handleClaudeExit(143);
    await Promise.resolve();
    expect(exitCodes).toEqual([1]);
  });

  it("acks initialize with the native nested control_response shape", () => {
    const { controller } = createTestController({ args: { inputFormat: "stream-json" } });
    controller.handleControlRequest({ subtype: "initialize" }, "init-1");

    const ack = parsedLines().find(l => l.type === "control_response");
    expect(ack).toBeDefined();
    expect(ack.response.subtype).toBe("success");
    expect(ack.response.request_id).toBe("init-1");
    expect(Array.isArray(ack.response.response.commands)).toBe(true);
    expect(typeof ack.response.response.pid).toBe("number");
  });

  it("acks set_permission_mode echoing the mode like native", () => {
    const { controller } = createTestController({ args: { inputFormat: "stream-json" } });
    controller.handleControlRequest({ subtype: "set_permission_mode", mode: "acceptEdits" }, "perm-1");

    const ack = parsedLines().find(l => l.type === "control_response");
    expect(ack).toMatchObject({
      response: { subtype: "success", request_id: "perm-1", response: { mode: "acceptEdits" } },
    });
  });

  it("counts assistant API rounds (not prompts) toward --max-turns like native", async () => {
    // Native's --max-turns unit is assistant API rounds inside the agentic
    // loop: one prompt that chains tool calls can exhaust it (golden:
    // 1 user prompt, num_turns=2). clarp observes rounds as SSE message_start.
    const { controller, fireStatus, backend, exitCodes } = createTestController({
      args: { inputFormat: "stream-json", maxTurns: 1 },
    });
    await controller.start();

    fireStatus("busy");
    const round = (id: string) => backend.emit({
      kind: "sse",
      event: { data: "{}", parsed: { type: "message_start", message: { id, model: "m", content: [] } } },
    });
    round("msg_1");
    await Promise.resolve();
    expect(parsedLines().filter(l => l.type === "result")).toHaveLength(0);

    // Second round inside the same prompt-turn exceeds the limit.
    round("msg_2");
    await Promise.resolve();
    await Promise.resolve();
    fireStatus("idle");
    await Promise.resolve();
    await Promise.resolve();

    const results = parsedLines().filter(l => l.type === "result");
    expect(results).toHaveLength(1);
    expect(results[0].subtype).toBe("error_max_turns");
    expect(results[0].is_error).toBe(true);
    expect(results[0].num_turns).toBe(2);
    expect("result" in results[0]).toBe(false);

    controller.handleClaudeExit(143);
    await Promise.resolve();
    expect(exitCodes).toEqual([1]);
  });

  it("exits 1 after an is_error result even when the session ends by stdin drain", async () => {
    const { controller, fireStatus, exitCodes } = createTestController({
      args: { inputFormat: "stream-json" },
    });
    await controller.start();
    fireStatus("busy");
    // Turn fails with a backend API error (invalid-model family).
    controller.handleObservation({
      kind: "transcript_line",
      line: {
        type: "assistant",
        isApiErrorMessage: true,
        apiErrorStatus: 404,
        message: { content: [{ type: "text", text: "model problem" }] },
      },
    });
    controller.handleStdinEof();
    await Promise.resolve();
    await Promise.resolve();

    controller.handleClaudeExit(143);
    await Promise.resolve();
    expect(exitCodes).toEqual([1]);
  });
});
