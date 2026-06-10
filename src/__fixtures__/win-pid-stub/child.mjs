#!/usr/bin/env node
// Stub that stands in for Claude's real node process. It records its own pid
// (the process that would write ~/.claude/sessions/<pid>.json) so a test can
// compare it against the pid node-pty reports for the spawned wrapper.
//
// POSIX: Claude is a `#!/usr/bin/env node` script, so node-pty execs node in
// place and the reported pid IS this pid. Windows: Claude is launched via
// claude.cmd, so node-pty reports the cmd.exe wrapper pid and this node runs
// as a grandchild with a DIFFERENT pid — the root cause of issue #1.
import { writeFileSync } from "node:fs";

const pidFile = process.env.CLARP_PROBE_PIDFILE;
if (pidFile) writeFileSync(pidFile, String(process.pid));
process.stdout.write("stub-child-ready\n");
// Stay alive briefly so the test can read node-pty's reported pid before exit.
setTimeout(() => process.exit(0), 4000);
