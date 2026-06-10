import * as http from "node:http";
import * as https from "node:https";
import { StringDecoder } from "node:string_decoder";
import { URL } from "node:url";
import type { ProxyRequestInfo } from "./api-debug.js";
import { shouldObserveMessagesRequest } from "./message-request-filter.js";

export type SSEEvent = {
  event?: string;
  data: string;
  parsed?: unknown;
};

/**
 * Hooks used by observation backends to mirror upstream Anthropic traffic into
 * clarp's output pipeline without changing the bytes sent back to Claude.
 */
export type ProxyCallbacks = {
  onSSEEvent: (event: SSEEvent, requestPath: string, info: ProxyRequestInfo) => void;
  onProxyError: (error: Error) => void;
  onRequestStart: (method: string, path: string) => void;
  onRequestEnd: (method: string, path: string, statusCode: number) => void;
  onRateLimit?: (info: { statusCode: number; retryAfter?: string; path: string }) => void;
  onRequestBody?: (body: Record<string, unknown>, path: string, info: ProxyRequestInfo) => void;
};

const UPSTREAM = "https://api.anthropic.com";
const DEFAULT_UPSTREAM_TIMEOUT_MS = 120_000;
let nextProxyRequestId = 0;

/**
 * Creates a loopback HTTP proxy that forwards Claude's Anthropic API requests
 * upstream and tees message SSE events to callbacks.
 */
