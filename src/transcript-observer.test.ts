import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptObserver } from "./transcript-observer.js";

describe("TranscriptObserver", () => {
  let tmpDir: string;
  let transcriptPath: string;
  let observer: TranscriptObserver | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clarp-transcript-"));
    transcriptPath = path.join(tmpDir, "session.jsonl");
    fs.writeFileSync(transcriptPath, "");
  });

  afterEach(() => {
    observer?.stop();
    observer = null;
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits complete JSONL records and waits for partial lines", async () => {
    const lines: Record<string, unknown>[] = [];
    fs.writeFileSync(transcriptPath, JSON.stringify({ uuid: "one", type: "system" }) + "\n");
    observer = new TranscriptObserver({
      transcriptPath,
      pollIntervalMs: 10,
      onLine: (line) => lines.push(line),
    });

    observer.start();
    expect(lines.map((line) => line.uuid)).toEqual(["one"]);

    fs.appendFileSync(transcriptPath, '{"uuid":"two","type":"system"');
    await vi.advanceTimersByTimeAsync(10);
    expect(lines.map((line) => line.uuid)).toEqual(["one"]);

    fs.appendFileSync(transcriptPath, '}\n');
    await vi.advanceTimersByTimeAsync(10);
    expect(lines.map((line) => line.uuid)).toEqual(["one", "two"]);
  });

  it("dedupes records by uuid", async () => {
    const lines: Record<string, unknown>[] = [];
    observer = new TranscriptObserver({
      transcriptPath,
      pollIntervalMs: 10,
      onLine: (line) => lines.push(line),
    });
    observer.start();

    fs.appendFileSync(transcriptPath, JSON.stringify({ uuid: "same", value: 1 }) + "\n");
    await vi.advanceTimersByTimeAsync(10);
    fs.appendFileSync(transcriptPath, JSON.stringify({ uuid: "same", value: 2 }) + "\n");
    await vi.advanceTimersByTimeAsync(10);

    expect(lines).toEqual([{ uuid: "same", value: 1 }]);
  });

  it("skips a partial first line when starting from a capped tail", () => {
    const lines: Record<string, unknown>[] = [];
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({ uuid: "old", value: "x".repeat(200) }) + "\n" +
        JSON.stringify({ uuid: "new", value: 1 }) + "\n",
    );
    observer = new TranscriptObserver({
      transcriptPath,
      pollIntervalMs: 10,
      initialReadBytes: 40,
      onLine: (line) => lines.push(line),
    });

    observer.start();

    expect(lines).toEqual([{ uuid: "new", value: 1 }]);
  });
});

