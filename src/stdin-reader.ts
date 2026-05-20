import type { Args } from "./args.js";

const MAX_STREAM_JSON_LINE_BYTES = 1024 * 1024;

export type StdinReaderCallbacks = {
  onUserMessage: (content: string) => void;
  onControlRequest: (req: Record<string, unknown>, requestId?: string) => void;
  onControlResponse: (resp: Record<string, unknown>, requestId: string) => void;
  onKeepAlive: () => void;
  onEof: () => void;
  onMalformedLine?: (message: string) => void;
};

/**
 * Reads either a plain text prompt or newline-delimited stream-json control
 * messages from stdin.
 */
export class StdinReader {
  constructor(
    private input: NodeJS.ReadableStream,
    private args: Pick<Args, "inputFormat" | "prompt">,
    private callbacks: StdinReaderCallbacks,
    private log: (msg: string) => void = () => {},
  ) {}

  /**
   * Starts consuming stdin according to the configured input format.
   */
  start(): void {
    if (this.args.inputFormat === "stream-json") {
      this.startStreamJsonMode();
    } else if (!this.args.prompt) {
      this.startTextPromptMode();
    }
  }

  private startStreamJsonMode(): void {
    let buf = "";
    this.input.setEncoding("utf8");
    this.input.on("data", (chunk: string) => {
      buf += chunk;
      if (Buffer.byteLength(buf, "utf8") > MAX_STREAM_JSON_LINE_BYTES) {
        // A single unbounded JSON line can OOM the process before parsing.
        this.callbacks.onMalformedLine?.(`stream-json input line exceeded ${MAX_STREAM_JSON_LINE_BYTES} bytes; closing stdin reader`);
        buf = "";
        this.callbacks.onEof();
        this.input.pause();
        return;
      }
      let idx = buf.indexOf("\n");
      while (idx >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (Buffer.byteLength(line, "utf8") > MAX_STREAM_JSON_LINE_BYTES) {
          this.callbacks.onMalformedLine?.(`stream-json input line exceeded ${MAX_STREAM_JSON_LINE_BYTES} bytes; ignored`);
          idx = buf.indexOf("\n");
          continue;
        }
        if (line.length > 0) parseStdinLine(line, this.callbacks);
        idx = buf.indexOf("\n");
      }
    });
    this.input.on("end", () => {
      this.log("stdin EOF");
      this.callbacks.onEof();
    });
    this.input.resume();
  }

  private startTextPromptMode(): void {
    const chunks: string[] = [];
    this.input.setEncoding("utf8");
    this.input.on("data", (c: string) => chunks.push(c));
    this.input.on("end", () => {
      const text = chunks.join("").trim();
      if (text) this.callbacks.onUserMessage(text);
      this.callbacks.onEof();
    });
    this.input.resume();
  }
}

/**
 * Parses one stream-json input line and routes supported user/control messages.
 */
export function parseStdinLine(line: string, callbacks: Omit<StdinReaderCallbacks, "onEof">): void {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    callbacks.onMalformedLine?.(`Malformed stream-json input ignored: ${message}`);
    return;
  }

  if (parsed.type === "user") {
    const msg = parsed.message as Record<string, unknown> | undefined;
    if (!msg) return;
    let content = "";
    if (typeof msg.content === "string") content = msg.content;
    else if (Array.isArray(msg.content)) {
      content = (msg.content as Array<Record<string, unknown>>)
        .filter((b) => b.type === "text")
        .map((b) => b.text as string)
        .join("");
    }
    if (content) callbacks.onUserMessage(content);
  } else if (parsed.type === "control_request") {
    const req = parsed.request as Record<string, unknown> | undefined;
    if (req) callbacks.onControlRequest(req, parsed.request_id as string | undefined);
  } else if (parsed.type === "control_response") {
    const resp = parsed.response as Record<string, unknown> | undefined;
    const reqId = parsed.request_id as string;
    if (resp && reqId) callbacks.onControlResponse(resp, reqId);
  } else if (parsed.type === "keep_alive") {
    callbacks.onKeepAlive();
  }
}
