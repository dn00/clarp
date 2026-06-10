import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PidWatcher, getParentPid, type PidFileData } from "./pid-watcher.js";
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

// When node-pty reports a wrapper's pid (Windows claude.cmd, POSIX shim) the
// reported pid file never appears, so PidWatcher must discover Claude's real
// session file by matching cwd + recency. The reported pid (WRAPPER_PID) is
// deliberately one whose file is never written.
describe("PidWatcher session discovery (wrapper-pid case)", () => {
  const WRAPPER_PID = 4242;
  const REAL_PID = process.pid; // a guaranteed-alive "grandchild" pid
  let tmpDir: string;
  let sessionsDir: string;
  let startedAt: number;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pid-discovery-test-"));
    sessionsDir = path.join(tmpDir, ".claude", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    startedAt = Date.now();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSession(pid: number, data: Partial<PidFileData>): void {
    const full: PidFileData = {
      pid,
      sessionId: `sess-${pid}`,
      cwd: "/work/project",
      kind: "interactive",
      updatedAt: startedAt + 1000,
      ...data,
    };
    fs.writeFileSync(path.join(sessionsDir, `${pid}.json`), JSON.stringify(full));
  }

  function makeWatcher(cwd: string): PidWatcher {
    return new PidWatcher(WRAPPER_PID, { onStatusChange: () => {} }, tmpDir, {
      cwd,
      startedAt,
      getParentPid: (pid) => (pid === REAL_PID ? WRAPPER_PID : null),
    });
  }

  it("discovers the real session file by cwd when the reported pid file is absent", () => {
    writeSession(REAL_PID, { cwd: "/work/project", sessionId: "real-session" });
    const watcher = makeWatcher("/work/project");
    expect(watcher.getSessionId()).toBe("real-session");
  });

  it("ignores session files for a different cwd", () => {
    writeSession(REAL_PID, { cwd: "/some/other/dir", sessionId: "other" });
    const watcher = makeWatcher("/work/project");
    expect(watcher.getSessionId()).toBeNull();
  });

  it("ignores a stale prior-run file (updatedAt before start)", () => {
    writeSession(REAL_PID, { updatedAt: startedAt - 60_000, sessionId: "stale" });
    const watcher = makeWatcher("/work/project");
    expect(watcher.getSessionId()).toBeNull();
  });

  it("ignores a session whose process is no longer alive", () => {
    // pid 0 fails the liveness/validity guard deterministically.
    writeSession(0, { cwd: "/work/project", sessionId: "dead" });
    const watcher = makeWatcher("/work/project");
    expect(watcher.getSessionId()).toBeNull();
  });

  it("reports status changes from the discovered file via polling", () => {
    vi.useFakeTimers();
    try {
      writeSession(REAL_PID, { cwd: "/work/project", status: "busy", sessionId: "live" });
      const changes: string[] = [];
      const watcher = new PidWatcher(
        WRAPPER_PID,
        { onStatusChange: (status) => changes.push(status) },
        tmpDir,
        {
          cwd: "/work/project",
          startedAt,
          getParentPid: (pid) => (pid === REAL_PID ? WRAPPER_PID : null),
        },
      );
      watcher.start();
      expect(changes).toEqual(["busy"]);
      writeSession(REAL_PID, { cwd: "/work/project", status: "idle", sessionId: "live" });
      vi.advanceTimersByTime(600);
      expect(changes).toEqual(["busy", "idle"]);
      watcher.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("matches cwd case-insensitively and across separators on Windows", () => {
    if (process.platform !== "win32") return;
    writeSession(REAL_PID, { cwd: "C:\\Work\\Project", sessionId: "win" });
    const watcher = makeWatcher("c:/work/project");
    expect(watcher.getSessionId()).toBe("win");
  });
});

// When two clarp runs launch Claude from the same cwd through a wrapper, both
// scan the shared sessions directory. PidWatcher must adopt only the session
// whose process descends from the wrapper IT launched, and refuse rather than
// guess if ancestry can't disambiguate.
describe("PidWatcher concurrent same-cwd disambiguation", () => {
  const WRAPPER_PID = 500;
  let tmpDir: string;
  let sessionsDir: string;
  let startedAt: number;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pid-concurrent-test-"));
    sessionsDir = path.join(tmpDir, ".claude", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    startedAt = Date.now();
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function writeSession(pid: number, sessionId: string, when: number): void {
    fs.writeFileSync(
      path.join(sessionsDir, `${pid}.json`),
      JSON.stringify({ pid, sessionId, cwd: "/shared/dir", kind: "interactive", updatedAt: when }),
    );
  }

  // Wrapper 500 -> our Claude 1001; the other run is wrapper 600 -> Claude 1002.
  const parents: Record<number, number> = { 1001: 500, 1002: 600 };

  function makeWatcher(opts?: {
    startedAt?: number;
    parents?: Record<number, number | null>;
    onWarning?: (message: string) => void;
  }): PidWatcher {
    const lookup = opts?.parents ?? parents;
    return new PidWatcher(WRAPPER_PID, { onStatusChange: () => {} }, tmpDir, {
      cwd: "/shared/dir",
      startedAt: opts?.startedAt ?? startedAt,
      isPidAlive: () => true,
      getParentPid: (pid) => lookup[pid] ?? null,
    });
  }

  function makeWatcherWithWarning(opts: {
    startedAt: number;
    parents: Record<number, number | null>;
    warnings: string[];
  }): PidWatcher {
    return new PidWatcher(WRAPPER_PID, {
      onStatusChange: () => {},
      onWarning: (message) => opts.warnings.push(message),
    }, tmpDir, {
      cwd: "/shared/dir",
      startedAt: opts.startedAt,
      isPidAlive: () => true,
      getParentPid: (pid) => opts.parents[pid] ?? null,
    });
  }

  it("adopts the session descended from our wrapper, not the concurrent run's", () => {
    writeSession(1002, "theirs", startedAt + 2000); // newer, but not ours
    writeSession(1001, "ours", startedAt + 1000);
    expect(makeWatcher().getSessionId()).toBe("ours");
  });

  it("refuses to adopt when no candidate descends from our wrapper", () => {
    writeSession(1002, "theirs", startedAt + 1000); // descends from 600, not 500
    fs.writeFileSync(
      path.join(sessionsDir, "9003.json"),
      JSON.stringify({ pid: 9003, sessionId: "alsotheirs", cwd: "/shared/dir", kind: "interactive", updatedAt: startedAt + 1500 }),
    );
    expect(makeWatcher().getSessionId()).toBeNull();
  });

  it("waits during the grace window instead of adopting a sole foreign candidate", () => {
    writeSession(1002, "theirs", startedAt + 1000);
    const watcher = makeWatcher();

    expect(watcher.getSessionId()).toBeNull();

    writeSession(1001, "ours", startedAt + 2000);
    expect(watcher.getSessionId()).toBe("ours");
  });

  it("keeps refusing a positively foreign candidate after the grace window", () => {
    writeSession(1002, "theirs", startedAt + 1000);
    const watcher = makeWatcher({
      startedAt: Date.now() - 11_000,
      parents: { 1002: 600, 600: 1 },
    });

    expect(watcher.getSessionId()).toBeNull();
  });

  it("degrades to newest candidate after grace when ancestry is indeterminate", () => {
    const warnings: string[] = [];
    writeSession(1002, "theirs", startedAt + 1000);
    writeSession(1003, "newer", startedAt + 2000);
    const watcher = makeWatcherWithWarning({
      startedAt: Date.now() - 11_000,
      parents: { 1002: null, 1003: null },
      warnings,
    });

    expect(watcher.getSessionId()).toBe("newer");
    expect(warnings).toHaveLength(1);
  });
});

describe("getParentPid", () => {
  it("resolves the current process's parent on this platform", () => {
    // Verifies the real platform implementation (incl. Windows PowerShell) on
    // each CI OS without needing concurrent spawns.
    expect(getParentPid(process.pid)).toBe(process.ppid);
  });

  it("returns null for an invalid pid", () => {
    expect(getParentPid(0)).toBeNull();
    expect(getParentPid(-1)).toBeNull();
  });
});
