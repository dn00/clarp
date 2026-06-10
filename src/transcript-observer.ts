import * as fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_INITIAL_READ_BYTES = 512 * 1024;

export type TranscriptObserverOptions = {
  transcriptPath: string;
  pollIntervalMs?: number;
  initialReadBytes?: number;
  onLine: (line: Record<string, unknown>) => void;
  onError?: (err: Error) => void;
};

/**
 * Tails Claude's JSONL transcript and emits each complete JSON object once.
 * The initial read is capped so resumed or long-running sessions do not replay
 * unbounded history, while still catching early events written before startup.
 */
export class TranscriptObserver {
  private timer: ReturnType<typeof setInterval> | null = null;
  private offset: number | null = null;
  private pending = "";
  // Persistent decoder so a multibyte UTF-8 character split across two polls
  // is not mangled into replacement characters by independent decodes.
  private decoder = new StringDecoder("utf8");
  private seenUuids = new Set<string>();

  constructor(private opts: TranscriptObserverOptions) {}

  start(): void {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), this.opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private poll(): void {
    try {
      const stat = fs.statSync(this.opts.transcriptPath);
      let skipLeadingPartialLine = false;
      if (this.offset == null) {
        this.offset = Math.max(0, stat.size - (this.opts.initialReadBytes ?? DEFAULT_INITIAL_READ_BYTES));
        skipLeadingPartialLine = this.offset > 0;
      } else if (stat.size < this.offset) {
        this.offset = 0;
        this.pending = "";
        this.decoder = new StringDecoder("utf8");
      }

      if (stat.size <= this.offset) return;

      const readSize = stat.size - this.offset;
      const fd = fs.openSync(this.opts.transcriptPath, "r");
      try {
        const buf = Buffer.alloc(readSize);
        fs.readSync(fd, buf, 0, readSize, this.offset);
        let chunk = this.decoder.write(buf);
        if (skipLeadingPartialLine) {
          const firstNewline = chunk.indexOf("\n");
          chunk = firstNewline >= 0 ? chunk.slice(firstNewline + 1) : "";
        }
        this.offset = stat.size;
        this.processChunk(chunk);
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private processChunk(chunk: string): void {
    if (!chunk) return;
    const combined = this.pending + chunk;
    const parts = combined.split("\n");
    this.pending = parts.pop() ?? "";

    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        const obj = parsed as Record<string, unknown>;
        const uuid = typeof obj.uuid === "string" ? obj.uuid : "";
        if (uuid) {
          if (this.seenUuids.has(uuid)) continue;
          this.seenUuids.add(uuid);
        }
        this.opts.onLine(obj);
      } catch {}
    }
  }
}
