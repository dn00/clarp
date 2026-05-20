import { describe, it, expect } from "vitest";
import { MessageAssembler, type AssembledMessage } from "./message-assembler.js";
import type { SSEEvent } from "./proxy.js";

function sse(parsed: unknown): SSEEvent {
  return { data: JSON.stringify(parsed), parsed };
}

function collect(events: SSEEvent[]): AssembledMessage[] {
  const messages: AssembledMessage[] = [];
  const assembler = new MessageAssembler((msg) => messages.push(msg));
  for (const e of events) assembler.processSSE(e);
  return messages;
}

describe("MessageAssembler", () => {
  it("emits on content_block_stop with single block", () => {
    const msgs = collect([
      sse({ type: "message_start", message: { id: "msg_01", model: "claude-opus-4-7", content: [], usage: { input_tokens: 100, output_tokens: 0 } } }),
      sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }),
      sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } }),
      sse({ type: "content_block_stop", index: 0 }),
      sse({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }),
      sse({ type: "message_stop" }),
    ]);

    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.id).toBe("msg_01");
    expect(msgs[0]!.model).toBe("claude-opus-4-7");
    expect(msgs[0]!.content).toHaveLength(1);
    expect(msgs[0]!.content[0]).toEqual({ type: "text", text: "Hello world" });
    expect(msgs[0]!.stop_reason).toBeNull();
    expect(msgs[0]!.usage.input_tokens).toBe(100);
  });

  it("emits per content block for thinking + text", () => {
    const msgs = collect([
      sse({ type: "message_start", message: { id: "msg_02", model: "claude-opus-4-7", content: [], usage: { input_tokens: 50 } } }),
      sse({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
      sse({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me think..." } }),
      sse({ type: "content_block_stop", index: 0 }),
      sse({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
      sse({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Answer" } }),
      sse({ type: "content_block_stop", index: 1 }),
      sse({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 10 } }),
      sse({ type: "message_stop" }),
    ]);

    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.content).toHaveLength(1);
    expect(msgs[0]!.content[0]).toEqual({ type: "thinking", thinking: "Let me think..." });
    expect(msgs[1]!.content).toHaveLength(1);
    expect(msgs[1]!.content[0]).toEqual({ type: "text", text: "Answer" });
  });

  it("assembles tool_use with JSON input", () => {
    const msgs = collect([
      sse({ type: "message_start", message: { id: "msg_03", model: "claude-opus-4-7", content: [] } }),
      sse({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_01", name: "Bash" } }),
      sse({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"comm' } }),
      sse({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'and":"ls"}' } }),
      sse({ type: "content_block_stop", index: 0 }),
      sse({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 8 } }),
      sse({ type: "message_stop" }),
    ]);

    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.content).toHaveLength(1);
    const block = msgs[0]!.content[0]!;
    expect(block.type).toBe("tool_use");
    if (block.type === "tool_use") {
      expect(block.name).toBe("Bash");
      expect(block.id).toBe("toolu_01");
      expect(block.input).toEqual({ command: "ls" });
    }
    expect(msgs[0]!.stop_reason).toBeNull();
  });

  it("handles multiple messages in sequence", () => {
    const msgs = collect([
      // Title generation
      sse({ type: "message_start", message: { id: "msg_title", model: "claude-opus-4-7", content: [] } }),
      sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "title" } }),
      sse({ type: "content_block_stop", index: 0 }),
      sse({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }),
      sse({ type: "message_stop" }),
      // Real response
      sse({ type: "message_start", message: { id: "msg_real", model: "claude-opus-4-7", content: [] } }),
      sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }),
      sse({ type: "content_block_stop", index: 0 }),
      sse({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }),
      sse({ type: "message_stop" }),
    ]);

    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.id).toBe("msg_title");
    expect(msgs[0]!.content).toHaveLength(1);
    expect(msgs[1]!.id).toBe("msg_real");
    expect(msgs[1]!.content).toHaveLength(1);
  });

  it("handles malformed input_json gracefully", () => {
    const msgs = collect([
      sse({ type: "message_start", message: { id: "msg_04", model: "claude-opus-4-7", content: [] } }),
      sse({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_02", name: "Read" } }),
      sse({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{broken" } }),
      sse({ type: "content_block_stop", index: 0 }),
      sse({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }),
      sse({ type: "message_stop" }),
    ]);

    expect(msgs).toHaveLength(1);
    const block = msgs[0]!.content[0]!;
    if (block.type === "tool_use") {
      expect(block.input).toBe("{broken");
    }
  });

  it("ignores events without message_start", () => {
    const msgs = collect([
      sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "orphan" } }),
      sse({ type: "message_stop" }),
    ]);

    expect(msgs).toHaveLength(0);
  });

  it("tracks lastToolUse", () => {
    const messages: AssembledMessage[] = [];
    const assembler = new MessageAssembler((msg) => messages.push(msg));

    [
      sse({ type: "message_start", message: { id: "msg_t", model: "claude-opus-4-7", content: [] } }),
      sse({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_99", name: "Read" } }),
      sse({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"file_path":"/tmp/x"}' } }),
      sse({ type: "content_block_stop", index: 0 }),
    ].forEach(e => assembler.processSSE(e));

    const last = assembler.getLastToolUse();
    expect(last).toBeDefined();
    expect(last!.name).toBe("Read");
    expect(last!.id).toBe("toolu_99");
    expect(last!.input).toEqual({ file_path: "/tmp/x" });
  });

  it("emits text+tool_use as two separate messages", () => {
    const msgs = collect([
      sse({ type: "message_start", message: { id: "msg_m", model: "claude-opus-4-7", content: [] } }),
      sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "I'll read that." } }),
      sse({ type: "content_block_stop", index: 0 }),
      sse({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_01", name: "Read" } }),
      sse({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"file_path":"/tmp"}' } }),
      sse({ type: "content_block_stop", index: 1 }),
      sse({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } }),
      sse({ type: "message_stop" }),
    ]);

    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.content[0]).toEqual({ type: "text", text: "I'll read that." });
    expect(msgs[1]!.content[0]!.type).toBe("tool_use");
    if (msgs[1]!.content[0]!.type === "tool_use") {
      expect(msgs[1]!.content[0]!.name).toBe("Read");
    }
  });

  it("ignores ping events", () => {
    const msgs = collect([
      sse({ type: "message_start", message: { id: "msg_05", model: "claude-opus-4-7", content: [] } }),
      sse({ type: "ping" }),
      sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } }),
      sse({ type: "content_block_stop", index: 0 }),
      sse({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
      sse({ type: "message_stop" }),
    ]);

    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.content[0]).toEqual({ type: "text", text: "Hi" });
  });
});
