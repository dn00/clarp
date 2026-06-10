export type ApiErrorInfo = {
  status?: number;
  message: string;
  retryAttempt?: number;
  maxRetries?: number;
  retryInMs?: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getTextContent(message: Record<string, unknown>): string {
  const content = message.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const b = asRecord(block);
      return typeof b?.text === "string" ? b.text : "";
    })
    .filter(Boolean)
    .join("");
}

export function isTranscriptApiError(event: Record<string, unknown>): boolean {
  return event.type === "system" && event.subtype === "api_error";
}

/**
 * Matches transcript user lines that carry a tool execution result — the
 * source for the `user` events native claude -p emits after each tool runs.
 */
export function isTranscriptToolResultUserLine(event: Record<string, unknown>): boolean {
  if (event.type !== "user" || event.isSidechain === true) return false;
  const message = asRecord(event.message);
  const content = message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => asRecord(block)?.type === "tool_result");
}

export function isTranscriptApiErrorMessage(event: Record<string, unknown>): boolean {
  return event.type === "assistant" && event.isApiErrorMessage === true;
}

export function getTranscriptAssistantText(event: Record<string, unknown>): string {
  const message = asRecord(event.message);
  return message ? getTextContent(message).trim() : "";
}

export function getTranscriptApiErrorInfo(event: Record<string, unknown>): ApiErrorInfo | null {
  if (!isTranscriptApiError(event)) return null;

  const error = asRecord(event.error);
  const nestedError = asRecord(error?.error);
  const apiError = asRecord(nestedError?.error);
  const message =
    (typeof apiError?.message === "string" && apiError.message) ||
    (typeof nestedError?.message === "string" && nestedError.message) ||
    (typeof error?.message === "string" && error.message) ||
    (typeof error?.type === "string" && error.type) ||
    "API error";

  return {
    status: asNumber(error?.status),
    message,
    retryAttempt: asNumber(event.retryAttempt),
    maxRetries: asNumber(event.maxRetries),
    retryInMs: asNumber(event.retryInMs),
  };
}

export function formatTranscriptApiError(info: ApiErrorInfo): string {
  const status = info.status != null ? `${info.status} ` : "";
  return `API Error: ${status}${info.message}.`;
}

export function formatTranscriptApiRetry(info: ApiErrorInfo): string {
  const base = formatTranscriptApiError(info);
  const attempt = info.retryAttempt != null && info.maxRetries != null
    ? `attempt ${info.retryAttempt}/${info.maxRetries}`
    : "";
  const delay = info.retryInMs != null
    ? `retrying in ${Math.max(0, Math.round(info.retryInMs / 1000))}s`
    : "";
  const suffix = [delay, attempt].filter(Boolean).join(", ");
  return suffix ? `${base} ${suffix}.` : base;
}

export function isRetryExhausted(info: ApiErrorInfo): boolean {
  return info.retryAttempt != null && info.maxRetries != null && info.retryAttempt >= info.maxRetries;
}
