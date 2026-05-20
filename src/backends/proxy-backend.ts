import type * as http from "node:http";
import { ApiDebugLogger, isApiDebugEnabled } from "../api-debug.js";
import { startProxy } from "../proxy.js";
import type { Observation, ObservationBackend, BackendCapabilities } from "./types.js";

const STARTUP_BUFFER_CAP = 10_000;

/**
 * Observation backend that runs the local Anthropic proxy and converts proxy
 * callbacks into SessionController observations.
 */
export class ProxyBackend implements ObservationBackend {
  readonly capabilities: BackendCapabilities = {
    emitsAssistantMessages: false,
    emitsResults: false,
    emitsPostTurnSummary: false,
    updatesOutputState: true,
    streamsTokens: true,
  };

  private server: http.Server | null = null;
  private port: number | null = null;
  private subscriber: ((obs: Observation) => void) | null = null;
  private buffer: Observation[] = [];
  private observingStarted = false;
  private stopped = false;
  private apiDebug = isApiDebugEnabled() ? new ApiDebugLogger() : null;

  constructor(private log: (msg: string) => void = () => {}) {}

  async prepare(): Promise<void> {
    if (this.server) return;
    this.log("Starting proxy...");
    const { server, port } = await startProxy({
      onSSEEvent: (event, _path, info) => {
        this.apiDebug?.onSSEEvent(event, info);
        if (!info.observe) return;
        const p = event.parsed as Record<string, unknown> | undefined;
        this.log(`SSE: ${p?.type || event.event || "?"}`);
        this.emit({ kind: "sse", event });
      },
      onProxyError: (err: Error) => {
        this.log(`Proxy error: ${err.message}`);
        this.emit({ kind: "error", message: err.message });
      },
      onRequestStart: (m: string, p: string) => this.log(`→ ${m} ${p}`),
      onRequestEnd: (m: string, p: string, s: number) => {
        this.log(`← ${m} ${p} ${s}`);
        if (s === 429 || s === 529) this.emit({ kind: "api_retry", statusCode: s });
      },
      onRateLimit: (info) => {
        this.emit({ kind: "rate_limit", statusCode: info.statusCode, retryAfter: info.retryAfter });
      },
      onRequestBody: (body, path, info) => {
        this.apiDebug?.onRequestBody(body, path, info);
      },
    });
    this.server = server;
    this.port = port;
    this.stopped = false;
    this.log(`Proxy on 127.0.0.1:${port}`);
  }

  getClaudeEnv(): Record<string, string> {
    if (this.port == null) throw new Error("ProxyBackend.getClaudeEnv() called before prepare()");
    return { ANTHROPIC_BASE_URL: `http://127.0.0.1:${this.port}` };
  }

  async startObserving(_opts: { transcriptPath?: string }): Promise<void> {
    if (this.observingStarted) return;
    this.observingStarted = true;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const server = this.server;
    this.server = null;
    this.port = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  onObservation(cb: (obs: Observation) => void): void {
    if (this.subscriber) throw new Error("ProxyBackend only supports one observation subscriber");
    this.subscriber = cb;
    const buffered = this.buffer;
    this.buffer = [];
    for (const obs of buffered) cb(obs);
  }

  private emit(obs: Observation): void {
    if (this.subscriber) {
      this.subscriber(obs);
      return;
    }
    if (this.buffer.length >= STARTUP_BUFFER_CAP) {
      throw new Error(`ProxyBackend startup observation buffer exceeded ${STARTUP_BUFFER_CAP}`);
    }
    this.buffer.push(obs);
  }
}
