import type { SSEEvent } from "./proxy.js";
import { MessageAssembler, type AssembledMessage, type ContextUsage } from "./message-assembler.js";

export type OutputFormat = "text" | "json" | "stream-json";

let format: OutputFormat = "stream-json";
let verbose = false;
let includePartial = false;
let replayUserMessages = false;
let accumulatedText = "";
let lastResponseText = "";
let inMessage = false;
let currentMessageText = "";
let sessionId = "";

const MAX_ACCUMULATED_TEXT_CHARS = 1_000_000;

const assembler = new MessageAssembler((msg) => {
  if (format === "stream-json" && verbose) {
    writeLine({
      type: "assistant",
      message: { role: msg.role, content: msg.content, model: msg.model, stop_reason: msg.stop_reason, usage: msg.usage },
      session_id: sessionId,
    });
  }
});

/**
 * Returns the last assembled tool_use block for permission forwarding.
 */
export function getLastToolUse(): { id: string; name: string; input: unknown } | null {
  return assembler.getLastToolUse();
}

/**
 * Returns the latest context usage observed from upstream SSE events.
 */
export function getContextUsage(): ContextUsage {
  return assembler.getContextUsage();
}

/**
 * Configures output formatting for the current process invocation.
 */
export function configureOutput(opts: {
  format: OutputFormat;
  verbose: boolean;
  includePartial: boolean;
  replayUserMessages?: boolean;
}): void {
  format = opts.format;
  verbose = opts.verbose;
  includePartial = opts.includePartial;
  replayUserMessages = opts.replayUserMessages ?? false;
}

