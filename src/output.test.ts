import { describe, it, expect, beforeEach, vi } from "vitest";
import * as output from "./output.js";
import type { SSEEvent } from "./proxy.js";

function sse(parsed: unknown): SSEEvent {
  return { data: JSON.stringify(parsed), parsed };
}

let written: string[] = [];

beforeEach(() => {
  written = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
    written.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  });
  output.resetOutputState();
});

describe("text accumulation", () => {
  beforeEach(() => {
    output.configureOutput({ format: "stream-json", verbose: true, includePartial: true });
  });

  it("accumulates text_delta content", () => {
    output.emitSSE(sse({ type: "message_start", message: { id: "m1", model: "test", content: [] } }));
    output.emitSSE(sse({ type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } }));
    output.emitSSE(sse({ type: "content_block_delta", delta: { type: "text_delta", text: " world" } }));
    output.emitSSE(sse({ type: "message_stop" }));

    expect(output.getAccumulatedText()).toBe("Hello world");
  });

  it("ignores non-text deltas", () => {
    output.emitSSE(sse({ type: "message_start", message: { id: "m1", model: "test", content: [] } }));
    output.emitSSE(sse({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '{"foo"' } }));
    output.emitSSE(sse({ type: "message_stop" }));

    expect(output.getAccumulatedText()).toBe("");
  });

  it("tracks last message text (filters title generation)", () => {
    output.emitSSE(sse({ type: "message_start", message: { id: "title", model: "test", content: [] } }));
    output.emitSSE(sse({ type: "content_block_delta", delta: { type: "text_delta", text: '{"title":"test"}' } }));
    output.emitSSE(sse({ type: "message_stop" }));

    output.emitSSE(sse({ type: "message_start", message: { id: "real", model: "test", content: [] } }));
    output.emitSSE(sse({ type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } }));
    output.emitSSE(sse({ type: "message_stop" }));

    expect(output.getAccumulatedText()).toBe("Hello");
  });

  it("resets on resetAccumulatedText", () => {
    output.emitSSE(sse({ type: "message_start", message: { id: "m1", model: "test", content: [] } }));
    output.emitSSE(sse({ type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } }));
    output.emitSSE(sse({ type: "message_stop" }));
    output.resetOutputState();
    expect(output.getAccumulatedText()).toBe("");
  });
});

describe("stream-json output", () => {
  beforeEach(() => {
    output.configureOutput({ format: "stream-json", verbose: true, includePartial: true });
  });

  it("wraps stream events in stream_event envelope", () => {
    output.emitSSE(sse({ type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } }));

    const line = JSON.parse(written[0]!);
    expect(line.type).toBe("stream_event");
    expect(line.event.type).toBe("content_block_delta");
  });

  it("does not emit stream events when includePartial is false", () => {
    output.configureOutput({ format: "stream-json", verbose: true, includePartial: false });
    output.emitSSE(sse({ type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } }));

    // Only the assembled assistant message on message_stop, no stream_events
    expect(written.filter(w => w.includes("stream_event"))).toHaveLength(0);
  });

  it("emits assembled assistant message before content_block_stop", () => {
    output.emitSSE(sse({ type: "message_start", message: { id: "m1", model: "test-model", content: [], usage: { input_tokens: 10 } } }));
    output.emitSSE(sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
    output.emitSSE(sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }));
    output.emitSSE(sse({ type: "content_block_stop", index: 0 }));
    output.emitSSE(sse({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }));
    output.emitSSE(sse({ type: "message_stop" }));

    const parsed = written.map(w => JSON.parse(w));
    const assistantIdx = parsed.findIndex((l: any) => l.type === "assistant");
    const blockStopIdx = parsed.findIndex((l: any) => l.type === "stream_event" && l.event?.type === "content_block_stop");

    expect(assistantIdx).toBeGreaterThan(-1);
    expect(blockStopIdx).toBeGreaterThan(-1);
    expect(assistantIdx).toBeLessThan(blockStopIdx);

    const assistantLine = parsed[assistantIdx];
    expect(assistantLine.message.content[0].text).toBe("Hello");
    expect(assistantLine.message.model).toBe("test-model");
    expect(assistantLine.message.stop_reason).toBeNull();
  });
});

describe("emitUserReplay", () => {
  it("emits user message when replayUserMessages is on", () => {
    output.configureOutput({ format: "stream-json", verbose: true, includePartial: true, replayUserMessages: true });
    output.emitUserReplay("hello world");

    const line = JSON.parse(written[0]!);
    expect(line.type).toBe("user");
    expect(line.message.content).toBe("hello world");
  });

  it("suppresses when replayUserMessages is off", () => {
    output.configureOutput({ format: "stream-json", verbose: true, includePartial: true, replayUserMessages: false });
    output.emitUserReplay("hello world");

    expect(written).toHaveLength(0);
  });

  it("suppresses in text mode", () => {
    output.configureOutput({ format: "text", verbose: false, includePartial: false, replayUserMessages: true });
    output.emitUserReplay("hello world");

    expect(written).toHaveLength(0);
  });
});

