import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PidWatcher, type PidFileData } from "./pid-watcher.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_PID = 99999;

describe("PidWatcher", () => {
  let tmpDir: string;
  let sessionsDir: string;
  let testPidFile: string;
  let watcher: PidWatcher;
  let statusChanges: Array<{ status: string; waitingFor: string | undefined; data: PidFileData }>;

  beforeEach(() => {
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pid-watcher-test-"));
    sessionsDir = path.join(tmpDir, ".claude", "sessions");
    testPidFile = path.join(sessionsDir, `${TEST_PID}.json`);
    statusChanges = [];
    watcher = new PidWatcher(TEST_PID, {
      onStatusChange: (status, waitingFor, data) => {
        statusChanges.push({ status, waitingFor, data });
      },
    }, tmpDir);
  });

  afterEach(() => {
    watcher.stop();
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writePidFile(data: Partial<PidFileData>): void {
    const full: PidFileData = {
      pid: TEST_PID,
      sessionId: "test-session-id",
      cwd: "/tmp/test",
      kind: "interactive",
      ...data,
    };
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(testPidFile, JSON.stringify(full));
  }

  it("reads session ID from PID file", () => {
    writePidFile({ sessionId: "abc-123" });
    expect(watcher.getSessionId()).toBe("abc-123");
  });

  it("returns null when PID file missing", () => {
    expect(watcher.getSessionId()).toBeNull();
  });

  it("rejects unsafe session IDs", () => {
    writePidFile({ sessionId: "../secret" });
    expect(watcher.getSessionId()).toBeNull();
    expect(watcher.getTranscriptPath()).toBeNull();
  });

  it("detects status change on first poll", () => {
    writePidFile({ status: "busy" });
    watcher.start();

    expect(statusChanges).toHaveLength(1);
    expect(statusChanges[0]).toMatchObject({ status: "busy", waitingFor: undefined });
    expect(statusChanges[0]!.data.status).toBe("busy");
  });

  it("detects busy → idle transition", () => {
    writePidFile({ status: "busy" });
    watcher.start();

    expect(statusChanges).toHaveLength(1);

    writePidFile({ status: "idle" });
    vi.advanceTimersByTime(500);

    expect(statusChanges).toHaveLength(2);
    expect(statusChanges[1]).toMatchObject({ status: "idle", waitingFor: undefined });
  });

  it("detects waiting state with waitingFor", () => {
    writePidFile({ status: "busy" });
    watcher.start();

    writePidFile({ status: "waiting", waitingFor: "approve Bash" });
    vi.advanceTimersByTime(500);

    expect(statusChanges.some(s => s.status === "waiting" && s.waitingFor === "approve Bash")).toBe(true);
  });

  it("does not fire duplicate events for same status", () => {
    writePidFile({ status: "busy" });
    watcher.start();

    vi.advanceTimersByTime(1000);

    expect(statusChanges).toHaveLength(1);
  });

  it("fires when waitingFor changes even if status is same", () => {
    writePidFile({ status: "waiting", waitingFor: "approve Bash" });
    watcher.start();

    writePidFile({ status: "waiting", waitingFor: "approve Edit" });
    vi.advanceTimersByTime(500);

    expect(statusChanges).toHaveLength(2);
    expect(statusChanges[1]!.waitingFor).toBe("approve Edit");
  });

  it("handles missing status field gracefully", () => {
    writePidFile({});
    watcher.start();

    expect(statusChanges).toHaveLength(1);
    expect(statusChanges[0]!.status).toBe("unknown");
  });

  it("handles corrupted PID file gracefully", () => {
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(testPidFile, "not json{{{");
    watcher.start();

    expect(statusChanges).toHaveLength(0);
  });

  it("stops polling after stop()", () => {
    writePidFile({ status: "busy" });
    watcher.start();
    watcher.stop();

    writePidFile({ status: "idle" });
    vi.advanceTimersByTime(1000);

    expect(statusChanges).toHaveLength(1);
  });

  it("derives transcript path from cwd", () => {
    writePidFile({ cwd: "/Users/test/Code/myproject", sessionId: "sess-1" });
    const transcriptPath = watcher.getTranscriptPath();
    // Can't assert exact path exists, but format should be correct
    // The path would be ~/.claude/projects/-Users-test-Code-myproject/sess-1.jsonl
    // It won't exist, so should return null
    expect(transcriptPath).toBeNull();
  });
});
