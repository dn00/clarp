import { describe, it, expect } from "vitest";
import * as nodePty from "node-pty";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { PidWatcher } from "./pid-watcher.js";

// Empirically pins the issue-#1 mechanism AND the fix on the real platform PTY
// (runs in the existing cross-OS CI matrix, no real claude needed).
//
// clarp keys PidWatcher on the pid node-pty reports for the spawned binary. On
// Windows that binary is claude.cmd, so node-pty reports the cmd.exe wrapper
// pid while the real Claude node process runs as a grandchild that writes
// ~/.claude/sessions/<grandchild-pid>.json. The bug: clarp polls a file that
// never exists. The fix: discover the real session file by cwd + recency.
//
// The stub mirrors how Claude installs per-platform (POSIX node-shebang script;
// Windows .cmd → node grandchild) and writes a session file. We then assert
// node-pty's reported pid vs the writer pid, and that a real PidWatcher finds
// the session regardless.

const stubDir = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "win-pid-stub");
const RECORDED_CWD = process.platform === "win32" ? "C:\\clarp\\probe\\cwd" : "/clarp/probe/cwd";

function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = setInterval(() => {
      if (predicate()) { clearInterval(poll); resolve(); }
      else if (Date.now() - startedAt > timeoutMs) { clearInterval(poll); reject(new Error(label)); }
    }, 50);
  });
}

async function spawnProbe(binary: string): Promise<{ reportedPid: number; writerPid: number; discoveredSessionId: string | null }> {
  const home = mkdtempSync(join(tmpdir(), "clarp-probe-home-"));
  const sessionsDir = join(home, ".claude", "sessions");
  const pidFile = join(home, "child.pid");
  const startedAt = Date.now();
  const handle = nodePty.spawn(binary, [], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    // Not `home`: Windows locks the spawned process's working directory, which
    // would block cleanup. The stub writes into `home` via env paths instead.
    cwd: tmpdir(),
    env: {
      ...process.env,
      CLARP_PROBE_PIDFILE: pidFile,
      CLARP_PROBE_SESSIONS_DIR: sessionsDir,
      CLARP_PROBE_CWD: RECORDED_CWD,
    },
  });
  try {
    await waitFor(() => existsSync(pidFile), 10_000, "stub child never recorded its pid");
    const writerPid = Number(readFileSync(pidFile, "utf8").trim());
    await waitFor(() => existsSync(join(sessionsDir, `${writerPid}.json`)), 10_000, "stub never wrote its session file");

    // The reported pid is the wrapper on Windows; PidWatcher must still find the
    // grandchild's session file by cwd + recency.
    const watcher = new PidWatcher(handle.pid, { onStatusChange: () => {} }, home, {
      cwd: RECORDED_CWD,
      startedAt,
    });
    const discoveredSessionId = watcher.getSessionId();
    watcher.stop();
    return { reportedPid: handle.pid, writerPid, discoveredSessionId };
  } finally {
    try { handle.kill(); } catch { /* already gone */ }
    try { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ephemeral CI temp */ }
  }
}

describe("issue-#1 wrapper-pid mechanism and the discovery fix on the real PTY", () => {
  it.runIf(process.platform === "win32")(
    "Windows: pid mismatch is real, yet PidWatcher discovers the session",
    async () => {
      const { reportedPid, writerPid, discoveredSessionId } = await spawnProbe(join(stubDir, "wrapper.cmd"));
      // The bug exists: node-pty reports the cmd wrapper, not the node grandchild.
      expect(reportedPid).not.toBe(writerPid);
      // The fix works: discovery finds the grandchild's session file by cwd.
      expect(discoveredSessionId).toBe("probe-session");
    },
    25_000,
  );

  it.runIf(process.platform !== "win32")(
    "POSIX: reported pid IS the node process, and PidWatcher resolves the session",
    async () => {
      const { reportedPid, writerPid, discoveredSessionId } = await spawnProbe(join(stubDir, "child.mjs"));
      expect(reportedPid).toBe(writerPid);
      expect(discoveredSessionId).toBe("probe-session");
    },
    25_000,
  );
});