export function createProxy(
  callbacks: ProxyCallbacks,
  opts: { upstreamTimeoutMs?: number; upstreamBaseUrl?: string } = {},
): http.Server {
  const upstreamTimeoutMs = opts.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
  // upstreamBaseUrl is a test-only override; an http:// fake upstream is supported.
  const upstreamBase = new URL(opts.upstreamBaseUrl ?? UPSTREAM);
  const transport = upstreamBase.protocol === "http:" ? http : https;
  const upstreamPort = upstreamBase.port
    ? Number(upstreamBase.port)
    : upstreamBase.protocol === "http:" ? 80 : 443;
  return http.createServer((clientReq, clientRes) => {
    const reqPath = clientReq.url || "/";
    const method = clientReq.method || "GET";
    const requestId = String(++nextProxyRequestId);
    callbacks.onRequestStart(method, reqPath);

    const upstream = new URL(reqPath, upstreamBase);
    const forwardHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(clientReq.headers)) {
      if (key === "host" || key === "connection" || key === "accept-encoding") continue;
      if (value !== undefined) {
        forwardHeaders[key] = Array.isArray(value) ? value.join(", ") : value;
      }
    }
    forwardHeaders["host"] = upstream.hostname;

    const bodyChunks: Buffer[] = [];
    clientReq.on("data", (chunk: Buffer) => bodyChunks.push(chunk));
    clientReq.on("end", () => {
      const body = Buffer.concat(bodyChunks);
      let observeMessagesSSE = reqPath.startsWith("/v1/messages");
      const requestInfo: ProxyRequestInfo = { requestId, observe: observeMessagesSSE };
      // Only a request that asked to stream makes a non-SSE 200 anomalous —
      // count_tokens and stream:false calls legitimately return JSON.
      let requestedStream = false;
      if (observeMessagesSSE && body.length > 0) {
        try {
          const parsedBody = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
          observeMessagesSSE = shouldObserveMessagesRequest(parsedBody);
          requestInfo.observe = observeMessagesSSE;
          requestedStream = parsedBody.stream === true;
          callbacks.onRequestBody?.(parsedBody, reqPath, requestInfo);
        } catch {}
      }
      let upstreamDone = false;
      const upstreamReq = transport.request(
        {
          hostname: upstream.hostname,
          port: upstreamPort,
          path: upstream.pathname + upstream.search,
          method,
          headers: forwardHeaders,
        },
        (upstreamRes) => {
          const statusCode = upstreamRes.statusCode || 502;
          callbacks.onRequestEnd(method, reqPath, statusCode);

          if (statusCode === 429 || statusCode === 529) {
            callbacks.onRateLimit?.({
              statusCode,
              retryAfter: upstreamRes.headers["retry-after"] as string | undefined,
              path: reqPath,
            });
          }

          clientRes.writeHead(statusCode, upstreamRes.headers);

          // Mid-stream upstream death surfaces on the RESPONSE stream, not the
          // request — and an unhandled 'error' here would crash the process.
          // Headers are already out, so sever the client connection: never
          // leave Claude hanging and never append bytes the upstream did not send.
          const onUpstreamResFailure = (err?: Error): void => {
            if (upstreamDone) return;
            upstreamDone = true;
            callbacks.onProxyError(err ?? new Error("Upstream response aborted before completion"));
            if (!clientRes.destroyed) clientRes.destroy();
          };
          upstreamRes.on("error", onUpstreamResFailure);
          upstreamRes.on("aborted", () => onUpstreamResFailure());

          const isMessages = reqPath.startsWith("/v1/messages");
          const contentType = upstreamRes.headers["content-type"] || "";
          const isSSE = contentType.includes("text/event-stream");

          if (isMessages && statusCode === 200 && requestedStream && !isSSE) {
            callbacks.onProxyError(new Error(`Expected SSE but got content-type: ${contentType}`));
          }

          if (isMessages && isSSE) {
            let sseBuf = "";
            // Decode through a persistent StringDecoder so a multibyte UTF-8
            // char split across network chunks isn't corrupted in clarp's
            // observed stream. The raw bytes Claude receives are untouched —
            // clientRes.write(chunk) forwards them before any decoding.
            const decoder = new StringDecoder("utf8");
            upstreamRes.on("data", (chunk: Buffer) => {
              if (!clientRes.write(chunk)) {
                upstreamRes.pause();
                clientRes.once("drain", () => upstreamRes.resume());
              }
              sseBuf += decoder.write(chunk);
              const result = extractSSEEvents(sseBuf);
              sseBuf = result.remainder;
              for (const evt of result.complete) {
                callbacks.onSSEEvent(evt, reqPath, requestInfo);
              }
            });
            upstreamRes.on("end", () => {
              upstreamDone = true;
              sseBuf += decoder.end();
              if (sseBuf.trim().length > 0) {
                const result = extractSSEEvents(sseBuf + "\n\n");
                for (const evt of result.complete) {
                  callbacks.onSSEEvent(evt, reqPath, requestInfo);
                }
              }
              clientRes.end();
            });
          } else {
            upstreamRes.on("end", () => { upstreamDone = true; });
            upstreamRes.pipe(clientRes);
          }
        },
      );

      const destroyUpstream = (reason: Error): void => {
        if (!upstreamDone && !upstreamReq.destroyed) {
          upstreamReq.destroy(reason);
        }
      };

      // Destroy upstream work when the caller disconnects or Anthropic stalls,
      // otherwise a dead client can leave sockets pinned indefinitely.
      upstreamReq.setTimeout(upstreamTimeoutMs, () => {
        destroyUpstream(new Error(`Upstream request timed out after ${upstreamTimeoutMs}ms`));
      });

      clientReq.on("aborted", () => {
        destroyUpstream(new Error("Client request aborted"));
      });
      clientRes.on("close", () => {
        if (!clientRes.writableEnded) {
          destroyUpstream(new Error("Client response closed before upstream completed"));
        }
      });

      upstreamReq.on("error", (err) => {
        if (upstreamDone) return;
        upstreamDone = true;
        callbacks.onProxyError(err);
        if (clientRes.destroyed) return;
        if (clientRes.headersSent) {
          // The upstream's response already started flowing to Claude. Never
          // append bytes the upstream did not send — sever the connection so
          // the failure is abrupt, not fabricated.
          clientRes.destroy();
          return;
        }
        clientRes.writeHead(502, { "Content-Type": "application/json" });
        clientRes.end(JSON.stringify({ error: { type: "proxy_error", message: err.message } }));
      });

      if (body.length > 0) upstreamReq.write(body);
      upstreamReq.end();
    });
  });
}

/**
 * Extracts complete Server-Sent Event blocks and returns any trailing partial
 * block so callers can parse across arbitrary network chunks.
 */
export function extractSSEEvents(buffer: string): { complete: SSEEvent[]; remainder: string } {
  const complete: SSEEvent[] = [];
  const blocks = buffer.split("\n\n");
  const remainder = blocks.pop() || "";

  for (const block of blocks) {
    if (block.trim().length === 0) continue;
    let eventType: string | undefined;
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) eventType = line.slice(7).trim();
      else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
      else if (line.startsWith("data:")) dataLines.push(line.slice(5));
    }
    if (dataLines.length > 0) {
      const data = dataLines.join("\n");
      let parsed: unknown;
      try { parsed = JSON.parse(data); } catch {}
      complete.push({ event: eventType, data, parsed });
    }
  }
  return { complete, remainder };
}

/**
 * Starts the local proxy on a random loopback port.
 */
export function startProxy(
  callbacks: ProxyCallbacks,
  opts: { upstreamTimeoutMs?: number; upstreamBaseUrl?: string } = {},
): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createProxy(callbacks, opts);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") return reject(new Error("Failed to get proxy address"));
      resolve({ server, port: addr.port });
    });
    server.on("error", reject);
  });
}