function writeLine(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

export function getSessionId(): string { return sessionId; }
export function getAccumulatedText(): string { return lastResponseText || accumulatedText; }
export function resetAccumulatedText(): void { accumulatedText = ""; lastResponseText = ""; }
/**
 * Clears all module-level output state. Useful for tests and clean session starts.
 */
export function resetOutputState(): void {
  accumulatedText = "";
  lastResponseText = "";
  inMessage = false;
  currentMessageText = "";
  sessionId = "";
  assembler.reset();
}

function appendCapped(current: string, next: string): string {
  // Long-running stream-json sessions should not retain unlimited text history.
  const combined = current + next;
  return combined.length > MAX_ACCUMULATED_TEXT_CHARS
    ? combined.slice(combined.length - MAX_ACCUMULATED_TEXT_CHARS)
    : combined;
}

/**
 * Emits or accumulates one upstream SSE event according to the selected format.
 */
export function emitSSE(event: SSEEvent): void {
  if (event.parsed && typeof event.parsed === "object") {
    const p = event.parsed as Record<string, unknown>;

    // Assemble complete messages
    assembler.processSSE(event);

    if (p.type === "message_start") {
      inMessage = true;
      currentMessageText = "";
    }
    if (p.type === "content_block_delta") {
      const delta = (p as { delta?: { type?: string; text?: string } }).delta;
      if (delta?.type === "text_delta" && delta.text) {
        accumulatedText = appendCapped(accumulatedText, delta.text);
        currentMessageText = appendCapped(currentMessageText, delta.text);
      }
    }
    if (p.type === "message_stop") {
      if (currentMessageText.length > 0) {
        lastResponseText = currentMessageText;
      }
      inMessage = false;
    }
  }

  if (format !== "stream-json") return;

  if (event.parsed && typeof event.parsed === "object") {
    const p = event.parsed as Record<string, unknown>;

    // Don't emit raw assistant/user — the assembler handles these
    if (p.type === "assistant" || p.type === "user") return;

    const streamTypes = ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"];
    if (streamTypes.includes(p.type as string)) {
      if (includePartial) {
        writeLine({ type: "stream_event", event: p, session_id: sessionId });
      }
      return;
    }

    if (verbose) writeLine(p);
  }
}

/**
 * Emits a replayed user message when the caller requested input echoing.
 */
export function emitUserReplay(content: string): void {
  if (!replayUserMessages || format !== "stream-json") return;
  writeLine({
    type: "user",
    message: { role: "user", content },
    session_id: sessionId,
  });
}

/**
 * Emits the synthetic user event native claude -p writes when a turn is
 * interrupted through stream-json control.
 */
export function emitInterruptedUserMessage(): void {
  if (format !== "stream-json") return;
  writeLine({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
    parent_tool_use_id: null,
    session_id: sessionId,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Emits Claude's current busy/idle/waiting status as a system event.
 */
export function emitStatus(status: string, waitingFor?: string): void {
  if (format !== "stream-json") return;
  const msg: Record<string, unknown> = { type: "system", subtype: "status", status };
  if (waitingFor) msg.waiting_for = waitingFor;
  msg.session_id = sessionId;
  writeLine(msg);
}

/**
 * Emits the normalized session state used by stream-json clients.
 */
export function emitSessionStateChanged(state: "idle" | "running" | "requires_action"): void {
  if (format !== "stream-json") return;
  writeLine({
    type: "system",
    subtype: "session_state_changed",
    state,
    session_id: sessionId,
  });
}

/**
 * Extra metadata from Claude's transcript init event.
 */
export type InitData = {
  model?: string;
  tools?: string[];
  mcp_servers?: Array<{ name: string; status: string }>;
  permissionMode?: string;
  slash_commands?: string[];
  claude_code_version?: string;
  output_style?: string;
  agents?: string[];
  skills?: string[];
  plugins?: string[];
  fast_mode_state?: string;
  memory_paths?: Record<string, string>;
  apiKeySource?: string;
};

/**
 * Emits a system init event and records the active session ID.
 */
export function emitInit(sid: string, cwd: string, data?: InitData): void {
  sessionId = sid;
  if (format !== "stream-json") return;
  writeLine({
    type: "system",
    subtype: "init",
    session_id: sid,
    cwd,
    tools: data?.tools ?? [],
    mcp_servers: data?.mcp_servers ?? [],
    model: data?.model ?? "unknown",
    permissionMode: data?.permissionMode ?? "default",
    slash_commands: data?.slash_commands ?? [],
    apiKeySource: data?.apiKeySource ?? "none",
    claude_code_version: data?.claude_code_version ?? "unknown",
    output_style: data?.output_style ?? "default",
    agents: data?.agents ?? [],
    skills: data?.skills ?? [],
    plugins: data?.plugins ?? [],
    fast_mode_state: data?.fast_mode_state ?? "off",
    ...(data?.memory_paths ? { memory_paths: data.memory_paths } : {}),
  });
}

/**
 * Emits a tool execution result the way native claude -p does: a user event
 * carrying the tool_result message plus the raw tool_use_result payload.
 * Input is a transcript JSONL user line (camelCase toolUseResult).
 */
export function emitUserToolResult(line: Record<string, unknown>): void {
  const sid = typeof line.sessionId === "string" ? line.sessionId : "";
  if (sid) sessionId = sid;
  if (format !== "stream-json") return;
  writeLine({
    type: "user",
    message: line.message,
    parent_tool_use_id: null,
    session_id: sid || sessionId,
    ...(typeof line.uuid === "string" ? { uuid: line.uuid } : {}),
    ...(typeof line.timestamp === "string" ? { timestamp: line.timestamp } : {}),
    ...(line.toolUseResult !== undefined ? { tool_use_result: line.toolUseResult } : {}),
  });
}

/**
 * Forwards a parsed transcript JSONL event without reshaping it.
 */
export function emitTranscriptEvent(event: Record<string, unknown>): void {
  const sid = event.session_id as string;
  if (sid) sessionId = sid;
  if (format !== "stream-json") return;
  writeLine(event);
}

/**
 * Emits a retry notification derived from upstream API status.
 */
export function emitApiRetry(statusCode: number, retryAfterMs?: number): void {
  if (format !== "stream-json" || !verbose) return;
  writeLine({
    type: "system",
    subtype: "api_retry",
    status_code: statusCode,
    ...(retryAfterMs != null ? { retry_after_ms: retryAfterMs } : {}),
    session_id: sessionId,
  });
}

/**
 * Emits rate-limit metadata observed on the upstream response.
 */
export function emitRateLimitEvent(info: { statusCode: number; retryAfter?: string; limitType?: string }): void {
  if (format !== "stream-json") return;
  writeLine({
    type: "rate_limit_event",
    status_code: info.statusCode,
    ...(info.retryAfter ? { retry_after: info.retryAfter } : {}),
    ...(info.limitType ? { limit_type: info.limitType } : {}),
    session_id: sessionId,
  });
}

/**
 * Emits a can_use_tool request that stream-json clients can answer on stdin.
 */
export function emitControlRequest(requestId: string, toolName: string, toolUseId: string, input: unknown, description?: string): void {
  if (format !== "stream-json") return;
  writeLine({
    type: "control_request",
    request_id: requestId,
    request: {
      subtype: "can_use_tool",
      tool_name: toolName,
      input,
      tool_use_id: toolUseId,
      ...(description ? { description } : {}),
    },
    session_id: sessionId,
  });
}

/**
 * Emits the success acknowledgement native claude -p writes for accepted
 * control requests (interrupt, initialize, set_permission_mode, ...).
 * Native nests request_id and any payload inside `response`:
 *   {type, response: {subtype: "success", request_id, response: {...}}}
 */
export function emitControlResponseSuccess(requestId?: string, payload?: Record<string, unknown>): void {
  if (format !== "stream-json") return;
  writeLine({
    type: "control_response",
    response: {
      subtype: "success",
      ...(requestId ? { request_id: requestId } : {}),
      ...(payload ? { response: payload } : {}),
    },
  });
}

/**
 * Emits a post-turn summary when Claude did not provide one directly.
 */
export function emitPostTurnSummary(opts: {
  summarizesUuid?: string;
  statusCategory: "completed" | "blocked" | "waiting" | "failed" | "review_ready";
  statusDetail: string;
  title: string;
  description: string;
  recentAction: string;
  needsAction: string;
  isNoteworthy?: boolean;
  artifactUrls?: string[];
}): void {
  if (format !== "stream-json") return;
  writeLine({
    type: "system",
    subtype: "post_turn_summary",
    summarizes_uuid: opts.summarizesUuid ?? "",
    status_category: opts.statusCategory,
    status_detail: opts.statusDetail,
    is_noteworthy: opts.isNoteworthy ?? false,
    title: opts.title,
    description: opts.description,
    recent_action: opts.recentAction,
    needs_action: opts.needsAction,
    artifact_urls: opts.artifactUrls ?? [],
    session_id: sessionId,
  });
}

/**
 * Emits the final result for a turn or process exit.
 */
export function emitResult(
  subtype: "success" | "error" | "error_during_execution" | "error_max_turns",
  result: string | null,
  meta?: {
    costUsd?: number;
    durationMs?: number;
    numTurns?: number;
    stopReason?: string | null;
    apiErrorStatus?: number;
    terminalReason?: string;
    errors?: string[];
    // Native decouples is_error from subtype: e.g. an invalid model yields
    // subtype "success" with is_error true. Default keeps the subtype-derived
    // value for callers that don't care.
    isError?: boolean;
  },
): void {
  const msg: Record<string, unknown> = {
    type: "result", subtype,
    // Native omits the `result` field entirely for error_max_turns.
    ...(result !== null ? { result } : {}),
    is_error: meta?.isError ?? subtype !== "success",
    session_id: sessionId,
    ...(meta?.costUsd != null ? { cost_usd: meta.costUsd } : {}),
    ...(meta?.durationMs != null ? { duration_ms: meta.durationMs } : {}),
    ...(meta?.numTurns != null ? { num_turns: meta.numTurns } : {}),
    ...(meta && "stopReason" in meta ? { stop_reason: meta.stopReason ?? null } : {}),
    ...(meta?.apiErrorStatus != null ? { api_error_status: meta.apiErrorStatus } : {}),
    ...(meta?.terminalReason ? { terminal_reason: meta.terminalReason } : {}),
    ...(meta?.errors ? { errors: meta.errors } : {}),
  };
  if (format === "text") {
    if (result) process.stdout.write(result.endsWith("\n") ? result : result + "\n");
  } else {
    writeLine(msg);
  }
}
