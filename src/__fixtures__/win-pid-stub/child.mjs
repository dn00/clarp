#!/usr/bin/env node
// Stub that stands in for Claude's real node process. It records its own pid
// and writes a Claude-style session file, so a test can verify both:
//   1. the pid node-pty reports for the spawned wrapper vs this real pid, and
//   2. that a PidWatcher discovers this session file by cwd+recency even when
//      node-pty's reported pid points at a wrapper (the issue-#1 fix).
//
// POSIX: Claude is a `#!/usr/bin/env node` script, so node-pty execs node in
// place and the reported pid IS this pid. Windows: Claude is launched via
// claude.cmd, so node-pty reports the cmd.exe wrapper pid and this node runs
// as a grandchild with a DIFFERENT pid — the root cause of issue #1.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const pidFile = process.env.CLARP_PROBE_PIDFILE;
if (pidFile) writeFileSync(pidFile, String(process.pid));

const sessionsDir = process.env.CLARP_PROBE_SESSIONS_DIR;
if (sessionsDir) {
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    join(sessionsDir, `${process.pid}.json`),
    JSON.stringify({
      pid: process.pid,
      sessionId: "probe-session",
      cwd: process.env.CLARP_PROBE_CWD || process.cwd(),
      kind: "interactive",
      status: "idle",
      updatedAt: Date.now(),
    }),
  );
}

process.stdout.write("stub-child-ready\n");
// Stay alive briefly so the test can read node-pty's reported pid and run the
// PidWatcher (whose liveness check requires this process to still exist).
setTimeout(() => process.exit(0), 6000);
