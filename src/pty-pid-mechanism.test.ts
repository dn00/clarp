import { describe, it, expect } from "vitest";
import * as nodePty from "node-pty";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// Empirically pins the issue-#1 mechanism on the real platform PTY (runs in the
// existing cross-OS CI matrix). clarp keys PidWatcher on the pid node-pty
// reports for the spawned binary; if that pid differs from the node process
// that actually writes ~/.claude/sessions/<pid>.json, clarp polls a file that
// never exists and hangs forever. This measures exactly that gap with a stub —
// no real claude needed.

const stubDir = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "win-pid-stub");

async function spawnAndComparePids(binary: string): Promise<{ reportedPid: number; writerPid: number }> {
  const work = mkdtempSync(join(tmpdir(), "clarp-pidprobe-"));
  const pidFile = join(work, "child.pid");
  const handle = nodePty.spawn(binary, [], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: work,
    env: { ...process.env, CLARP_PROBE_PIDFILE: pidFile },
  });
  try {
    const writerPid = await new Promise<number>((resolve, reject) => {
      const startedAt = Date.now();
      const poll = setInterval(() => {
        if (existsSync(pidFile)) {
          const raw = readFileSync(pidFile, "utf8").trim();
          const value = Number(raw);
          if (Number.isInteger(value) && value > 0) {
            clearInterval(poll);
            resolve(value);
          }
        } else if (Date.now() - startedAt > 10_000) {
          clearInterval(poll);
          reject(new Error("stub child never recorded its pid"));
        }
      }, 50);
    });
    return { reportedPid: handle.pid, writerPid };
  } finally {
    try { handle.kill(); } catch { /* already gone */ }
    rmSync(work, { recursive: true, force: true });
  }
}

describe("node-pty reported pid vs the process that writes the session file", () => {
  it.runIf(process.platform === "win32")(
    "Windows: reported pid is the cmd wrapper, NOT the node grandchild (issue #1)",
    async () => {
      const { reportedPid, writerPid } = await spawnAndComparePids(join(stubDir, "wrapper.cmd"));
      // This is the bug: clarp would poll sessions/<reportedPid>.json, but the
      // session file is written by writerPid. They differ, so the file is never
      // found and the turn lifecycle never advances.
      expect(reportedPid).not.toBe(writerPid);
    },
    20_000,
  );

  it.runIf(process.platform !== "win32")(
    "POSIX: reported pid IS the node process that writes the session file",
    async () => {
      // child.mjs is a `#!/usr/bin/env node` script (how Claude installs on
      // POSIX); node-pty execs node in place so the pids match and clarp's
      // pid-keyed polling works.
      const { reportedPid, writerPid } = await spawnAndComparePids(join(stubDir, "child.mjs"));
      expect(reportedPid).toBe(writerPid);
    },
    20_000,
  );
});
