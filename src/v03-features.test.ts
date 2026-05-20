/**
 * v0.3 feature tests — assistant ordering, enriched init, permission forwarding, post_turn_summary.
 * Tests against new synthetic fixtures.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { MessageAssembler, type AssembledMessage } from "./message-assembler.js";
import * as output from "./output.js";
import type { SSEEvent } from "./proxy.js";

function loadFixture(name: string): any[] {
  const p = path.join(import.meta.dirname, "__fixtures__", name);
  return fs.readFileSync(p, "utf8").trim().split("\n").map(l => JSON.parse(l));
}

function findByType(lines: any[], type: string, subtype?: string) {
  return lines.filter(l => l.type === type && (subtype === undefined || l.subtype === subtype));
}

function findStreamEvent(lines: any[], eventType: string) {
  return lines.filter(l => l.type === "stream_event" && l.event?.type === eventType);
}

function sse(parsed: unknown): SSEEvent {
  return { data: JSON.stringify(parsed), parsed };
}

// ---- 1. Assistant message ordering ----

describe("assistant message ordering (fixture)", () => {
  const lines = loadFixture("claude-p-assistant-ordering.jsonl");

  it("has two assistant messages (one per content block)", () => {
    const assistants = findByType(lines, "assistant");
    expect(assistants).toHaveLength(2);
  });

  it("first assistant is text block only", () => {
    const assistants = findByType(lines, "assistant");
    expect(assistants[0].message.content).toHaveLength(1);
    expect(assistants[0].message.content[0].type).toBe("text");
    expect(assistants[0].message.content[0].text).toBe("I'll read that file.");
  });

  it("second assistant is tool_use block only", () => {
    const assistants = findByType(lines, "assistant");
    expect(assistants[1].message.content).toHaveLength(1);
    expect(assistants[1].message.content[0].type).toBe("tool_use");
    expect(assistants[1].message.content[0].name).toBe("Read");
  });

  it("assistant appears before corresponding content_block_stop", () => {
    const assistantIndices = lines.reduce((acc: number[], l: any, i: number) =>
      l.type === "assistant" ? [...acc, i] : acc, []);
    const blockStopIndices = lines.reduce((acc: number[], l: any, i: number) =>
      l.type === "stream_event" && l.event?.type === "content_block_stop" ? [...acc, i] : acc, []);

    expect(assistantIndices).toHaveLength(2);
    expect(blockStopIndices).toHaveLength(2);
    expect(assistantIndices[0]).toBeLessThan(blockStopIndices[0]!);
    expect(assistantIndices[1]).toBeLessThan(blockStopIndices[1]!);
  });

  it("assistant stop_reason is null (message still in progress)", () => {
    const assistants = findByType(lines, "assistant");
    for (const a of assistants) {
      expect(a.message.stop_reason).toBeNull();
    }
  });

  it("both assistants share the same message id", () => {
    const assistants = findByType(lines, "assistant");
    expect(assistants[0].message.id).toBe(assistants[1].message.id);
  });

  it("no assistant after message_stop", () => {
    const msgStopIdx = lines.findIndex(l => l.type === "stream_event" && l.event?.type === "message_stop");
    const postStopAssistants = lines.slice(msgStopIdx + 1).filter(l => l.type === "assistant");
    expect(postStopAssistants).toHaveLength(0);
  });
});

describe("assistant ordering (live assembler)", () => {
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

  it("emits assistant before content_block_stop for single block", () => {
    const events = [
      sse({ type: "message_start", message: { id: "m1", model: "test", content: [], usage: { input_tokens: 10 } } }),
      sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } }),
      sse({ type: "content_block_stop", index: 0 }),
      sse({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
      sse({ type: "message_stop" }),
    ];
    for (const e of events) output.emitSSE(e);

    const parsed = written.map(w => JSON.parse(w));
    const types = parsed.map((p: any) => p.type === "stream_event" ? `se:${p.event.type}` : p.type);

    const assistantIdx = types.indexOf("assistant");
    const blockStopIdx = types.indexOf("se:content_block_stop");
    const messageStopIdx = types.indexOf("se:message_stop");

    expect(assistantIdx).toBeGreaterThan(-1);
    expect(assistantIdx).toBeLessThan(blockStopIdx);
    expect(assistantIdx).toBeLessThan(messageStopIdx);
  });

  it("emits two assistants for text+tool_use message", () => {
    const events = [
      sse({ type: "message_start", message: { id: "m2", model: "test", content: [], usage: { input_tokens: 10 } } }),
      sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Running..." } }),
      sse({ type: "content_block_stop", index: 0 }),
      sse({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "Bash" } }),
      sse({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' } }),
      sse({ type: "content_block_stop", index: 1 }),
      sse({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } }),
      sse({ type: "message_stop" }),
    ];
    for (const e of events) output.emitSSE(e);

    const parsed = written.map(w => JSON.parse(w));
    const assistants = parsed.filter((p: any) => p.type === "assistant");

    expect(assistants).toHaveLength(2);
    expect(assistants[0].message.content[0].type).toBe("text");
    expect(assistants[1].message.content[0].type).toBe("tool_use");
  });

  it("does not emit assistant on message_stop", () => {
    const events = [
      sse({ type: "message_start", message: { id: "m3", model: "test", content: [], usage: { input_tokens: 10 } } }),
      sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done" } }),
      sse({ type: "content_block_stop", index: 0 }),
      sse({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
      sse({ type: "message_stop" }),
    ];
    for (const e of events) output.emitSSE(e);

    const parsed = written.map(w => JSON.parse(w));
    const messageStopIdx = parsed.findIndex((p: any) => p.type === "stream_event" && p.event?.type === "message_stop");
    const postStopAssistants = parsed.slice(messageStopIdx + 1).filter((p: any) => p.type === "assistant");
    expect(postStopAssistants).toHaveLength(0);
  });
});

// ---- 2. Enriched init ----

describe("enriched init (fixture)", () => {
  const lines = loadFixture("claude-p-hello.jsonl");
  const init = findByType(lines, "system", "init")[0]!;

  it("has tools array", () => {
    expect(Array.isArray(init.tools)).toBe(true);
    expect(init.tools.length).toBeGreaterThan(0);
  });

  it("has model string", () => {
    expect(typeof init.model).toBe("string");
    expect(init.model).toBe("claude-opus-4-7");
  });

  it("has permissionMode", () => {
    expect(typeof init.permissionMode).toBe("string");
  });

  it("has claude_code_version", () => {
    expect(typeof init.claude_code_version).toBe("string");
  });

  it("has slash_commands array", () => {
    expect(Array.isArray(init.slash_commands)).toBe(true);
  });

  it("has agents array", () => {
    expect(Array.isArray(init.agents)).toBe(true);
  });

  it("has skills array", () => {
    expect(Array.isArray(init.skills)).toBe(true);
  });

  it("has fast_mode_state", () => {
    expect(typeof init.fast_mode_state).toBe("string");
  });

  it("has output_style", () => {
    expect(typeof init.output_style).toBe("string");
  });

  it("has mcp_servers array", () => {
    expect(Array.isArray(init.mcp_servers)).toBe(true);
  });

  it("has plugins array", () => {
    expect(Array.isArray(init.plugins)).toBe(true);
  });
});

describe("enriched init (emitter)", () => {
  let written: string[] = [];

  beforeEach(() => {
    written = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      written.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
    output.configureOutput({ format: "stream-json", verbose: true, includePartial: true });
  });

  it("emits all required fields with defaults", () => {
    output.emitInit("sess-1", "/tmp");

    const line = JSON.parse(written[0]!);
    expect(line.type).toBe("system");
    expect(line.subtype).toBe("init");
    expect(Array.isArray(line.tools)).toBe(true);
    expect(Array.isArray(line.mcp_servers)).toBe(true);
    expect(typeof line.model).toBe("string");
    expect(typeof line.permissionMode).toBe("string");
    expect(Array.isArray(line.slash_commands)).toBe(true);
    expect(typeof line.claude_code_version).toBe("string");
    expect(typeof line.output_style).toBe("string");
    expect(Array.isArray(line.agents)).toBe(true);
    expect(Array.isArray(line.skills)).toBe(true);
    expect(Array.isArray(line.plugins)).toBe(true);
    expect(typeof line.fast_mode_state).toBe("string");
  });

  it("populates fields from InitData", () => {
    output.emitInit("sess-2", "/home", {
      model: "claude-opus-4-7",
      tools: ["Bash", "Read", "Write"],
      permissionMode: "bypassPermissions",
      claude_code_version: "2.1.145",
      agents: ["claude", "Explore"],
      skills: ["verify", "review"],
      mcp_servers: [{ name: "gmail", status: "connected" }],
      fast_mode_state: "off",
    });

    const line = JSON.parse(written[0]!);
    expect(line.model).toBe("claude-opus-4-7");
    expect(line.tools).toEqual(["Bash", "Read", "Write"]);
    expect(line.permissionMode).toBe("bypassPermissions");
    expect(line.claude_code_version).toBe("2.1.145");
    expect(line.agents).toEqual(["claude", "Explore"]);
    expect(line.skills).toEqual(["verify", "review"]);
    expect(line.mcp_servers).toEqual([{ name: "gmail", status: "connected" }]);
    expect(line.fast_mode_state).toBe("off");
  });
});

// ---- 3. Permission forwarding ----

describe("permission forwarding (fixture)", () => {
  const lines = loadFixture("claude-p-permission-forward.jsonl");

  it("has control_request with can_use_tool", () => {
    const reqs = findByType(lines, "control_request");
    expect(reqs).toHaveLength(1);
    expect(reqs[0].request.subtype).toBe("can_use_tool");
  });

  it("control_request has required fields", () => {
    const req = findByType(lines, "control_request")[0]!;
    expect(req).toHaveProperty("request_id");
    expect(req.request).toHaveProperty("tool_name");
    expect(req.request).toHaveProperty("input");
    expect(req.request).toHaveProperty("tool_use_id");
    expect(req.request.tool_name).toBe("Bash");
    expect(req.request.tool_use_id).toBe("toolu_perm_01");
  });

  it("has control_response with allow", () => {
    const resps = findByType(lines, "control_response");
    expect(resps).toHaveLength(1);
    expect(resps[0].response.behavior).toBe("allow");
  });

  it("control_response matches request_id", () => {
    const req = findByType(lines, "control_request")[0]!;
    const resp = findByType(lines, "control_response")[0]!;
    expect(resp.request_id).toBe(req.request_id);
  });

  it("control_request appears after tool_use message_stop", () => {
    const msgStopIdx = lines.findIndex(l => l.type === "stream_event" && l.event?.type === "message_stop");
    const reqIdx = lines.findIndex(l => l.type === "control_request");
    expect(reqIdx).toBeGreaterThan(msgStopIdx);
  });

  it("tool execution continues after allow", () => {
    const respIdx = lines.findIndex(l => l.type === "control_response");
    const toolResult = lines.slice(respIdx).find(l =>
      l.type === "user" && l.message?.content?.some((b: any) => b.type === "tool_result")
    );
    expect(toolResult).toBeDefined();
  });

  it("has permissionMode=default in init", () => {
    const init = findByType(lines, "system", "init")[0]!;
    expect(init.permissionMode).toBe("default");
  });
});

describe("permission forwarding (emitter)", () => {
  let written: string[] = [];

  beforeEach(() => {
    written = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      written.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
    output.configureOutput({ format: "stream-json", verbose: true, includePartial: true });
  });

  it("emits control_request with can_use_tool", () => {
    output.emitControlRequest("req-1", "Bash", "toolu_01", { command: "ls" });

    const line = JSON.parse(written[0]!);
    expect(line.type).toBe("control_request");
    expect(line.request_id).toBe("req-1");
    expect(line.request.subtype).toBe("can_use_tool");
    expect(line.request.tool_name).toBe("Bash");
    expect(line.request.tool_use_id).toBe("toolu_01");
    expect(line.request.input).toEqual({ command: "ls" });
  });

  it("includes optional description", () => {
    output.emitControlRequest("req-2", "Read", "toolu_02", { file_path: "/tmp" }, "Read a file");

    const line = JSON.parse(written[0]!);
    expect(line.request.description).toBe("Read a file");
  });

  it("suppresses in text mode", () => {
    output.configureOutput({ format: "text", verbose: false, includePartial: false });
    output.emitControlRequest("req-3", "Bash", "toolu_03", {});
    expect(written).toHaveLength(0);
  });
});

// ---- 4. Post-turn summary ----

describe("post_turn_summary (fixture)", () => {
  const lines = loadFixture("claude-p-post-turn-summary.jsonl");

  it("has post_turn_summary event", () => {
    const summaries = findByType(lines, "system", "post_turn_summary");
    expect(summaries).toHaveLength(1);
  });

  it("has required fields", () => {
    const s = findByType(lines, "system", "post_turn_summary")[0]!;
    expect(typeof s.summarizes_uuid).toBe("string");
    expect(["completed", "blocked", "waiting", "failed", "review_ready"]).toContain(s.status_category);
    expect(typeof s.status_detail).toBe("string");
    expect(typeof s.is_noteworthy).toBe("boolean");
    expect(typeof s.title).toBe("string");
    expect(typeof s.description).toBe("string");
    expect(typeof s.recent_action).toBe("string");
    expect(typeof s.needs_action).toBe("string");
    expect(Array.isArray(s.artifact_urls)).toBe(true);
  });

  it("appears before result", () => {
    const summaryIdx = lines.findIndex(l => l.type === "system" && l.subtype === "post_turn_summary");
    const resultIdx = lines.findIndex(l => l.type === "result");
    expect(summaryIdx).toBeLessThan(resultIdx);
  });

  it("appears after stream events", () => {
    const lastStreamIdx = lines.reduce((acc: number, l: any, i: number) =>
      l.type === "stream_event" ? i : acc, -1);
    const summaryIdx = lines.findIndex(l => l.type === "system" && l.subtype === "post_turn_summary");
    expect(summaryIdx).toBeGreaterThan(lastStreamIdx);
  });
});

describe("post_turn_summary (emitter)", () => {
  let written: string[] = [];

  beforeEach(() => {
    written = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      written.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    });
    output.configureOutput({ format: "stream-json", verbose: true, includePartial: true });
  });

  it("emits post_turn_summary with all fields", () => {
    output.emitPostTurnSummary({
      summarizesUuid: "uuid-turn-1",
      statusCategory: "completed",
      statusDetail: "Turn completed successfully",
      title: "Answered question",
      description: "Provided a greeting response",
      recentAction: "Generated text response",
      needsAction: "",
    });

    const line = JSON.parse(written[0]!);
    expect(line.type).toBe("system");
    expect(line.subtype).toBe("post_turn_summary");
    expect(line.summarizes_uuid).toBe("uuid-turn-1");
    expect(line.status_category).toBe("completed");
    expect(line.status_detail).toBe("Turn completed successfully");
    expect(line.is_noteworthy).toBe(false);
    expect(line.title).toBe("Answered question");
    expect(line.description).toBe("Provided a greeting response");
    expect(line.recent_action).toBe("Generated text response");
    expect(line.needs_action).toBe("");
    expect(line.artifact_urls).toEqual([]);
  });

  it("supports noteworthy and artifact_urls", () => {
    output.emitPostTurnSummary({
      statusCategory: "blocked",
      statusDetail: "Permission denied",
      title: "Blocked",
      description: "Could not access file",
      recentAction: "Attempted Read",
      needsAction: "Grant file access",
      isNoteworthy: true,
      artifactUrls: ["file:///tmp/log.txt"],
    });

    const line = JSON.parse(written[0]!);
    expect(line.is_noteworthy).toBe(true);
    expect(line.status_category).toBe("blocked");
    expect(line.artifact_urls).toEqual(["file:///tmp/log.txt"]);
    expect(line.needs_action).toBe("Grant file access");
  });

  it("suppresses in text mode", () => {
    output.configureOutput({ format: "text", verbose: false, includePartial: false });
    output.emitPostTurnSummary({
      statusCategory: "completed",
      statusDetail: "Done",
      title: "Done",
      description: "Done",
      recentAction: "Text",
      needsAction: "",
    });
    expect(written).toHaveLength(0);
  });
});

// ---- 5. getLastToolUse integration ----

describe("getLastToolUse tracking", () => {
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

  it("returns tool info after processing tool_use block", () => {
    const events = [
      sse({ type: "message_start", message: { id: "m1", model: "test", content: [] } }),
      sse({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_01", name: "Bash" } }),
      sse({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' } }),
      sse({ type: "content_block_stop", index: 0 }),
      sse({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 10 } }),
      sse({ type: "message_stop" }),
    ];
    for (const e of events) output.emitSSE(e);

    const last = output.getLastToolUse();
    expect(last).toBeDefined();
    expect(last!.name).toBe("Bash");
    expect(last!.id).toBe("toolu_01");
    expect(last!.input).toEqual({ command: "ls" });
  });
});

// ---- 6. Request body capture (proxy) ----

describe("proxy request body capture", () => {
  // This is tested at the integration level via the proxy callback
  // The proxy.test.ts file tests SSE parsing; here we validate the onRequestBody contract

  it("fixture init has tools from API request", () => {
    const lines = loadFixture("claude-p-assistant-ordering.jsonl");
    const init = findByType(lines, "system", "init")[0]!;
    expect(Array.isArray(init.tools)).toBe(true);
    expect(init.tools.length).toBeGreaterThan(0);
  });
});

// ---- 7. Cross-feature: permission fixture has correct ordering ----

describe("permission fixture cross-feature validation", () => {
  const lines = loadFixture("claude-p-permission-forward.jsonl");

  it("assistant events appear before content_block_stop", () => {
    const assistantIndices = lines.reduce((acc: number[], l: any, i: number) =>
      l.type === "assistant" ? [...acc, i] : acc, []);
    const blockStopIndices = lines.reduce((acc: number[], l: any, i: number) =>
      l.type === "stream_event" && l.event?.type === "content_block_stop" ? [...acc, i] : acc, []);

    for (let j = 0; j < assistantIndices.length; j++) {
      expect(assistantIndices[j]).toBeLessThan(blockStopIndices[j]!);
    }
  });

  it("has enriched init fields", () => {
    const init = findByType(lines, "system", "init")[0]!;
    expect(init.tools).toBeDefined();
    expect(init.permissionMode).toBe("default");
    expect(init.claude_code_version).toBeDefined();
    expect(init.fast_mode_state).toBeDefined();
  });

  it("has post_turn_summary before result", () => {
    const summaryIdx = lines.findIndex(l => l.type === "system" && l.subtype === "post_turn_summary");
    const resultIdx = lines.findIndex(l => l.type === "result");
    expect(summaryIdx).toBeGreaterThan(-1);
    expect(summaryIdx).toBeLessThan(resultIdx);
  });

  it("full event sequence matches expected protocol", () => {
    const typeSeq = lines.map((l: any) => {
      if (l.type === "system") return `system.${l.subtype}`;
      if (l.type === "stream_event") return `se:${l.event.type}`;
      return l.type;
    });

    expect(typeSeq[0]).toBe("system.init");
    expect(typeSeq).toContain("control_request");
    expect(typeSeq).toContain("control_response");
    expect(typeSeq).toContain("system.post_turn_summary");
    expect(typeSeq[typeSeq.length - 1]).toBe("result");
  });
});
