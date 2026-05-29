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
    expect(response).toMatchObject({
      request_id: "int-123",
      response: { subtype: "success" },
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
      request_id: "int-dispatch",
      response: { subtype: "success" },
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

  it("emits control_request when waiting with tool info", () => {
    const { fireStatus } = createTestController();
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
    const { controller, fireStatus, ptyHandle } = createTestController();
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
    const { controller, fireStatus, ptyHandle } = createTestController();
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
    const { controller, ptyHandle } = createTestController();
    controller.handleControlResponse({ behavior: "allow" }, "wrong-id");
    expect(ptyHandle.writes.filter(w => w === "\r")).toHaveLength(0);
  });

  it("clears pending permission on idle", () => {
    const { controller, fireStatus, ptyHandle } = createTestController();
    simulateToolUse();
    fireStatus("waiting", "approve Bash");
    const req = parsedLines().find(l => l.type === "control_request");

    fireStatus("idle");
    controller.handleControlResponse({ behavior: "allow" }, req.request_id);
    expect(ptyHandle.writes.filter(w => w === "\r")).toHaveLength(0);
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
    expect(result).toMatchObject({
      subtype: "error",
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
        subtype: "error",
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
      subtype: "error",
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

  it("does not shut down when queue has items", () => {
    const { controller, ptyHandle } = createTestController({ args: { inputFormat: "stream-json" } });
    controller.enqueuePrompt("pending");
    controller.handleStdinEof();
    vi.advanceTimersByTime(100);
    expect(ptyHandle.kills).toHaveLength(0);
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
