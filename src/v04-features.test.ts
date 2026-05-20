/**
 * v0.4 feature tests — JSONL transcript init, SSE usage accumulation, set_model, stop_task, transcript post_turn_summary.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { MessageAssembler, type AssembledMessage, type ContextUsage } from "./message-assembler.js";
import { PidWatcher } from "./pid-watcher.js";
import * as output from "./output.js";
import type { SSEEvent } from "./proxy.js";

function sse(parsed: unknown): SSEEvent {
  return { data: JSON.stringify(parsed), parsed };
}

// ---- 1. SSE usage accumulation ----

describe("context usage accumulation", () => {
  it("tracks input_tokens from message_start", () => {
    const msgs: AssembledMessage[] = [];
    const assembler = new MessageAssembler((msg) => msgs.push(msg));

    assembler.processSSE(sse({
      type: "message_start",
      message: { id: "m1", model: "test", content: [], usage: { input_tokens: 5000, output_tokens: 0, cache_read_input_tokens: 2000, cache_creation_input_tokens: 1000 } },
    }));

    const usage = assembler.getContextUsage();
    expect(usage.input_tokens).toBe(5000);
    expect(usage.cache_read_input_tokens).toBe(2000);
    expect(usage.cache_creation_input_tokens).toBe(1000);
  });

  it("tracks output_tokens from message_delta", () => {
    const msgs: AssembledMessage[] = [];
    const assembler = new MessageAssembler((msg) => msgs.push(msg));

    assembler.processSSE(sse({
      type: "message_start",
      message: { id: "m1", model: "test", content: [], usage: { input_tokens: 100 } },
    }));
    assembler.processSSE(sse({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 50 },
    }));

    const usage = assembler.getContextUsage();
    expect(usage.output_tokens).toBe(50);
  });

  it("updates on resumed session (latest message_start has full context)", () => {
    const msgs: AssembledMessage[] = [];
    const assembler = new MessageAssembler((msg) => msgs.push(msg));

    // First turn
    assembler.processSSE(sse({
      type: "message_start",
      message: { id: "m1", model: "test", content: [], usage: { input_tokens: 1000 } },
    }));
    assembler.processSSE(sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
    assembler.processSSE(sse({ type: "content_block_stop", index: 0 }));
    assembler.processSSE(sse({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 10 } }));
    assembler.processSSE(sse({ type: "message_stop" }));

    // Second turn (resumed, includes all prior context)
    assembler.processSSE(sse({
      type: "message_start",
      message: { id: "m2", model: "test", content: [], usage: { input_tokens: 8000 } },
    }));

    const usage = assembler.getContextUsage();
    expect(usage.input_tokens).toBe(8000);
  });

  it("returns copy (not mutable reference)", () => {
    const assembler = new MessageAssembler(() => {});
    assembler.processSSE(sse({
      type: "message_start",
      message: { id: "m1", model: "test", content: [], usage: { input_tokens: 100 } },
    }));

    const u1 = assembler.getContextUsage();
    const u2 = assembler.getContextUsage();
    expect(u1).toEqual(u2);
    expect(u1).not.toBe(u2);
  });
});

describe("context usage via output module", () => {
  let written: string[] = [];

  beforeEach(() => {
    written = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      written.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
    output.resetOutputState();
    output.configureOutput({ format: "stream-json", verbose: true, includePartial: true });
  });

  it("exposes context usage after SSE processing", () => {
    output.emitSSE(sse({
      type: "message_start",
      message: { id: "m1", model: "test", content: [], usage: { input_tokens: 3000, cache_read_input_tokens: 500 } },
    }));

    const usage = output.getContextUsage();
    expect(usage.input_tokens).toBe(3000);
    expect(usage.cache_read_input_tokens).toBe(500);
  });
});

// ---- 2. Transcript init reading ----

describe("PidWatcher transcript reading", () => {
  let tmpDir: string;
  let sessionsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-test-"));
    sessionsDir = path.join(tmpDir, ".claude", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
  });

  function createPidAndTranscript(pid: number, sessionId: string, cwd: string, transcriptLines: string[]): PidWatcher {
    // Create PID file
    fs.writeFileSync(path.join(sessionsDir, `${pid}.json`), JSON.stringify({
      pid, sessionId, cwd, kind: "cli", status: "idle",
    }));

    // Create transcript
    const slug = "-" + cwd.replace(/\//g, "-").replace(/^-/, "");
    const projectsDir = path.join(tmpDir, ".claude", "projects", slug);
    fs.mkdirSync(projectsDir, { recursive: true });
    fs.writeFileSync(path.join(projectsDir, `${sessionId}.jsonl`), transcriptLines.join("\n") + "\n");

    return new PidWatcher(pid, { onStatusChange: () => {} }, tmpDir);
  }

  it("reads init event from transcript", () => {
    const initEvent = {
      type: "system", subtype: "init", session_id: "sess-1", cwd: "/tmp",
      tools: ["Bash", "Read"], model: "claude-opus-4-7", permissionMode: "bypassPermissions",
      claude_code_version: "2.1.145", agents: ["claude"], skills: ["verify"],
    };

    const watcher = createPidAndTranscript(12345, "sess-1", "/tmp", [
      JSON.stringify({ type: "system", subtype: "hook_started" }),
      JSON.stringify(initEvent),
      JSON.stringify({ type: "system", subtype: "status", status: "requesting" }),
    ]);

    const result = watcher.readTranscriptInit();
    expect(result).toBeDefined();
    expect(result!.subtype).toBe("init");
    expect(result!.tools).toEqual(["Bash", "Read"]);
    expect(result!.model).toBe("claude-opus-4-7");
    expect(result!.agents).toEqual(["claude"]);
  });

  it("returns null when no transcript exists", () => {
    const watcher = new PidWatcher(99999, { onStatusChange: () => {} });
    expect(watcher.readTranscriptInit()).toBeNull();
  });

  it("reads post_turn_summary from transcript tail", () => {
    const summary = {
      type: "system", subtype: "post_turn_summary",
      status_category: "completed", title: "Done",
    };

    const watcher = createPidAndTranscript(12346, "sess-2", "/tmp", [
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess-2", cwd: "/tmp" }),
      JSON.stringify({ type: "stream_event", event: { type: "message_start" } }),
      JSON.stringify(summary),
    ]);

    const results = watcher.readTranscriptEvents("post_turn_summary");
    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe("Done");
  });

  it("returns empty array when no matching events", () => {
    const watcher = createPidAndTranscript(12347, "sess-3", "/tmp", [
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess-3", cwd: "/tmp" }),
    ]);

    const results = watcher.readTranscriptEvents("post_turn_summary");
    expect(results).toHaveLength(0);
  });
});

// ---- 3. set_model control request ----

describe("set_model control request", () => {
  it("fixture has set_model request", () => {
    const lines = fs.readFileSync(
      path.join(import.meta.dirname, "__fixtures__", "claude-p-control-requests-all.jsonl"),
      "utf8",
    ).trim().split("\n").map(l => JSON.parse(l));

    const setModel = lines.find(l => l.type === "control_request" && l.request?.subtype === "set_model");
    expect(setModel).toBeDefined();
    expect(setModel.request).toHaveProperty("model");
  });
});

// ---- 4. stop_task control request ----

describe("stop_task control request", () => {
  it("fixture has stop_task request", () => {
    const lines = fs.readFileSync(
      path.join(import.meta.dirname, "__fixtures__", "claude-p-control-requests-all.jsonl"),
      "utf8",
    ).trim().split("\n").map(l => JSON.parse(l));

    const stopTask = lines.find(l => l.type === "control_request" && l.request?.subtype === "stop_task");
    expect(stopTask).toBeDefined();
    expect(stopTask.request).toHaveProperty("task_id");
  });
});

// ---- 5. emitTranscriptEvent ----

describe("emitTranscriptEvent", () => {
  let written: string[] = [];

  beforeEach(() => {
    written = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      written.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
    output.configureOutput({ format: "stream-json", verbose: true, includePartial: true });
  });

  it("forwards transcript event verbatim", () => {
    const event = {
      type: "system", subtype: "init", session_id: "sess-1", cwd: "/tmp",
      tools: ["Bash"], model: "claude-opus-4-7", permissionMode: "bypassPermissions",
    };
    output.emitTranscriptEvent(event);

    const line = JSON.parse(written[0]!);
    expect(line.tools).toEqual(["Bash"]);
    expect(line.model).toBe("claude-opus-4-7");
    expect(line.permissionMode).toBe("bypassPermissions");
  });

  it("updates sessionId from event", () => {
    output.emitTranscriptEvent({ type: "system", subtype: "init", session_id: "new-sess", cwd: "/tmp" });
    expect(output.getSessionId()).toBe("new-sess");
  });

  it("suppresses in text mode", () => {
    output.configureOutput({ format: "text", verbose: false, includePartial: false });
    output.emitTranscriptEvent({ type: "system", subtype: "init", session_id: "s1", cwd: "/" });
    expect(written).toHaveLength(0);
  });
});

// ---- 6. getSessionId ----

describe("getSessionId", () => {
  let written: string[] = [];

  beforeEach(() => {
    written = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      written.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
    output.configureOutput({ format: "stream-json", verbose: true, includePartial: true });
  });

  it("returns session id set by emitInit", () => {
    output.emitInit("my-session", "/tmp");
    expect(output.getSessionId()).toBe("my-session");
  });
});

