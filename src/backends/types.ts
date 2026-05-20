import type { SSEEvent } from "../proxy.js";

/**
 * Normalized observations produced by backend implementations.
 */
export type Observation =
  | { kind: "sse"; event: SSEEvent }
  | { kind: "transcript_line"; line: Record<string, unknown> }
  | { kind: "rate_limit"; statusCode: number; retryAfter?: string }
  | { kind: "api_retry"; statusCode: number }
  | { kind: "error"; message: string };

export type BackendCapabilities = {
  emitsAssistantMessages: boolean;
  emitsResults: boolean;
  emitsPostTurnSummary: boolean;
  updatesOutputState: boolean;
  streamsTokens: boolean;
};

/**
 * Pluggable source of Claude observations. The default backend is the local
 * Anthropic proxy, but transcript-based backends can implement the same shape.
 */
export interface ObservationBackend {
  readonly capabilities: BackendCapabilities;
  prepare(): Promise<void>;
  getClaudeEnv(): Record<string, string>;
  startObserving(opts: { transcriptPath?: string }): Promise<void>;
  stop(): Promise<void>;
  onObservation(cb: (obs: Observation) => void): void;
}
