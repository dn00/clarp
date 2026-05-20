import type { SSEEvent } from "./proxy.js";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: unknown };

export type AssembledMessage = {
  id: string;
  role: "assistant";
  model: string;
  content: ContentBlock[];
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
};

type MessageState = {
  id: string;
  model: string;
  content: ContentBlock[];
  currentBlockIndex: number;
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
};

export type ContextUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};

/**
 * Converts Anthropic streaming SSE deltas into the complete assistant messages
 * expected by the `claude -p` stream-json protocol.
 */
export class MessageAssembler {
  private current: MessageState | null = null;
  private onMessage: (msg: AssembledMessage) => void;
  private lastToolUse: { id: string; name: string; input: unknown } | null = null;
  private _contextUsage: ContextUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

  constructor(onMessage: (msg: AssembledMessage) => void) {
    this.onMessage = onMessage;
  }

  /**
   * Returns the most recent completed tool_use block, used for permission requests.
   */
  getLastToolUse(): { id: string; name: string; input: unknown } | null {
    return this.lastToolUse;
  }

  /**
   * Returns the latest token counts observed in message_start/message_delta events.
   */
  getContextUsage(): ContextUsage {
    return { ...this._contextUsage };
  }

  /**
   * Clears state between sessions/tests so tool and usage data do not leak.
   */
  reset(): void {
    this.current = null;
    this.lastToolUse = null;
    this._contextUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  }

  /**
   * Updates assembler state from one parsed SSE event.
   */
  processSSE(event: SSEEvent): void {
    const p = event.parsed;
    if (!p || typeof p !== "object") return;
    const e = p as Record<string, unknown>;

    switch (e.type) {
      case "message_start": {
        const msg = e.message as Record<string, unknown> | undefined;
        this.current = {
          id: (msg?.id as string) || "",
          model: (msg?.model as string) || "",
          content: [],
          currentBlockIndex: -1,
          stop_reason: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        };
        if (msg?.usage) {
          const u = msg.usage as Record<string, number>;
          this.current.usage.input_tokens = u.input_tokens || 0;
          this.current.usage.output_tokens = u.output_tokens || 0;
          this._contextUsage.input_tokens = u.input_tokens || this._contextUsage.input_tokens;
          this._contextUsage.cache_read_input_tokens = u.cache_read_input_tokens || this._contextUsage.cache_read_input_tokens;
          this._contextUsage.cache_creation_input_tokens = u.cache_creation_input_tokens || this._contextUsage.cache_creation_input_tokens;
        }
        break;
      }

      case "content_block_start": {
        if (!this.current) break;
        const block = e.content_block as Record<string, unknown>;
        const index = e.index as number;
        this.current.currentBlockIndex = index;

        if (block.type === "text") {
          this.current.content.push({ type: "text", text: (block.text as string) || "" });
        } else if (block.type === "thinking") {
          this.current.content.push({ type: "thinking", thinking: (block.thinking as string) || "" });
        } else if (block.type === "tool_use") {
          this.current.content.push({
            type: "tool_use",
            id: (block.id as string) || "",
            name: (block.name as string) || "",
            input: {},
          });
        }
        break;
      }

      case "content_block_delta": {
        if (!this.current) break;
        const delta = e.delta as Record<string, unknown>;
        const block = this.current.content[this.current.content.length - 1];
        if (!block) break;

        if (delta.type === "text_delta" && block.type === "text") {
          block.text += (delta.text as string) || "";
        } else if (delta.type === "thinking_delta" && block.type === "thinking") {
          block.thinking += (delta.thinking as string) || "";
        } else if (delta.type === "input_json_delta" && block.type === "tool_use") {
          const partial = (delta.partial_json as string) || "";
          if (typeof block.input === "string") {
            (block as any).input += partial;
          } else {
            (block as any).input = partial;
          }
        }
        break;
      }

      case "content_block_stop": {
        if (!this.current) break;
        const block = this.current.content[this.current.content.length - 1];
        if (block?.type === "tool_use" && typeof block.input === "string") {
          try {
            (block as any).input = JSON.parse(block.input as string);
          } catch {}
        }
        if (block?.type === "tool_use") {
          this.lastToolUse = { id: block.id, name: block.name, input: block.input };
        }
        this.onMessage({
          id: this.current.id,
          role: "assistant",
          model: this.current.model,
          content: block ? [{ ...block } as ContentBlock] : [],
          stop_reason: null,
          usage: { ...this.current.usage },
        });
        break;
      }

      case "message_delta": {
        if (!this.current) break;
        const delta = e.delta as Record<string, unknown> | undefined;
        if (delta?.stop_reason) {
          this.current.stop_reason = delta.stop_reason as string;
        }
        const usage = e.usage as Record<string, number> | undefined;
        if (usage) {
          this.current.usage.output_tokens = usage.output_tokens || this.current.usage.output_tokens;
          this._contextUsage.output_tokens = usage.output_tokens || this._contextUsage.output_tokens;
        }
        break;
      }

      case "message_stop": {
        this.current = null;
        break;
      }
    }
  }
}
