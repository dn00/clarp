import { describe, it, expect } from "vitest";
import { extractSSEEvents, createProxy, type SSEEvent } from "./proxy.js";

describe("extractSSEEvents", () => {
  it("parses a single complete event", () => {
    const input = 'event: message_start\ndata: {"type":"message_start"}\n\n';
    const result = extractSSEEvents(input);

    expect(result.complete).toHaveLength(1);
    expect(result.complete[0]!.event).toBe("message_start");
    expect(result.complete[0]!.parsed).toEqual({ type: "message_start" });
    expect(result.remainder).toBe("");
  });

  it("parses multiple events in one buffer", () => {
    const input =
      'event: content_block_start\ndata: {"type":"content_block_start","index":0}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n';
    const result = extractSSEEvents(input);

    expect(result.complete).toHaveLength(2);
    expect(result.complete[0]!.event).toBe("content_block_start");
    expect(result.complete[1]!.event).toBe("content_block_delta");
    expect((result.complete[1]!.parsed as any).delta.text).toBe("Hi");
  });

  it("holds incomplete events as remainder", () => {
    const input = 'event: message_start\ndata: {"type":"mes';
    const result = extractSSEEvents(input);

    expect(result.complete).toHaveLength(0);
    expect(result.remainder).toBe('event: message_start\ndata: {"type":"mes');
  });

  it("handles partial then complete across calls", () => {
    const chunk1 = 'event: ping\ndata: {"type":';
    const r1 = extractSSEEvents(chunk1);
    expect(r1.complete).toHaveLength(0);

    const chunk2 = r1.remainder + '"ping"}\n\n';
    const r2 = extractSSEEvents(chunk2);
    expect(r2.complete).toHaveLength(1);
    expect(r2.complete[0]!.event).toBe("ping");
    expect(r2.complete[0]!.parsed).toEqual({ type: "ping" });
  });

  it("handles data without event field", () => {
    const input = 'data: {"type":"message_stop"}\n\n';
    const result = extractSSEEvents(input);

    expect(result.complete).toHaveLength(1);
    expect(result.complete[0]!.event).toBeUndefined();
    expect(result.complete[0]!.parsed).toEqual({ type: "message_stop" });
  });

  it("handles multi-line data fields", () => {
    const input = 'event: test\ndata: {"line":\ndata: "value"}\n\n';
    const result = extractSSEEvents(input);

    expect(result.complete).toHaveLength(1);
    expect(result.complete[0]!.data).toBe('{"line":\n"value"}');
  });

  it("skips empty blocks between events", () => {
    const input =
      'event: a\ndata: {"t":"a"}\n\n\n\nevent: b\ndata: {"t":"b"}\n\n';
    const result = extractSSEEvents(input);

    expect(result.complete).toHaveLength(2);
    expect((result.complete[0]!.parsed as any).t).toBe("a");
    expect((result.complete[1]!.parsed as any).t).toBe("b");
  });

  it("handles non-JSON data gracefully", () => {
    const input = "event: ping\ndata: not json\n\n";
    const result = extractSSEEvents(input);

    expect(result.complete).toHaveLength(1);
    expect(result.complete[0]!.data).toBe("not json");
    expect(result.complete[0]!.parsed).toBeUndefined();
  });

  it("handles data: with no space after colon", () => {
    const input = 'data:{"type":"ping"}\n\n';
    const result = extractSSEEvents(input);

    expect(result.complete).toHaveLength(1);
    expect(result.complete[0]!.parsed).toEqual({ type: "ping" });
  });

  it("returns empty for empty input", () => {
    const result = extractSSEEvents("");
    expect(result.complete).toHaveLength(0);
    expect(result.remainder).toBe("");
  });

  it("handles realistic Anthropic SSE sequence", () => {
    // Each SSE event is terminated by \n\n — the join('\n') produces
    // the correct format because empty strings between events create \n\n
    const input = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_01","role":"assistant","content":[]}}\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n',
      'event: ping\ndata: {"type":"ping"}\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n',
      '', // trailing empty line creates the final \n\n
    ].join('\n');

    const result = extractSSEEvents(input);

    expect(result.complete).toHaveLength(7);
    const types = result.complete.map(e => (e.parsed as any)?.type);
    expect(types).toEqual([
      "message_start",
      "content_block_start",
      "ping",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect((result.complete[3]!.parsed as any).delta.text).toBe("Hello");
  });
});

describe("createProxy callbacks", () => {
  it("onRequestBody callback signature exists in type", () => {
    const server = createProxy({
      onSSEEvent: () => {},
      onProxyError: () => {},
      onRequestStart: () => {},
      onRequestEnd: () => {},
      onRequestBody: (body, path) => {
        expect(typeof path).toBe("string");
        expect(typeof body).toBe("object");
      },
    });
    server.close();
  });
});
