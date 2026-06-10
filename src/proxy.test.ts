import * as http from "node:http";
import type * as net from "node:net";
import { afterEach, describe, it, expect } from "vitest";
import { extractSSEEvents, createProxy, startProxy, type ProxyCallbacks } from "./proxy.js";

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

function makeCallbacks(overrides: Partial<ProxyCallbacks> = {}): ProxyCallbacks {
  return {
    onSSEEvent: () => {},
    onProxyError: () => {},
    onRequestStart: () => {},
    onRequestEnd: () => {},
    ...overrides,
  };
}

function startFakeUpstream(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => handler(req, res));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe("createProxy upstream failure handling", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  async function startTestProxy(callbacks: ProxyCallbacks, upstreamBaseUrl: string): Promise<number> {
    const { server, port } = await startProxy(callbacks, { upstreamBaseUrl });
    cleanups.push(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));
    return port;
  }

  function postToProxy(
    port: number,
    path: string,
    body: string,
  ): Promise<{ statusCode: number; raw: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: "127.0.0.1", port, path, method: "POST", headers: { "Content-Type": "application/json" } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve({ statusCode: res.statusCode || 0, raw: Buffer.concat(chunks).toString("utf8") }));
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  }

  it("responds 502 with a JSON error when the upstream is unreachable before headers", async () => {
    const errors: Error[] = [];
    // Port 1 on loopback is essentially guaranteed closed.
    const port = await startTestProxy(
      makeCallbacks({ onProxyError: (e) => errors.push(e) }),
      "http://127.0.0.1:1",
    );

    const res = await postToProxy(port, "/v1/messages", "{}");

    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.raw).error.type).toBe("proxy_error");
    expect(errors.length).toBeGreaterThan(0);
  });

  it("severs the connection on mid-stream upstream failure without fabricating bytes", async () => {
    const ssePart = 'event: message_start\ndata: {"type":"message_start"}\n\n';
    const upstream = await startFakeUpstream((req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(ssePart);
      setTimeout(() => req.socket.destroy(), 20);
    });
    cleanups.push(upstream.close);
    const errors: Error[] = [];
    const port = await startTestProxy(
      makeCallbacks({ onProxyError: (e) => errors.push(e) }),
      upstream.url,
    );

    // Collect whatever arrives and record HOW the stream terminated — a clean
    // `end` would mean the proxy gracefully closed (wrong); severance must
    // surface as `aborted`/`error` (the socket dying under the client).
    const outcome = await new Promise<{ body: string; terminal: string }>((resolve, reject) => {
      const req = http.request(
        { hostname: "127.0.0.1", port, path: "/v1/messages", method: "POST" },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          const done = (terminal: string) => resolve({ body: Buffer.concat(chunks).toString("utf8"), terminal });
          res.on("end", () => done("end"));
          res.on("error", () => done("error"));
          res.on("aborted", () => done("aborted"));
        },
      );
      req.on("error", reject);
      req.end("{}");
    }).catch(() => ({ body: "request-errored-before-headers", terminal: "pre-headers" }));

    // Claude received exactly the upstream bytes — no appended JSON blob.
    expect(outcome.body === ssePart || outcome.body === "request-errored-before-headers").toBe(true);
    expect(outcome.body).not.toContain("proxy_error");
    // The connection was severed, not gracefully ended after the partial SSE.
    expect(outcome.terminal).not.toBe("end");
    expect(errors.length).toBeGreaterThan(0);
  });

  it("decodes observed SSE through a persistent decoder when UTF-8 splits across chunks", async () => {
    // A grinning-face emoji (U+1F600 → F0 9F 98 80) deliberately split so the
    // first network chunk ends mid-character. Naive per-chunk toString("utf8")
    // would yield replacement chars in clarp's observed stream.
    const line = Buffer.from('event: x\ndata: {"text":"😀"}\n\n', "utf8");
    const splitAt = line.indexOf(0xf0) + 2; // 2 of the emoji's 4 bytes
    const upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(line.subarray(0, splitAt));
      setTimeout(() => {
        res.write(line.subarray(splitAt));
        res.end();
      }, 10);
    });
    cleanups.push(upstream.close);

    const observed: string[] = [];
    const port = await startTestProxy(
      makeCallbacks({ onSSEEvent: (evt) => observed.push(evt.data) }),
      upstream.url,
    );

    await postToProxy(port, "/v1/messages", JSON.stringify({ model: "m", stream: true, messages: [] }));

    expect(observed).toHaveLength(1);
    expect(JSON.parse(observed[0]!).text).toBe("😀");
    expect(observed[0]).not.toContain("�");
  });

  it("does not warn about non-SSE responses unless the request asked to stream", async () => {
    const upstream = await startFakeUpstream((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"input_tokens":42}');
    });
    cleanups.push(upstream.close);
    const errors: Error[] = [];
    const port = await startTestProxy(
      makeCallbacks({ onProxyError: (e) => errors.push(e) }),
      upstream.url,
    );

    // count_tokens-style request: JSON 200 is the healthy response.
    await postToProxy(port, "/v1/messages/count_tokens", JSON.stringify({ model: "m", messages: [] }));
    expect(errors).toHaveLength(0);

    // stream: false request: JSON 200 is also healthy.
    await postToProxy(port, "/v1/messages", JSON.stringify({ model: "m", stream: false, messages: [] }));
    expect(errors).toHaveLength(0);

    // A request that asked to stream getting JSON back IS anomalous.
    await postToProxy(port, "/v1/messages", JSON.stringify({ model: "m", stream: true, messages: [] }));
    expect(errors.map((e) => e.message)).toEqual([
      "Expected SSE but got content-type: application/json",
    ]);
  });
});
