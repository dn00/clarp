# clarp on Windows — Root Cause & Fix Plan (issue #1)

**Issue:** [#1 "Automatic 'exit' after processing?"](https://github.com/dn00/clarp/issues/1) (OPEN) — on Windows/PowerShell, `clarp -p "test"` produces **no output and never exits**; only Ctrl-C stops it (with no message), even on v0.1.6 after waiting 10 minutes. Closed #2 (`clarp -p -`) is already fixed on `main`.

**Status:** Root-caused from source (read-only). No code changed. The one external assumption (node-pty's reported pid on Windows) still needs a one-time Windows probe to confirm, but the recommended fix is correct regardless of that detail.

---

## 1. Root cause (confirmed in code)

clarp's whole turn lifecycle — *detect the prompt started → detect it finished → exit* — is driven by a **single signal**: Claude's per-process status file at `~/.claude/sessions/<pid>.json`, polled by `PidWatcher`.

Chain of evidence:

- `PidWatcher` keys the status file purely on a pid: `pidFilePath = ~/.claude/sessions/${pid}.json` — `pid-watcher.ts:40-41`.
- That pid is whatever node-pty reports for the process clarp spawned: `cli.ts:112-119` passes `pid: ptyHandle.pid`; `pty-host.ts:118` sets `pid: proc.pid`.
- Every turn transition flows from `handleStatusChange`, which is **only** called by the PidWatcher poll: `session.ts:108-110`, `154`.
- Single-prompt (text mode) exit happens **only** when a turn is observed `busy → idle` and `completeTurn()` runs: `session.ts:219-226` → `683` → `723-726` *"Single prompt complete, exiting"* → `requestShutdown(0)`.

### Why it works on macOS/Linux
`findClaude()` returns `which claude` (`pty-host.ts:75-76`) → a node shebang script. node-pty execs node **in place**, so `proc.pid` **is** Claude's own node pid. Claude writes `sessions/<that pid>.json`, PidWatcher reads it, `busy → idle` fires, clarp exits. ✅

### Why it hangs on Windows
`findClaude()` returns **`claude.cmd`** (`pty-host.ts:66-68`) — a batch shim. node-pty/ConPTY runs it through `cmd.exe`, so `proc.pid` is the **wrapper's** pid. The real `node` Claude process is a *grandchild* and writes `sessions/<grandchild-pid>.json`. clarp polls `sessions/<cmd.exe-pid>.json`, which **never exists**:

- `readPidFile()` returns `null` on every poll → `onStatusChange` never fires (`pid-watcher.ts:159-165`, `87-97`).
- `claudeReady` never becomes `true` → `isReadyForPrompt()` never true → the `busy/idle` turn flow never runs → clarp never reaches the "single prompt complete, exiting" path.
- Output also stays empty: `emitInitFromTranscriptOrFallback()` and the transcript reader depend on `getSessionId()` / `getTranscriptPath()`, which read the same missing pid file (`session.ts:871-879`, `pid-watcher.ts:62-85`).

### Why the 30 s safety net does **not** save it
The readiness watchdog only arms when there is a **queued** prompt: `shouldArmReadinessTimer()` requires `this.opQueue.normalLength > 0` (`session.ts:453-464`). But `clarp -p "test"` passes the prompt as a **claude CLI arg** (`cli.ts:52`), not through the op-queue (`enqueuePrompt` is wired only to stdin messages, `cli.ts:122`). So `normalLength` is `0`, the watchdog never arms, and there is **no timeout at all** → infinite hang. Ctrl-C → `interrupt()` → 2 s later `kill("SIGTERM")` on the PTY (`session.ts:333-348`) → process dies with no terminal `result` emitted.

Both halves match the report precisely: no output, no auto-exit, Ctrl-C kills silently.

---

## 2. The proper fix

### Part 1 — Observe the real Claude process, not the wrapper *(the actual bug)*
Stop trusting node-pty's reported pid to locate the status file. Instead **discover Claude's real session file by content**:

- After spawn, have `PidWatcher` scan `~/.claude/sessions/*.json` for the entry whose `cwd` matches clarp's cwd and whose `updatedAt`/mtime is **after** clarp's start time; adopt that pid, then poll it as today.
- Tie-break by newest-after-start + claim-once so concurrent clarp/claude runs in the same directory don't adopt each other's session.
- Once adopted, revert to a single-file stat (no repeated dir scans).

This is platform-agnostic, also hardens POSIX against version-manager shims (volta/fnm/asdf), and avoids the fragile job of locating Claude's JS entrypoint.

*Rejected alternative:* resolve Claude's real `cli.js` and spawn `node <cli.js>` directly so the wrapper disappears and `proc.pid` is correct. Brittle — the Windows **native installer ships `claude.exe`** (not a node script), so entry resolution isn't guaranteed.

### Part 2 — Never hang silently *(defense in depth; also closes audit HIGH #1)*
- Make the startup readiness watchdog **unconditional**: arm it whenever Claude has not yet been observed, regardless of whether a prompt was queued or passed as an arg (drop the `normalLength > 0` gate **for the startup phase only**, leaving in-turn behavior untouched).
- On timeout, **emit a terminal `error` stream-json result and exit non-zero**, instead of only writing to stderr. Guarantees a parseable terminator even if observation breaks again.

### Secondary Windows hardening (cheap, bundle it)
- **`findClaude()`** on win32 only tries `where claude.cmd` (`pty-host.ts:66-68`); the native installer's `claude.exe` (and a bare `claude`) won't be found, so clarp can fail to even locate Claude. Broaden to accept `claude.cmd` / `claude.exe` / `claude`.
- **Transcript slug** at `pid-watcher.ts:74` replaces only `/`; on Windows the `cwd` uses `\`, so the direct transcript path misses (it currently limps along on the `readdir` fallback, which itself needs the sessionId that comes from the missing pid file). Normalize `\` and match Claude Code's real Windows encoding.

---

## 3. Risks of the fix

### Part 1 (content-scan session discovery)
- **Wrong-session adoption / cross-talk.** Two clarp or claude sessions in the same `cwd` could let the scan adopt the wrong file. *Mitigation:* require `mtime/updatedAt > startedAt`, claim-once, and optionally verify the adopted pid is alive.
- **Detection latency / race.** The session file may not exist at the instant of spawn; discovery must poll until found, adding a short delay vs a direct stat. *Mitigation:* bounded by the Part 2 watchdog.
- **Stale-file adoption.** An old session file from a prior run with the same cwd could be picked if the time filter is wrong → adopt a dead session that never goes busy. *Mitigation:* strict `> startedAt` filter + pid-liveness check.
- **Path comparison pitfalls (Windows).** Matching clarp's cwd to Claude's recorded `cwd` must handle case-insensitivity, drive-letter casing, trailing slashes, and `\` vs `/`. A naive string compare will miss. *Mitigation:* normalize both sides before comparing.
- **Undocumented-internals dependency.** The fix leans harder on the shape/semantics of `~/.claude/sessions/*.json` (the `cwd` field, naming, layout) — all undocumented and version-volatile. This is the project's standing fragility (see audit: protocol-parity / "no live CI"), not new, but it widens the surface. *Mitigation:* keep the pid-stat fast path when it works; treat scan as fallback; add a version-drift check.

### Part 2 (unconditional watchdog + error result)
- **False timeouts on slow starts.** Cold start, MCP server loading, or a large repo can push legitimate readiness past a fixed timeout, aborting a healthy run. *Mitigation:* generous default (e.g. 60–120 s), distinguish "never observed" from "observed but slow," make it configurable (env/flag).
- **Output-contract change.** Callers that previously hung now get an `error` result — better, but a behavior change; the synthetic result **must match `claude -p`'s error result shape exactly** or downstream parsers may choke.
- **Regression-prone area.** Readiness arming is the single most fragile part of the codebase — it already produced two fixes in one night (`ca78eaf`, `4ee59af`). Changing it risks re-introducing false-arm during active turns. *Mitigation:* add a *separate* startup-phase deadline rather than editing the in-turn predicate; cover with regression tests for both "long legit turn must not trip" and "stuck startup must trip."

### Secondary fixes
- **`findClaude` broadening:** `where` can return multiple matches; taking the first is normally right but could pick an unexpected binary. Low risk.
- **Slug normalization:** if Claude Code's actual Windows encoding is guessed wrong, behavior is no worse than today (fallback still runs). Low risk.

### Cross-cutting / process risk (the biggest one)
- **No Windows in the loop.** The maintainer has stated they "can't test thoroughly," and CI never exercises the PTY round-trip on Windows (audit HIGH #5 — the matrix only runs `build`/`test`/`pack`). **Any fix here is essentially unverifiable on the failing platform without a Windows machine or a Windows integration job.** This is the dominant risk: shipping a plausible fix that still doesn't work in the field. *Mitigation:* land the Windows PTY smoke/integration job (audit #5) **as part of this change**, and run the confirmation probe (below) before and after.

---

## 4. Validation plan
1. **Confirm the theory (read-only probe, Windows):** spawn `claude.cmd` via node-pty, print `proc.pid`, then list `~/.claude/sessions/*.json` and compare — expect `proc.pid` ≠ the file's pid (and the file keyed on a different, live pid). Part 1 is correct even if this differs from expectation, but the probe pins the mechanism.
2. **Repro before fix:** `clarp -p "test"` on Windows hangs; with Part 1, it should produce output and auto-exit.
3. **Regression tests (cross-platform, run in CI):**
   - PidWatcher adopts a session file by cwd+recency and ignores stale/other-cwd files.
   - Startup watchdog emits a terminal `error` result and exits when no session is ever observed (covers the arg-prompt path, `normalLength == 0`).
   - A long legitimate active turn does **not** trip the watchdog.
4. **Windows CI job (audit #5):** drive the PTY round-trip against a stub child on `windows-latest` so this can't silently regress again.

---

## Appendix A — Confirmation probe (read-only, run on Windows)

Save as `scripts/windows-pid-probe.mjs` and run on a Windows box that reproduces the hang
(`node scripts/windows-pid-probe.mjs`). It changes nothing — it spawns Claude exactly as clarp
does, prints the pid node-pty reports, then lists the session files Claude actually wrote and
compares. **Expected result on Windows:** the node-pty pid does **not** match the pid of the
session file whose `cwd` is this directory (proving clarp polls a file that never exists).

```js
// scripts/windows-pid-probe.mjs — READ-ONLY diagnostic for issue #1
import * as nodePty from "node-pty";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function findClaude() {
  // Mirrors clarp's current src/pty-host.ts:findClaude()
  if (os.platform() === "win32") {
    try { return execSync("where claude.cmd", { encoding: "utf8" }).trim().split("\n")[0]; }
    catch { return null; }
  }
  try { return execSync("which claude", { encoding: "utf8" }).trim(); } catch { return null; }
}

function alsoTry() {
  // What a broadened findClaude() would also consider on Windows
  const out = {};
  for (const name of ["claude.cmd", "claude.exe", "claude"]) {
    try { out[name] = execSync(`where ${name}`, { encoding: "utf8" }).trim().split("\n"); }
    catch { out[name] = null; }
  }
  return out;
}

function listSessions() {
  const dir = path.join(os.homedir(), ".claude", "sessions");
  try {
    return fs.readdirSync(dir).filter(f => f.endsWith(".json")).map(f => {
      const p = path.join(dir, f);
      let data = {};
      try { data = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
      return { file: f, pid: data.pid, cwd: data.cwd, status: data.status, mtime: fs.statSync(p).mtimeMs };
    });
  } catch { return []; }
}

const claudePath = findClaude();
console.log("platform:", os.platform(), os.arch());
console.log("findClaude() (clarp current):", claudePath);
console.log("where variants:", JSON.stringify(alsoTry(), null, 2));
if (!claudePath) { console.log("claude not found by clarp's resolver — that alone breaks Windows."); process.exit(0); }

const startedAt = Date.now();
const before = new Set(listSessions().map(s => s.file));
const proc = nodePty.spawn(claudePath, ["hello from probe"], {
  name: "xterm-256color", cols: 120, rows: 24, cwd: process.cwd(), env: process.env,
});
console.log("node-pty reported pid (== clarp's PidWatcher key):", proc.pid);
console.log("clarp would poll:", path.join(os.homedir(), ".claude", "sessions", `${proc.pid}.json`));

let out = "";
proc.onData(d => { out += d; });

setTimeout(() => {
  const after = listSessions();
  const fresh = after.filter(s => !before.has(s.file) || s.mtime >= startedAt);
  console.log("\nsession files written/updated since spawn:");
  for (const s of fresh) console.log(`  ${s.file}  pid=${s.pid}  status=${s.status}  cwd=${s.cwd}`);
  const mine = fresh.find(s => s.cwd && path.resolve(s.cwd).toLowerCase() === process.cwd().toLowerCase());
  console.log("\nmatch for this cwd:", mine ? `${mine.file} (pid ${mine.pid})` : "NONE");
  console.log("clarp-expected file exists:", fs.existsSync(path.join(os.homedir(), ".claude", "sessions", `${proc.pid}.json`)));
  if (mine && mine.pid !== proc.pid) {
    console.log(`\n>>> CONFIRMED: node-pty pid ${proc.pid} != Claude's real pid ${mine.pid}. clarp polls a non-existent file -> hang.`);
  }
  console.log("\nPTY output bytes seen:", out.length);
  try { proc.kill(); } catch {}
  process.exit(0);
}, 8000);
```

Interpreting it:
- **`mine.pid !== proc.pid`** → confirms Part 1 (wrapper-pid mismatch) is the bug.
- **`findClaude()` returns `null` but `claude.exe` is present** → confirms the secondary `findClaude` gap (clarp can't even locate Claude when installed via the native installer).
- **`PTY output bytes seen: 0`** → Claude isn't reaching the proxy/producing output either (compounding the empty-output symptom).

## References
- Code: `src/pty-host.ts` (`findClaude` 65-82, `spawnClaude` 88-120), `src/pid-watcher.ts` (40-41, 62-85, 159-165), `src/session.ts` (108-110, 154-235, 453-464, 723-726), `src/cli.ts` (52, 112-122).
- Related audit findings: HIGH #1 (no terminal result on failure paths), HIGH #5 (CI never exercises the PTY round-trip / Windows claimed-but-unverified) in `PRODUCTION_READINESS.md`.