describe("emitSessionStateChanged", () => {
  it("emits state change in stream-json mode", () => {
    output.configureOutput({ format: "stream-json", verbose: false, includePartial: false });
    output.emitSessionStateChanged("running");

    const line = JSON.parse(written[0]!);
    expect(line.type).toBe("system");
    expect(line.subtype).toBe("session_state_changed");
    expect(line.state).toBe("running");
  });

  it("emits requires_action for waiting", () => {
    output.configureOutput({ format: "stream-json", verbose: false, includePartial: false });
    output.emitSessionStateChanged("requires_action");

    const line = JSON.parse(written[0]!);
    expect(line.state).toBe("requires_action");
  });
});

describe("emitStatus", () => {
  it("emits status in stream-json mode", () => {
    output.configureOutput({ format: "stream-json", verbose: false, includePartial: false });
    output.emitStatus("busy");

    const line = JSON.parse(written[0]!);
    expect(line).toMatchObject({ type: "system", subtype: "status", status: "busy" });
  });

  it("includes waitingFor", () => {
    output.configureOutput({ format: "stream-json", verbose: false, includePartial: false });
    output.emitStatus("waiting", "approve Bash");

    const line = JSON.parse(written[0]!);
    expect(line.waiting_for).toBe("approve Bash");
  });

  it("suppresses in text mode", () => {
    output.configureOutput({ format: "text", verbose: false, includePartial: false });
    output.emitStatus("busy");
    expect(written).toHaveLength(0);
  });
});

describe("emitApiRetry", () => {
  it("emits retry event when verbose", () => {
    output.configureOutput({ format: "stream-json", verbose: true, includePartial: false });
    output.emitApiRetry(429, 5000);

    const line = JSON.parse(written[0]!);
    expect(line.type).toBe("system");
    expect(line.subtype).toBe("api_retry");
    expect(line.status_code).toBe(429);
    expect(line.retry_after_ms).toBe(5000);
  });

  it("suppresses when not verbose", () => {
    output.configureOutput({ format: "stream-json", verbose: false, includePartial: false });
    output.emitApiRetry(429);
    expect(written).toHaveLength(0);
  });
});

describe("emitRateLimitEvent", () => {
  it("emits rate limit event", () => {
    output.configureOutput({ format: "stream-json", verbose: false, includePartial: false });
    output.emitRateLimitEvent({ statusCode: 429, retryAfter: "5" });

    const line = JSON.parse(written[0]!);
    expect(line.type).toBe("rate_limit_event");
    expect(line.status_code).toBe(429);
    expect(line.retry_after).toBe("5");
  });
});

describe("emitResult", () => {
  it("outputs plain text in text mode", () => {
    output.configureOutput({ format: "text", verbose: false, includePartial: false });
    output.emitResult("success", "Hello");
    expect(written[0]).toBe("Hello\n");
  });

  it("does not double newline", () => {
    output.configureOutput({ format: "text", verbose: false, includePartial: false });
    output.emitResult("success", "Hello\n");
    expect(written[0]).toBe("Hello\n");
  });

  it("outputs JSON with metadata", () => {
    output.configureOutput({ format: "json", verbose: false, includePartial: false });
    output.emitResult("success", "Hello", { durationMs: 1000, numTurns: 1, stopReason: "end_turn" });

    const line = JSON.parse(written[0]!);
    expect(line.type).toBe("result");
    expect(line.subtype).toBe("success");
    expect(line.result).toBe("Hello");
    expect(line.is_error).toBe(false);
    expect(line.duration_ms).toBe(1000);
    expect(line.stop_reason).toBe("end_turn");
  });

  it("marks errors correctly", () => {
    output.configureOutput({ format: "json", verbose: false, includePartial: false });
    output.emitResult("error", "fail");

    const line = JSON.parse(written[0]!);
    expect(line.is_error).toBe(true);
  });
});

describe("emitInit", () => {
  it("emits init with extended fields", () => {
    output.configureOutput({ format: "stream-json", verbose: false, includePartial: false });
    output.emitInit("sess-1", "/tmp", { model: "opus", claude_code_version: "2.1.0", tools: ["Bash", "Read"], permissionMode: "bypassPermissions" });

    const line = JSON.parse(written[0]!);
    expect(line).toMatchObject({
      type: "system",
      subtype: "init",
      session_id: "sess-1",
      cwd: "/tmp",
      model: "opus",
      claude_code_version: "2.1.0",
      tools: ["Bash", "Read"],
      permissionMode: "bypassPermissions",
    });
  });

  it("suppresses in text mode", () => {
    output.configureOutput({ format: "text", verbose: false, includePartial: false });
    output.emitInit("sess-1", "/tmp");
    expect(written).toHaveLength(0);
  });
});
