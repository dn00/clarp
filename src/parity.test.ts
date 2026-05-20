/**
 * Parity tests — validate bridge output matches claude -p schema.
 * Uses captured fixtures from real `claude -p` runs. No live API calls.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

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

// ---- Simple hello fixture ----

describe("fixture: hello (simple text response)", () => {
  const lines = loadFixture("claude-p-hello.jsonl");

  it("has events", () => { expect(lines.length).toBeGreaterThan(5); });
  it("every line has type", () => { for (const l of lines) expect(l).toHaveProperty("type"); });

  describe("system.init", () => {
    const inits = findByType(lines, "system", "init");
    it("exists once", () => { expect(inits).toHaveLength(1); });
    it("has session_id, cwd, tools, model", () => {
      const i = inits[0]!;
      expect(typeof i.session_id).toBe("string");
      expect(typeof i.cwd).toBe("string");
      expect(Array.isArray(i.tools)).toBe(true);
      expect(typeof i.model).toBe("string");
    });
    it("has version and output_style", () => {
      const i = inits[0]!;
      expect(i).toHaveProperty("claude_code_version");
      expect(i).toHaveProperty("output_style");
    });
  });

  describe("stream_event", () => {
    it("message_start has model and role", () => {
      const e = findStreamEvent(lines, "message_start")[0]!;
      expect(e.event.message.model).toBeDefined();
      expect(e.event.message.role).toBe("assistant");
    });
    it("content_block_start has index and content_block.type", () => {
      const e = findStreamEvent(lines, "content_block_start")[0]!;
      expect(typeof e.event.index).toBe("number");
      expect(e.event.content_block.type).toBeDefined();
    });
    it("text_delta has text string", () => {
      const deltas = findStreamEvent(lines, "content_block_delta")
        .filter((e: any) => e.event.delta.type === "text_delta");
      expect(deltas.length).toBeGreaterThan(0);
      expect(typeof deltas[0]!.event.delta.text).toBe("string");
    });
    it("message_delta has stop_reason and usage", () => {
      const e = findStreamEvent(lines, "message_delta")[0]!;
      expect(e.event.delta.stop_reason).toBeDefined();
      expect(e.event.usage).toBeDefined();
    });
    it("all stream_events have session_id", () => {
      for (const e of lines.filter(l => l.type === "stream_event")) {
        expect(e).toHaveProperty("session_id");
      }
    });
  });

  describe("assistant", () => {
    const msgs = findByType(lines, "assistant");
    it("exists", () => { expect(msgs.length).toBeGreaterThan(0); });
    it("has message.role=assistant, content array, model", () => {
      const m = msgs[0]!;
      expect(m.message.role).toBe("assistant");
      expect(Array.isArray(m.message.content)).toBe(true);
      expect(m.message.model).toBeDefined();
    });
    it("has session_id", () => {
      for (const m of msgs) expect(m).toHaveProperty("session_id");
    });
  });

  describe("result", () => {
    const results = findByType(lines, "result");
    it("exists once", () => { expect(results).toHaveLength(1); });
    it("has required fields", () => {
      const r = results[0]!;
      expect(r.subtype).toBe("success");
      expect(r.is_error).toBe(false);
      expect(typeof r.result).toBe("string");
      expect(typeof r.duration_ms).toBe("number");
      expect(typeof r.num_turns).toBe("number");
      expect(r.stop_reason).toBe("end_turn");
      expect(typeof r.total_cost_usd).toBe("number");
      expect(r).toHaveProperty("session_id");
    });
  });

  describe("ordering", () => {
    it("init before stream_events", () => {
      const initIdx = lines.findIndex(l => l.type === "system" && l.subtype === "init");
      const firstStream = lines.findIndex(l => l.type === "stream_event");
      expect(initIdx).toBeLessThan(firstStream);
    });
    it("result is last", () => {
      expect(lines[lines.length - 1]!.type).toBe("result");
    });
  });
});

// ---- Tool use fixture ----

describe("fixture: tool-use (read file)", () => {
  const lines = loadFixture("claude-p-tool-use.jsonl");

  it("has tool_use content block", () => {
    const toolBlocks = findStreamEvent(lines, "content_block_start")
      .filter((e: any) => e.event.content_block.type === "tool_use");
    expect(toolBlocks.length).toBeGreaterThan(0);
    expect(toolBlocks[0]!.event.content_block).toHaveProperty("name");
    expect(toolBlocks[0]!.event.content_block).toHaveProperty("id");
  });

  it("has input_json_delta for tool input", () => {
    const jsonDeltas = findStreamEvent(lines, "content_block_delta")
      .filter((e: any) => e.event.delta.type === "input_json_delta");
    expect(jsonDeltas.length).toBeGreaterThan(0);
    expect(typeof jsonDeltas[0]!.event.delta.partial_json).toBe("string");
  });

  it("has user message with tool_result", () => {
    const users = findByType(lines, "user");
    expect(users.length).toBeGreaterThan(0);
    const toolResult = users.find((u: any) =>
      Array.isArray(u.message?.content) &&
      u.message.content.some((b: any) => b.type === "tool_result")
    );
    expect(toolResult).toBeDefined();
  });

  it("has multiple API turns (tool use → result → response)", () => {
    const messageStarts = findStreamEvent(lines, "message_start");
    expect(messageStarts.length).toBeGreaterThanOrEqual(2);
  });

  it("assistant messages have tool_use content blocks", () => {
    const assistants = findByType(lines, "assistant");
    const withToolUse = assistants.filter((a: any) =>
      a.message.content.some((b: any) => b.type === "tool_use")
    );
    expect(withToolUse.length).toBeGreaterThan(0);
    const block = withToolUse[0]!.message.content.find((b: any) => b.type === "tool_use");
    expect(block).toHaveProperty("id");
    expect(block).toHaveProperty("name");
    expect(block).toHaveProperty("input");
  });
});

// ---- Multi-turn fixture ----

describe("fixture: multi-turn (two prompts)", () => {
  const lines = loadFixture("claude-p-multi-turn.jsonl");

  it("has two result messages (one per turn)", () => {
    const results = findByType(lines, "result");
    expect(results).toHaveLength(2);
  });

  it("has two init messages", () => {
    const inits = findByType(lines, "system", "init");
    expect(inits).toHaveLength(2);
  });

  it("has user replay messages", () => {
    const users = findByType(lines, "user");
    expect(users.length).toBeGreaterThan(0);
    expect(users[0]!.message.role).toBe("user");
  });

  it("both turns have message_start → delta → message_stop", () => {
    const starts = findStreamEvent(lines, "message_start");
    const stops = findStreamEvent(lines, "message_stop");
    expect(starts.length).toBeGreaterThanOrEqual(2);
    expect(stops.length).toBeGreaterThanOrEqual(2);
  });

  it("results are interleaved correctly", () => {
    const resultIndices = lines.reduce((acc: number[], l: any, i: number) =>
      l.type === "result" ? [...acc, i] : acc, []);
    const secondInitIdx = lines.reduce((acc: number, l: any, i: number) => {
      if (l.type === "system" && l.subtype === "init") return acc === -1 ? i : (acc > 0 ? acc : i);
      return acc;
    }, -1);
    // Second init must come after first result
    const inits = lines.reduce((acc: number[], l: any, i: number) =>
      l.type === "system" && l.subtype === "init" ? [...acc, i] : acc, []);
    expect(inits[1]).toBeGreaterThan(resultIndices[0]!);
  });
});

// ---- Control request fixture (synthetic) ----

describe("fixture: control-request (can_use_tool schema)", () => {
  const lines = loadFixture("claude-p-control-requests-all.jsonl");

  it("has control_request with can_use_tool", () => {
    const req = lines.find(l => l.type === "control_request" && l.request?.subtype === "can_use_tool");
    expect(req).toBeDefined();
    expect(req.request.subtype).toBe("can_use_tool");
  });

  it("can_use_tool has required fields", () => {
    const req = lines.find(l => l.type === "control_request" && l.request?.subtype === "can_use_tool")!;
    expect(req).toHaveProperty("request_id");
    expect(req.request).toHaveProperty("tool_name");
    expect(req.request).toHaveProperty("input");
    expect(req.request).toHaveProperty("tool_use_id");
  });

  it("has control_cancel_request", () => {
    const cancel = lines.find(l => l.type === "control_cancel_request");
    expect(cancel).toBeDefined();
    expect(cancel).toHaveProperty("request_id");
  });
});

// ---- Assistant ordering (v0.3) ----

describe("assistant ordering matches real -p", () => {
  const lines = loadFixture("claude-p-hello.jsonl");

  it("assistant appears before content_block_stop", () => {
    const assistantIdx = lines.findIndex(l => l.type === "assistant");
    const blockStopIdx = lines.findIndex(l => l.type === "stream_event" && l.event?.type === "content_block_stop");
    expect(assistantIdx).toBeGreaterThan(-1);
    expect(blockStopIdx).toBeGreaterThan(-1);
    expect(assistantIdx).toBeLessThan(blockStopIdx);
  });

  it("assistant appears after last content_block_delta", () => {
    const deltas = lines.reduce((acc: number[], l: any, i: number) =>
      l.type === "stream_event" && l.event?.type === "content_block_delta" ? [...acc, i] : acc, []);
    const assistantIdx = lines.findIndex(l => l.type === "assistant");
    expect(assistantIdx).toBeGreaterThan(deltas[deltas.length - 1]!);
  });
});

describe("permission fixture: assistant ordering matches real -p", () => {
  const lines = loadFixture("claude-p-permission.jsonl");

  it("assistant events appear before their content_block_stop", () => {
    const assistants = lines.reduce((acc: number[], l: any, i: number) =>
      l.type === "assistant" ? [...acc, i] : acc, []);
    const stops = lines.reduce((acc: number[], l: any, i: number) =>
      l.type === "stream_event" && l.event?.type === "content_block_stop" ? [...acc, i] : acc, []);

    for (let j = 0; j < assistants.length; j++) {
      expect(assistants[j]).toBeLessThan(stops[j]!);
    }
  });

  it("each assistant has single content block", () => {
    const assistants = lines.filter(l => l.type === "assistant");
    for (const a of assistants) {
      expect(a.message.content.length).toBeLessThanOrEqual(2);
    }
  });
});

