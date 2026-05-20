import { createHash } from "node:crypto";
import type { SSEEvent } from "./proxy.js";

export type ProxyRequestInfo = {
  requestId: string;
  observe: boolean;
};

type RequestState = {
  text: string;
  sawMessageStart: boolean;
};

const MAX_PREVIEW_CHARS = 160;

export function isApiDebugEnabled(): boolean {
  const value = process.env.CLARP_DEBUG_API?.toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function isApiDebugTextEnabled(): boolean {
  const value = process.env.CLARP_DEBUG_API_TEXT?.toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export class ApiDebugLogger {
  private requests = new Map<string, RequestState>();
  private includeText = isApiDebugTextEnabled();

  constructor(private write: (line: string) => void = (line) => process.stderr.write(line + "\n")) {}

  onRequestBody(body: Record<string, unknown>, path: string, info: ProxyRequestInfo): void {
    this.requests.set(info.requestId, { text: "", sawMessageStart: false });
    const systemText = extractText(body.system);
    const firstUser = firstUserText(body.messages);
    this.writeJson({
      kind: "api_request",
      request_id: info.requestId,
      path,
      observed: info.observe,
      model: stringValue(body.model),
      max_tokens: numberValue(body.max_tokens),
      messages: Array.isArray(body.messages) ? body.messages.length : null,
      system_blocks: Array.isArray(body.system) ? body.system.length : typeof body.system === "string" ? 1 : 0,
      tools: Array.isArray(body.tools) ? body.tools.length : 0,
      output_config: summarizeOutputConfig(body.output_config),
      system_text: summarizeText(systemText, this.includeText),
      first_user_text: summarizeText(firstUser, this.includeText),
    });
  }

  onSSEEvent(event: SSEEvent, info: ProxyRequestInfo): void {
    const state = this.requests.get(info.requestId);
    if (!state || !event.parsed || typeof event.parsed !== "object") return;
    const parsed = event.parsed as Record<string, unknown>;
    if (parsed.type === "message_start") {
      state.sawMessageStart = true;
      return;
    }
    if (parsed.type === "content_block_delta") {
      const delta = parsed.delta as Record<string, unknown> | undefined;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        state.text = appendPreview(state.text, delta.text);
      }
      return;
    }
    if (parsed.type === "message_stop") {
      this.writeJson({
        kind: "api_response",
        request_id: info.requestId,
        observed: info.observe,
        saw_message_start: state.sawMessageStart,
        assistant_text: summarizeText(state.text, this.includeText),
      });
      this.requests.delete(info.requestId);
    }
  }

  private writeJson(obj: Record<string, unknown>): void {
    this.write("[clarp-api] " + JSON.stringify(obj));
  }
}

function summarizeOutputConfig(value: unknown): unknown {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const format = obj.format && typeof obj.format === "object" ? obj.format as Record<string, unknown> : null;
  return {
    effort: stringValue(obj.effort),
    format_type: format ? stringValue(format.type) : null,
    schema_keys: format?.schema && typeof format.schema === "object"
      ? Object.keys(format.schema as Record<string, unknown>).sort()
      : null,
  };
}

function firstUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  const first = messages.find((msg) => {
    return !!msg && typeof msg === "object" && (msg as Record<string, unknown>).role === "user";
  });
  if (!first || typeof first !== "object") return "";
  return extractText((first as Record<string, unknown>).content);
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  const obj = value as Record<string, unknown>;
  if (typeof obj.text === "string") return obj.text;
  return Object.values(obj).map(extractText).filter(Boolean).join("\n");
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function preview(value: string): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length > MAX_PREVIEW_CHARS ? cleaned.slice(0, MAX_PREVIEW_CHARS) + "..." : cleaned;
}

function summarizeText(value: string, includePreview: boolean): Record<string, unknown> {
  return {
    chars: value.length,
    sha256_12: value ? createHash("sha256").update(value).digest("hex").slice(0, 12) : "",
    ...(includePreview ? { preview: preview(value) } : {}),
  };
}

function appendPreview(current: string, next: string): string {
  const combined = current + next;
  return combined.length > MAX_PREVIEW_CHARS ? combined.slice(0, MAX_PREVIEW_CHARS) : combined;
}
