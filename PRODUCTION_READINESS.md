# clarp-cli — Production Readiness Audit

**Package:** `clarp-cli` v0.1.10 — experimental drop-in replacement for `claude -p` (wraps an interactive Claude Code session in a hidden node-pty and re-exposes the stream-json protocol).

**Date:** 2026-05-30  
**Method:** Read-only multi-agent fan-out. One dedicated agent per dimension plus a build/test ground-truth agent, coordinated by a background workflow. Each agent cited file:line / command evidence and self-rated severity & confidence.  
**Scope note:** Findings below are the agents' direct (single-pass) output. The adversarial cross-verification and completeness-critic phases were **stopped early at the user's request**, so HIGH/MEDIUM findings here have *not* been independently re-confirmed by a second agent — treat severities as proposed, not adjudicated.

---

## Verdict

**No BLOCKER defects. The baseline is genuinely solid** — clean typecheck, 384/384 tests green in <1s, 0 npm vulnerabilities, a correct npm `files` allowlist, and a cross-OS CI matrix. The binary builds, packs, and launches.

**However, it is not yet "bulletproof" for unattended production use.** Every HIGH finding clusters around one theme: *faithful `claude -p` behaviour in the failure and forward-compat cases is not guaranteed.* The tool is excellent on the happy path and under-defended on the edges (silent event drops when claude-code evolves, missing terminal `result` events on error/timeout exits, an interrupt path that can wedge with no watchdog, and the live parity/interrupt harnesses not running in CI). For an experimental tool these are acceptable; for "production ready, few gaps as possible" they are the gap list.

## Severity summary

| Severity | Count |
|---|---|
| 🔴 BLOCKER | 0 |
| 🟠 HIGH | 9 |
| 🟡 MEDIUM | 18 |
| 🔵 LOW | 20 |
| ⚪ NIT | 22 |
| **Total** | **69** |

## Priority fix list (BLOCKER + HIGH)

### 1. 🟠 HIGH — Readiness-timeout, dispatch-loop, and backend-start failures shut down WITHOUT emitting a terminal stream-json result
*Dimension: error-resilience · confidence: confirmed*

- **What:** When Claude never becomes ready (invisible startup/trust/permission prompt, or unobservable PID status - precisely what the 30s READY_TIMEOUT_MS guards), clarp prints to stderr and exits 1 but stdout's stream-json stream ends with NO {type:"result"} event. A tool that shells out to `claude -p --output-format stream-json` and waits for the result message gets a truncated stream and may hang or misreport. Real `claude -p` always terminates with a result. This is the core parity break in the most common failure mode.
- **Evidence:** session.ts:435-447: readiness timer fires reportAsyncError("Dispatch loop failed", err) + requestShutdown(1) + opQueue.wake(), never calling output.emitResult. Identical no-result pattern at session.ts:122-125 (startPidWatcherAndBackend failure) and session.ts:127-130 (runDispatchLoop failure). reportAsyncError only writes stderr (session.ts:927-931). requestShutdown -> shutdown -> cleanup -> opts.onExit(code) (session.ts:915-919, 354-375, 905) wired to process.exit in cli.ts:118. emitResult fully supports an error terminator (output.ts:334-348, subtype "error", is_error:true).
- **Fix:** Before requestShutdown(1) on each terminal error path, emit a synthetic terminal result via output.emitResult("error", message, { durationMs, numTurns }) mirroring handleClaudeExit (session.ts:315), guarded by a resultEmitted flag to avoid duplicates.

### 2. 🟠 HIGH — Unknown content-block and delta types are silently dropped — no forward-compat when claude-code changes its output
*Dimension: protocol-parity · confidence: confirmed*

- **What:** When Anthropic/claude-code emits a block type clarp doesn't recognize, clarp emits an assistant message missing that block — silent semantic divergence from claude -p. Block targeting uses content[content.length-1] (lines 125, 145) rather than e.index (captured at 104-105 but unused for placement), so a skipped block also corrupts which block subsequent deltas/stops apply to. Downstream tools relying on faithful content arrays (thinking signatures, server tools, citations) get wrong data with no error.
- **Evidence:** src/message-assembler.ts:101-141. content_block_start only pushes a block for type 'text' | 'thinking' | 'tool_use' (lines 107-118); any other content_block.type (redacted_thinking, server_tool_use, web_search_tool_result, image, citations, future types) falls through and NO block is appended. content_block_delta only handles 'text_delta' | 'thinking_delta' | 'input_json_delta' (lines 128-139); other deltas (signature_delta for thinking signatures, citations_delta) are ignored. output.ts:118-119 suppresses raw 'assistant'/'user' SSE so the assembler is the ONLY source of those messages — a dropped block disappears entirely.
- **Fix:** Add a default passthrough branch in content_block_start (push the raw block verbatim) and content_block_delta (append raw delta), and place/target blocks by e.index. At minimum emit a verbose diagnostic when an unrecognized block/delta type is seen so drift is observable.

### 3. 🟠 HIGH — Parity harness not in CI — only frozen fixtures are validated
*Dimension: protocol-parity · confidence: confirmed*

- **What:** The core value prop (byte/semantically-faithful claude -p output) is never validated against a real claude binary in CI. Fixtures captured against claude-opus-4-7 in May 2026 will rot as claude-code changes its protocol while tests stay green — parity regressions stay invisible until a user hits broken output. This is the biggest systemic fidelity risk.
- **Evidence:** .github/workflows/ci.yml lines 26-29 run only `npm ci`, `npm run build`, `npm test`, `npm pack --dry-run`; the publish job (lines 44-46) likewise runs only ci/build/test. package.json:28-29 defines parity:stream / parity:interrupt (node scripts/parity-stream.mjs) as MANUAL scripts never invoked by CI. The parity tests (src/parity.test.ts:9-12, v03/v04-features.test.ts) load FROZEN snapshots from src/__fixtures__/*.jsonl (dated 2026-05-19); v03-features.test.ts:173 hardcodes model 'claude-opus-4-7'. They never run clarp's assembler against a live claude -p.
- **Fix:** Add a CI job (nightly or manual-trigger, since it needs a real subscription) that runs scripts/parity-stream.mjs and diffs clarp vs native claude -p. Record the claude-code version in fixtures and warn when the installed claude differs. Document a fixture-refresh procedure.

### 4. 🟠 HIGH — In-flight interrupt has no watchdog: if PID status never returns to idle, the session wedges
*Dimension: interrupt-cancellation · confidence: confirmed*

- **What:** A cancelled turn whose process does not report idle deadlocks the session: no result/error is emitted to the caller and the next pipelined prompt never runs. Because the readiness watchdog is suppressed during interrupts, the one mechanism designed to break stalls is disabled exactly when it is most needed.
- **Evidence:** completeInterrupt() (src/session.ts:665-675) is the ONLY place interruptInFlight is cleared, and it is called solely from handleStatusChange on status==="idle" (line 216) or from handleClaudeExit (line 307). The staged escalation (sendInterruptEscape/escalateInterrupt, src/session.ts:601-663) ends at process_sigterm with NO further timer and never force-clears interruptInFlight or finalizes the turn. Meanwhile the readiness watchdog explicitly excludes the interrupt window: shouldArmReadinessTimer() returns false when `this.interruptInFlight !== null` (src/session.ts:459). So while an interrupt is in flight, no readiness timeout is armed. If Claude's PID status file never transitions back to idle after SIGTERM (PID watcher stalls, status file not updated, or process is a zombie/orphan), interruptInFlight stays set, isReadyForPrompt() stays false (src/session.ts:552), no queued prompt is ever dispatched, and the dispatch loop blocks in opQueue.waitForChange() forever.
- **Fix:** Add a terminal deadline after the final escalation step (process_sigterm) that force-clears interruptInFlight, finalizes the turn (emit error/result), and either re-arms the readiness path or requests shutdown. Do not leave shouldArmReadinessTimer fully disabled for the entire interrupt lifetime with no alternative bound.

### 5. 🟠 HIGH — CI claims Windows/Linux/macOS support but never exercises the PTY stream-json round-trip on any OS
*Dimension: cross-platform · confidence: confirmed*

- **What:** A green CI badge across all three OSes proves only that TypeScript compiles, unit tests pass, and the tarball packs. The product's entire reason for existing (wrap claude in a PTY and proxy stream-json + control/permission requests + interrupts) is never integration-tested on any platform in CI. Windows ConPTY behavior (data encoding, CRLF, kill/interrupt semantics) is wholly unvalidated by automation, so 'Windows supported' is claimed-but-not-verified against the project's stated parity-reliability goal.
- **Evidence:** .github/workflows/ci.yml lines 14-29: matrix os:[ubuntu-latest,macos-latest,windows-latest] x node:[20,22,24], but the only steps are `npm ci`, `npm run build`, `npm test`, `npm pack --dry-run`. The harnesses that actually drive a PTY (package.json:28-30 -> parity:stream, parity:interrupt, probe:pty-interrupt -> scripts/parity-stream.mjs, scripts/pty-interrupt-probe.mjs) are NOT invoked anywhere in ci.yml.
- **Fix:** Add at least one CI job per OS that runs the parity/probe harness against a stub PTY child (a trivial echo program, no real claude needed) to exercise spawn -> onData -> kill/interrupt. Prioritize windows-latest since ConPTY differs most. Otherwise downgrade the README claim to label Windows/Linux as untested/experimental.

### 6. 🟠 HIGH — Wrapped claude (and its tool subprocesses) orphaned on SIGKILL/OOM/parent-death; no process group, no reaper
*Dimension: pty-lifecycle · confidence: confirmed*

- **What:** After clarp is force-killed or its parent dies, an interactive claude on the user's subscription keeps running unattended, possibly holding the session and spawning further work. Repeated under a flaky parent (CI, editors) this accumulates orphans. Directly undermines the 'reliable wrapper' goal.
- **Evidence:** pty-host.ts spawnClaude (lines 103-109) calls nodePty.spawn with {name,cols,rows,cwd,env} and NO detached/process-group option. grep for detached|setpgid|kill(-|killpg|setsid across src returned nothing. All teardown is cooperative: fatal-cleanup.ts only hooks 'uncaughtException','unhandledRejection','exit' (lines 51-53) and sends one ptyHandle.kill("SIGTERM") (line 30); cli.ts handles only SIGINT (line 130) and SIGTERM (line 133), no SIGHUP. SIGKILL is uncatchable. node-pty reaps only the direct child, so any subprocess claude spawned (its own tool runs) is reparented to init on orphan.
- **Fix:** Spawn claude in its own process group and signal the whole group on every kill path; add a SIGHUP handler; write a small status file (clarpPid+claudePid) and, on startup, reap any claude whose recorded clarp pid is dead. A periodic parent-liveness check is the practical substitute for PR_SET_PDEATHSIG in Node.

### 7. 🟠 HIGH — spawnClaude() and findClaude() — the real PTY spawn + binary resolution seam — have zero tests
*Dimension: testing-coverage · confidence: confirmed*

- **What:** The actual process launch, env merging (:97-101), spawn options (cols/rows/cwd/env at :104-108), onData/onExit wiring (:111-112), and OS-specific binary resolution are never executed by any test. A regression in spawn args, env propagation, or claude discovery on any of the three CI OSes would not be caught. This is the core of how clarp wraps `claude -p`.
- **Evidence:** pty-host.test.ts (141 lines, 15 tests) imports and tests sendPrompt, sendInterrupt, sendPermissionAllow/Deny, sendSlashCommand, normalizePtyKillSignal, and the spawn-helper repair helpers (file content confirmed, imports at lines 2-12). It does NOT import or exercise spawnClaude or findClaude. Those two functions (src/pty-host.ts:65-82 findClaude, :88-120 spawnClaude) contain the only real node-pty.spawn call (:103) and the only binary discovery: win32 uses `where claude.cmd` (:68), POSIX uses `which claude` (:76). No test in the repo references spawnClaude (the session/integration tests inject a fake handle instead).
- **Fix:** Add a test that drives spawnClaude against a trivial stub binary (e.g. a tiny node script that echoes input and exits) to cover spawn options, env merge, and onData/onExit wiring; and unit-test findClaude's win32 vs POSIX branches with execSync mocked, including the not-found error paths.

### 8. 🟠 HIGH — Faithful parity and real interrupt are only checked by manual harnesses not wired into CI
*Dimension: testing-coverage · confidence: confirmed*

- **What:** clarp's reason to exist is faithful stream-json parity with `claude -p` and reliable interruption against undocumented real claude-code behavior. A regression in stream-json shape, spawn args, or escape-sequence interrupt efficacy from a new claude-code version passes the enforced suite green; only a human remembering to run the parity harness catches it.
- **Evidence:** .github/workflows/ci.yml test job steps are exactly: `npm ci`, `npm run build`, `npm test`, `npm pack --dry-run` (lines 26-29; publish job mirrors). package.json defines parity:stream (scripts/parity-stream.mjs), parity:interrupt (scripts/parity-stream.mjs --cases scripts/cases-interrupt.json), probe:pty-interrupt (scripts/pty-interrupt-probe.mjs) but none is invoked by `test` (`vitest run`) or by CI. These harnesses require a real logged-in claude binary.
- **Fix:** Add an opt-in/nightly/on-release CI lane (gated on a real claude binary or recorded fixtures) that runs parity-stream.mjs and pty-interrupt-probe.mjs, and document them as a required pre-release manual gate in the release checklist.

### 9. 🟠 HIGH — Coverage cannot be measured: @vitest/coverage-v8 missing, no coverage config, no CI gate
*Dimension: testing-coverage · confidence: confirmed*

- **What:** There is no quantitative visibility into which branches of the 952-line session.ts state machine the 1377-line session.test.ts actually exercises, and no enforced floor. For experimental software riding undocumented claude-code behavior, untracked coverage lets error/teardown/race branches rot silently. Any 'good coverage' claim is currently unfalsifiable in CI.
- **Evidence:** `npx vitest run --coverage` fails: `MISSING DEPENDENCY  Cannot find dependency '@vitest/coverage-v8'` (command output). vitest.config.ts contains only `test: { include: ["src/**/*.test.ts"] }` with no coverage block (full content confirmed). package.json devDependencies are only @types/node, typescript, vitest; `test` is `vitest run` with no coverage flag.
- **Fix:** Add @vitest/coverage-v8, configure coverage in vitest.config.ts (include src/**/*.ts, exclude *.test.ts; text+lcov reporters), and add a CI coverage step with a threshold so regressions in the core state machine surface.

---

## Detailed findings by dimension

### Build, Test & Supply-Chain Ground Truth

All six baseline checks are GREEN on fresh runs from /Users/dn/Code/clarp. Types compile clean (tsc --noEmit exit 0), build produces dist/cli.js with no errors, all 384 tests across 17 files pass (0 fail, 0 skip) in ~0.7s, npm pack ships exactly the intended 47 files (dist/ JS+d.ts, bin/, scripts/, LICENSE, README, package.json) with NO source/test/secret/.tgz/.parity-runs leaks, npm audit reports 0 vulnerabilities, and the binary launches cleanly for --help (RC 0) and --version (prints "clarp 0.1.10"). The backbone is solid. Tests deliberately print expected warning/usage/JSON lines to stderr+stdout, and no source maps are emitted (no debug source leak). One important correction to note: an earlier set of numbers I computed was based on stale /tmp logs; the authoritative fresh figures are 384 tests / 17 files / 47 packed files.

<details>
<summary><strong>⚪ NIT</strong> — tsc --noEmit compiles clean (zero type errors) <em>(confirmed)</em></summary>

**Evidence:** `npx tsc --noEmit` from repo root -> EXIT_CODE: 0, no diagnostics. (The leading 'compinit/compdef' lines are fish/zsh interactive-shell noise from profile init, not tool errors.)

**Impact:** Types are sound even though there is no dedicated typecheck npm script; CI `build` (clean+tsc) will catch type regressions.

**Recommendation:** Optional: add a `typecheck` script aliasing `tsc --noEmit` for convenience.

</details>

<details>
<summary><strong>⚪ NIT</strong> — npm run build produces dist/cli.js with no errors <em>(confirmed)</em></summary>

**Evidence:** `npm run build` = `npm run clean && tsc` (clean does fs.rmSync('dist')) -> EXIT_CODE: 0, no tsc errors. Artifact present: dist/cli.js (5532 bytes).

**Impact:** Build pipeline works end-to-end; bin/clarp.js -> dist/cli.js entrypoint is generated.

**Recommendation:** None.

</details>

<details>
<summary><strong>⚪ NIT</strong> — Full test suite passes: 384/384 across 17 files, ~678ms <em>(confirmed)</em></summary>

**Evidence:** `npm test` (vitest run v4.1.6) -> EXIT_CODE: 0. 'Test Files 17 passed (17)', 'Tests 384 passed (384)', Duration 678ms. No failures, no skipped, no 'unhandled rejection', no leaked-handle/timer warnings reported by vitest.

**Impact:** Core state machine and parsing/filtering/PTY-host layers are well covered and green; suite is fast (no wall-clock-bound slowness observed this run).

**Recommendation:** None for correctness.

</details>

<details>
<summary><strong>⚪ NIT</strong> — Tests emit expected warning/usage/JSON lines to stdout+stderr (not failures) <em>(confirmed)</em></summary>

**Evidence:** Vitest output interleaves the help banner (twice), five 'clarp warning: Claude is waiting for permission, but stream-json control responses are not enabled...' lines, and system-status JSON like {"type":"system","subtype":"status","status":"idle",...}. All while 384/384 pass.

**Impact:** These are intentional assertions exercising the warning/help/output paths; they are not console errors or unhandled output. Cosmetically noisy in CI logs but harmless.

**Recommendation:** Optional: silence/capture these in the tests that assert them to keep CI logs clean. No action needed for correctness.

</details>

<details>
<summary><strong>⚪ NIT</strong> — npm pack ships exactly 47 intended files; no source/test/secret leaks <em>(confirmed)</em></summary>

**Evidence:** `npm pack --dry-run` -> total files: 47, package size 48.4 kB, unpacked 187.0 kB, clarp-cli-0.1.10.tgz. Contents: LICENSE, README.md, package.json, bin/clarp.js, dist/**/*.js + *.d.ts, and scripts/{repair-node-pty-spawn-helper.mjs, parity-stream.mjs, pty-interrupt-probe.mjs, cases-interrupt.json, cases-interrupt-no-sigint.json}. No .ts source, no test/ files, no secrets, no .tgz, no .parity-runs. Driven by package.json `files` allowlist (npm warns it ignores .npmignore in favor of `files`, expected).

**Impact:** Published tarball is clean and self-contained; the postinstall helper (repair-node-pty-spawn-helper.mjs) is correctly included so darwin spawn-helper chmod works on install.

**Recommendation:** None required. Optional: the dev-only parity harness scripts (parity-stream.mjs 14kB, pty-interrupt-probe.mjs 13.1kB, cases-*.json) ship to end users though they are not runtime-needed; could trim to shrink the package, low priority.

</details>

<details>
<summary><strong>⚪ NIT</strong> — No source maps emitted (no .map files in dist or tarball) <em>(confirmed)</em></summary>

**Evidence:** `find dist -name '*.map'` -> 0 files; tsconfig has no sourceMap setting. Pack list contains zero .map entries.

**Impact:** No original-source leak via maps, and no dangling map references. (Trade-off: installed package has no debug source maps, which is fine for a compiled CLI.)

**Recommendation:** None.

</details>

<details>
<summary><strong>⚪ NIT</strong> — npm audit: 0 vulnerabilities <em>(confirmed)</em></summary>

**Evidence:** `npm audit` -> EXIT_CODE: 0, 'found 0 vulnerabilities'. Single runtime dep (node-pty) plus dev deps in committed lockfile.

**Impact:** No known-vulnerable dependencies.

**Recommendation:** None.

</details>

<details>
<summary><strong>⚪ NIT</strong> — Binary launches cleanly for --help and --version <em>(confirmed)</em></summary>

**Evidence:** `node dist/cli.js --help` -> RC 0, prints 26-line usage banner ('clarp — Drop-in replacement for claude -p' with flags + pass-through list). `node dist/cli.js --version` -> RC 0, prints 'clarp 0.1.10' (matches package.json version).

**Impact:** Entry point starts without crashing on the two no-PTY informational paths; version string is in sync with the package.

**Recommendation:** None.

</details>


### Protocol Parity (core value prop)

clarp reconstructs the claude -p stream-json protocol from raw Anthropic SSE deltas (proxy.ts extractSSEEvents -> message-assembler.ts -> output.ts) and covers the main outbound event families well: system/init, assistant (emitted per content-block), user, result, tool_use, control_request/response, stream_event (only when --include-partial), post_turn_summary, rate_limit, api_retry, and a synthetic interrupted-user message. Inbound stdin control handles interrupt, can_use_tool, get_context_usage, set_model, and stop_task (session.ts:247-280). The documented happy paths are modeled and reasonably unit-tested. The two dominant fidelity risks are forward-compatibility (the assembler silently drops content-block/delta types it does not recognize, so clarp diverges silently as claude-code evolves) and validation (CI runs only vitest against frozen May-2026 fixtures; the live parity harness scripts/parity-stream.mjs is never run in CI, so real drift is invisible). Secondary risks: hardcoded init/result defaults that misrepresent state, a result field-name mismatch (cost_usd vs total_cost_usd), lossy transcript tailing, and permissive SSE/stdin parse paths that drop malformed/unrecognized data without diagnostics.

<details>
<summary><strong>🟠 HIGH</strong> — Unknown content-block and delta types are silently dropped — no forward-compat when claude-code changes its output <em>(confirmed)</em></summary>

**Evidence:** src/message-assembler.ts:101-141. content_block_start only pushes a block for type 'text' | 'thinking' | 'tool_use' (lines 107-118); any other content_block.type (redacted_thinking, server_tool_use, web_search_tool_result, image, citations, future types) falls through and NO block is appended. content_block_delta only handles 'text_delta' | 'thinking_delta' | 'input_json_delta' (lines 128-139); other deltas (signature_delta for thinking signatures, citations_delta) are ignored. output.ts:118-119 suppresses raw 'assistant'/'user' SSE so the assembler is the ONLY source of those messages — a dropped block disappears entirely.

**Impact:** When Anthropic/claude-code emits a block type clarp doesn't recognize, clarp emits an assistant message missing that block — silent semantic divergence from claude -p. Block targeting uses content[content.length-1] (lines 125, 145) rather than e.index (captured at 104-105 but unused for placement), so a skipped block also corrupts which block subsequent deltas/stops apply to. Downstream tools relying on faithful content arrays (thinking signatures, server tools, citations) get wrong data with no error.

**Recommendation:** Add a default passthrough branch in content_block_start (push the raw block verbatim) and content_block_delta (append raw delta), and place/target blocks by e.index. At minimum emit a verbose diagnostic when an unrecognized block/delta type is seen so drift is observable.

</details>

<details>
<summary><strong>🟠 HIGH</strong> — Parity harness not in CI — only frozen fixtures are validated <em>(confirmed)</em></summary>

**Evidence:** .github/workflows/ci.yml lines 26-29 run only `npm ci`, `npm run build`, `npm test`, `npm pack --dry-run`; the publish job (lines 44-46) likewise runs only ci/build/test. package.json:28-29 defines parity:stream / parity:interrupt (node scripts/parity-stream.mjs) as MANUAL scripts never invoked by CI. The parity tests (src/parity.test.ts:9-12, v03/v04-features.test.ts) load FROZEN snapshots from src/__fixtures__/*.jsonl (dated 2026-05-19); v03-features.test.ts:173 hardcodes model 'claude-opus-4-7'. They never run clarp's assembler against a live claude -p.

**Impact:** The core value prop (byte/semantically-faithful claude -p output) is never validated against a real claude binary in CI. Fixtures captured against claude-opus-4-7 in May 2026 will rot as claude-code changes its protocol while tests stay green — parity regressions stay invisible until a user hits broken output. This is the biggest systemic fidelity risk.

**Recommendation:** Add a CI job (nightly or manual-trigger, since it needs a real subscription) that runs scripts/parity-stream.mjs and diffs clarp vs native claude -p. Record the claude-code version in fixtures and warn when the installed claude differs. Document a fixture-refresh procedure.

</details>

<details>
<summary><strong>🟡 MEDIUM</strong> — result emits cost_usd, but claude -p (and the parity fixtures) use total_cost_usd <em>(likely)</em></summary>

**Evidence:** parity.test.ts:101 asserts the native fixture result has total_cost_usd (expect(typeof r.total_cost_usd).toBe('number')). But output.ts:350 emitResult only ever writes cost_usd from meta.costUsd — it never emits total_cost_usd. The parity test passes only because it reads the native fixture, not clarp's emitter output, which masks the divergence.

**Impact:** Field-name divergence on the result line: tools reading the documented claude -p field total_cost_usd get undefined from clarp's live output. A consumer tracking spend silently sees no cost.

**Recommendation:** Emit total_cost_usd (matching native claude -p) in emitResult, or emit both. Add an emitter-level test asserting the exact field name claude -p uses rather than only checking the fixture.

</details>

<details>
<summary><strong>🟡 MEDIUM</strong> — Hardcoded init/result defaults misrepresent claude state instead of reflecting it <em>(confirmed)</em></summary>

**Evidence:** output.ts:206-227 emitInit substitutes literals when data is missing: model 'unknown', apiKeySource 'none', claude_code_version 'unknown', output_style 'default', permissionMode 'default', fast_mode_state 'off', and empty arrays for tools/mcp_servers/slash_commands/agents/skills/plugins. These are emitted whenever the transcript init read is slow or fails — and transcript reading is best-effort (transcript-observer.ts polls on a 1s interval, starts late).

**Impact:** A consumer branching on init.model, init.tools, or init.permissionMode sees plausible-but-wrong values (model 'unknown', empty tools, permissionMode 'default' when the real session is bypassPermissions) at the very first event of every session if the transcript hasn't been read yet — silent semantic infidelity, and security-relevant for permissionMode.

**Recommendation:** Defer init emission until the real transcript init is read, or explicitly mark values as unknown rather than emitting confident placeholders — especially for permissionMode.

</details>

<details>
<summary><strong>🟡 MEDIUM</strong> — TranscriptObserver is lossy: 512KB initial-read cap + always-discarded leading line + 1s poll <em>(confirmed)</em></summary>

**Evidence:** transcript-observer.ts:43-45 sets offset = max(0, size - 512KB) on first poll and sets skipLeadingPartialLine when offset>0; lines 59-62 then discard everything up to the first newline (so even a complete line at the boundary is thrown away). Older events beyond the last 512KB are never emitted. Poll interval is 1s (line 30). De-dup by uuid (lines 87-91) forwards any line lacking a uuid unconditionally (possible duplicates).

**Impact:** On resumed/long sessions, early transcript-sourced events (init, prior summaries, history) are dropped, so clarp's stream is missing events a native claude -p resume would surface. Ordering relative to live SSE is approximate because transcript tailing is a separate polled channel from the proxy SSE channel.

**Recommendation:** Make the initial-read cap configurable/larger for resume, seek to a real newline boundary instead of discarding the first line unconditionally, and ensure the init line specifically is always read in full. Document that transcript tailing is lossy for history.

</details>

<details>
<summary><strong>🔵 LOW</strong> — Malformed/partial SSE frames and unrecognized SSE event types are dropped without diagnostics <em>(confirmed)</em></summary>

**Evidence:** proxy.ts:188-191 (extractSSEEvents) does try { parsed = JSON.parse(data); } catch {} — a frame whose data fails to parse is still pushed with parsed=undefined, and output.ts:88/115 require event.parsed to be an object, so such frames are silently skipped. Only the documented stream types are acted on (output.ts:121-122); any new top-level SSE event type claude emits is dropped unless verbose (output.ts:129). proxy.ts splits strictly on a blank-line block separator (line 174) and joins multi-line data with newline (line 187) which is correct, but there is no surfaced warning on parse failure.

**Impact:** Network-truncated or future-shaped SSE frames vanish from clarp output with no error, contributing to silent under-emission versus claude -p. Combined with the assembler drop behavior, multiple silent-loss paths exist.

**Recommendation:** Emit a verbose diagnostic when an SSE frame has data but parsed is undefined, and when an unrecognized top-level event type is seen, so drops are observable.

</details>

<details>
<summary><strong>🔵 LOW</strong> — tool_use input silently falls back to a raw partial_json string when JSON.parse fails <em>(confirmed)</em></summary>

**Evidence:** message-assembler.ts:132-149: input_json_delta accumulates partial_json into block.input as a string; content_block_stop attempts JSON.parse in a try/catch with empty catch {} (lines 147-149). On malformed/truncated JSON, input stays a raw string and is emitted as-is, and is also stored as lastToolUse (line 152), which feeds permission forwarding via output.ts getLastToolUse/emitControlRequest (output.ts:31-33, 271-285).

**Impact:** A truncated tool input yields a tool_use block whose input is a string instead of the object claude -p always emits, and the same malformed value is forwarded into can_use_tool control requests. Consumers expecting an object get a string, with no warning.

**Recommendation:** On parse failure, emit a diagnostic and/or set input to an explicit error sentinel rather than passing the raw string downstream.

</details>

<details>
<summary><strong>🔵 LOW</strong> — Per-block assistant emission with stop_reason:null depends on undocumented claude ordering <em>(confirmed)</em></summary>

**Evidence:** message-assembler.ts:154-161 calls onMessage on each content_block_stop with stop_reason hardcoded null and only the single completed block. The real message-level stop_reason captured at message_delta (lines 165-169) is never propagated to any emitted assistant message. v03-features.test.ts:65-70 codifies this as intended.

**Impact:** Matches current native claude -p ordering (assistant-per-block, null stop_reason) so it is faithful today, but is entirely dependent on claude-code's undocumented streaming order. If claude changes to consolidated assistant messages with a real stop_reason, clarp diverges and frozen fixtures won't catch it (ties to the no-live-CI-parity finding).

**Recommendation:** Keep, but guard with a live parity job so this ordering assumption is continuously verified against the installed claude version.

</details>

<details>
<summary><strong>🔵 LOW</strong> — Unknown inbound control_request subtypes are blanket-acked with success rather than rejected; non-text user content is dropped <em>(confirmed)</em></summary>

**Evidence:** session.ts:247-280: interrupt, get_context_usage, set_model, and stop_task are handled, but the final branch (lines 277-280) for any unknown subtype enqueues an op that acks success ('Unknown subtype: ack so callers relying on a response do not hang'). Separately, stdin-reader.ts:104-109 keeps only user content blocks where b.type === 'text', silently discarding image/other blocks a caller sends.

**Impact:** A caller sending a control_request subtype clarp doesn't implement gets a success response even though nothing happened (vs native claude -p which would actually perform or properly reject it). Multimodal/non-text inbound user content is lost before reaching the wrapped claude. Both are silent semantic divergences, though lower-impact since these are rarer inbound paths.

**Recommendation:** For unrecognized control subtypes, respond with an explicit error/unsupported response instead of a blanket success ack. Preserve or explicitly reject non-text user content blocks rather than dropping them silently.

</details>


### Interrupt / Cancellation / Concurrency

All concurrency in SessionController is funneled through a single FIFO/priority op-queue drained by one single-flight async loop (runDispatchLoop), and because Node is single-threaded the SIGINT handler, stdin handlers, and PID-status callbacks cannot truly interleave mid-statement. Interrupts are modeled as a single in-flight transaction with staged escalation (ESC -> Ctrl-C -> SIGINT -> SIGTERM) and are completed by observing Claude's PID status returning to idle; duplicate interrupts are coalesced, so an interrupt cannot be silently double-applied or lost while in flight. The state machine has solid unit coverage (384 tests pass) including many interrupt/timeout/queue cases. The real fragility is that the whole interrupt-completion path depends on the undocumented PID status file transitioning to idle: if that signal never arrives, the in-flight interrupt and any queued prompts wedge with no readiness watchdog covering them, and the cli.ts SIGINT path layers an unconditional SIGTERM timer plus a deferred queued interrupt that can outlive the turn it was meant for. The pty-interrupt-probe harness exists but is NOT wired into CI, so the most failure-prone behavior is untested on every platform.

<details>
<summary><strong>🟠 HIGH</strong> — In-flight interrupt has no watchdog: if PID status never returns to idle, the session wedges <em>(confirmed)</em></summary>

**Evidence:** completeInterrupt() (src/session.ts:665-675) is the ONLY place interruptInFlight is cleared, and it is called solely from handleStatusChange on status==="idle" (line 216) or from handleClaudeExit (line 307). The staged escalation (sendInterruptEscape/escalateInterrupt, src/session.ts:601-663) ends at process_sigterm with NO further timer and never force-clears interruptInFlight or finalizes the turn. Meanwhile the readiness watchdog explicitly excludes the interrupt window: shouldArmReadinessTimer() returns false when `this.interruptInFlight !== null` (src/session.ts:459). So while an interrupt is in flight, no readiness timeout is armed. If Claude's PID status file never transitions back to idle after SIGTERM (PID watcher stalls, status file not updated, or process is a zombie/orphan), interruptInFlight stays set, isReadyForPrompt() stays false (src/session.ts:552), no queued prompt is ever dispatched, and the dispatch loop blocks in opQueue.waitForChange() forever.

**Impact:** A cancelled turn whose process does not report idle deadlocks the session: no result/error is emitted to the caller and the next pipelined prompt never runs. Because the readiness watchdog is suppressed during interrupts, the one mechanism designed to break stalls is disabled exactly when it is most needed.

**Recommendation:** Add a terminal deadline after the final escalation step (process_sigterm) that force-clears interruptInFlight, finalizes the turn (emit error/result), and either re-arms the readiness path or requests shutdown. Do not leave shouldArmReadinessTimer fully disabled for the entire interrupt lifetime with no alternative bound.

</details>

<details>
<summary><strong>🟡 MEDIUM</strong> — cli.ts SIGINT always schedules an unconditional 2s SIGTERM kill, racing the graceful interrupt and the second-SIGINT escalation <em>(confirmed)</em></summary>

**Evidence:** interrupt() (src/session.ts:333-349): after enqueuing the interrupt op (or sending ESC), it unconditionally does `setTimeout(() => { if (!this.processExited) this.opts.ptyHandle.kill("SIGTERM"); }, 2000)`. This timer is created on EVERY SIGINT and is never cleared. cli.ts:130-131 calls controller.interrupt() on each SIGINT. So two Ctrl-C presses create two independent 2s SIGTERM timers, and even a single graceful interrupt that Claude honors within, say, 2.5s still gets SIGTERM'd mid-cleanup because the timer does not check whether the interrupt already completed (it only checks processExited).

**Impact:** A user pressing Ctrl-C to cancel one long turn (intending to keep the session alive for the next prompt) can have the entire Claude process SIGTERM-killed 2s later even though the interrupt succeeded, terminating the session and dropping any queued prompts. This breaks the 'cancel turn, continue session' semantics that the staged ESC/Ctrl-C interrupt machinery is built to provide.

**Recommendation:** Track and clear this kill timer when the interrupt transaction completes (completeInterrupt). Gate it on the interrupt still being in flight, not merely on processExited, so a successfully-cancelled turn does not get force-killed.

</details>

<details>
<summary><strong>🟡 MEDIUM</strong> — Deferred SIGINT interrupt can apply to the wrong (next) turn after the intended turn already ended <em>(likely)</em></summary>

**Evidence:** requestControlInterrupt (src/session.ts:579-588): when not turnActive but a prompt dispatch is pending/queued, the interrupt is deferred and waits for the prompt to actually start (pid_busy) before sending ESC (sendPendingDispatchInterrupt, src/session.ts:212, 594-599). The transaction persists across the gap. If the awaited turn never starts but a LATER status change fires busy (e.g. a different queued prompt), sendPendingDispatchInterrupt fires ESC against that newly-started turn. Combined with the coalescing in requestControlInterrupt (src/session.ts:559-563), a second user prompt can be interrupted by a SIGINT that was meant to cancel a turn that had not yet begun.

**Impact:** An interrupt intended for prompt A can land on prompt B, cancelling the wrong turn. Low frequency (requires precise queue timing) but a correctness violation of interrupt targeting.

**Recommendation:** Tag the interrupt transaction with the prompt/turn generation it targets and discard it if that specific dispatch is superseded, rather than binding to the next-observed busy.

</details>

<details>
<summary><strong>🟡 MEDIUM</strong> — pty-interrupt-probe and parity:interrupt harnesses are not run in CI <em>(confirmed)</em></summary>

**Evidence:** package.json defines `probe:pty-interrupt` and `parity:interrupt` scripts, and scripts/pty-interrupt-probe.mjs + scripts/cases-interrupt.json exist. But `grep -c probe .github/workflows/ci.yml` => 0 and `grep -rc pty-interrupt-probe .github/` => 0. CI `test` is `vitest run` only. The vitest interrupt cases (session.test.ts:421-757) all drive a FakeBackend and a fake ptyHandle that records writes/kills; they never exercise the real PID-status -> completeInterrupt dependency that findings #1/#2 hinge on, nor real ESC/Ctrl-C delivery to a live claude PTY.

**Impact:** The single most fragile, undocumented-behavior-dependent area (real PTY interrupt + PID-status idle transition) has zero automated coverage across the ubuntu/macos/windows x node{20,22,24} matrix. The two readiness-timeout regressions already in git history (4ee59af, ca78eaf) show this area regresses; CI would not catch a real-interrupt regression.

**Recommendation:** Add a CI smoke job (at least linux+macos) that runs probe:pty-interrupt and/or parity:interrupt with a bounded timeout, asserting an interrupt mid-turn finalizes the turn and unblocks the next prompt.

</details>

<details>
<summary><strong>🔵 LOW</strong> — SessionOpQueue.waitForChange uses wakeAll broadcast; benign now but fragile under any future multi-waiter use <em>(confirmed)</em></summary>

**Evidence:** waitForChange (src/session-op-queue.ts:69-72) pushes a resolver; wakeAll (84-87) resolves and splices ALL waiters on every enqueue/wake/close. This is correct only because runDispatchLoop is the sole consumer (single-flight: src/session.ts:420-425 awaits one waitForSessionOpChange at a time). There is no assertion or guard enforcing single-consumer; a second concurrent awaiter would all wake and could double-dequeue since dequeueControl/dequeueNormal are not coordinated with the wait.

**Impact:** No bug today (one consumer). But the queue offers no protection against the classic interrupt/prompt double-apply if a future change adds a second drainer. Given interrupt correctness is the stated concern, the invariant is load-bearing and undocumented.

**Recommendation:** Document the single-consumer invariant on SessionOpQueue, or make dequeue+wait atomic so the queue is safe regardless of consumer count.

</details>

<details>
<summary><strong>⚪ NIT</strong> — Unused PromptQueue module misleads about prompt buffering semantics <em>(confirmed)</em></summary>

**Evidence:** src/prompt-queue.ts implements a full async FIFO PromptQueue, but it is not imported by session.ts (grep shows no PromptQueue usage in session.ts; queueing is done via SessionOpQueue.normal). The file is dead relative to the live dispatch path.

**Impact:** A reader auditing concurrency may reason about PromptQueue's wakeOne/single-waiter semantics when the actual behavior is SessionOpQueue's wakeAll broadcast (src/session-op-queue.ts:84-87). Maintenance/comprehension hazard only.

**Recommendation:** Delete prompt-queue.ts (and its test, if any) or document that SessionOpQueue supersedes it.

</details>


### Error Handling & Resilience

SUPERSEDES my earlier interim outputs. Correction: an early draft of mine wrongly claimed the tool layer was returning fabricated data; that was a false alarm - the file contents were real and consistent (confirmed by two agreeing MD5 checksums of session.ts: 7633349a5b4e4fb3d8fef0180ba5ec2c, and full re-reads of every secondary file). All findings below are grounded in verified source. Overall: clarp has a solid resilience skeleton - top-level main().catch (cli.ts:157), a fatal-cleanup net wiring uncaughtException + unhandledRejection + exit (fatal-cleanup.ts:51-53), bounded shutdown/interrupt force-kill timers (session.ts:346-348, 362-371), and disciplined best-effort catches around all filesystem/transcript/PID parsing (pid-watcher, transcript-observer) and proxy SSE/body parsing. Empty catches are appropriate (they protect byte-passthrough and polling). The central weakness for THIS dimension is that several terminal error paths exit the process WITHOUT emitting a stream-json result event, so a caller reading stdout for a terminating {type:\"result\"} sees a truncated stream rather than a well-formed error result - breaking faithful `claude -p` parity exactly in the failure cases. A secondary concern: ProxyBackend.emit() can throw synchronously from inside HTTP server callbacks, reaching the process only via the unhandledRejection/uncaughtException net, which itself does not emit a result.

<details>
<summary><strong>🟠 HIGH</strong> — Readiness-timeout, dispatch-loop, and backend-start failures shut down WITHOUT emitting a terminal stream-json result <em>(confirmed)</em></summary>

**Evidence:** session.ts:435-447: readiness timer fires reportAsyncError("Dispatch loop failed", err) + requestShutdown(1) + opQueue.wake(), never calling output.emitResult. Identical no-result pattern at session.ts:122-125 (startPidWatcherAndBackend failure) and session.ts:127-130 (runDispatchLoop failure). reportAsyncError only writes stderr (session.ts:927-931). requestShutdown -> shutdown -> cleanup -> opts.onExit(code) (session.ts:915-919, 354-375, 905) wired to process.exit in cli.ts:118. emitResult fully supports an error terminator (output.ts:334-348, subtype "error", is_error:true).

**Impact:** When Claude never becomes ready (invisible startup/trust/permission prompt, or unobservable PID status - precisely what the 30s READY_TIMEOUT_MS guards), clarp prints to stderr and exits 1 but stdout's stream-json stream ends with NO {type:"result"} event. A tool that shells out to `claude -p --output-format stream-json` and waits for the result message gets a truncated stream and may hang or misreport. Real `claude -p` always terminates with a result. This is the core parity break in the most common failure mode.

**Recommendation:** Before requestShutdown(1) on each terminal error path, emit a synthetic terminal result via output.emitResult("error", message, { durationMs, numTurns }) mirroring handleClaudeExit (session.ts:315), guarded by a resultEmitted flag to avoid duplicates.

</details>

<details>
<summary><strong>🟡 MEDIUM</strong> — Fatal handlers and main().catch exit without flushing a terminal stream-json result <em>(confirmed)</em></summary>

**Evidence:** fatal-cleanup.ts:35-45: onUncaughtException/onUnhandledRejection write `clarp fatal: ...` to stderr, killChild(), proc.exit(1) - no stdout result. cli.ts:157-164: main().catch writes stderr + process.exit(1) - no stdout result. These are the last-resort net for any uncaught throw, including ProxyBackend.emit() throwing from an HTTP callback (proxy-backend.ts:99 buffer-cap; :86 duplicate subscriber).

**Impact:** Any unexpected throw/rejection terminates clarp with a truncated stdout stream containing no terminal result. Same parity break as the prior finding, for the unexpected-error class. Acceptable as a true last resort, but combined with the readiness/dispatch gaps it means multiple realistic failure modes never produce a parseable terminator.

**Recommendation:** Have the fatal handlers best-effort write a minimal valid terminal result to stdout (e.g. {type:"result",subtype:"error_during_execution",is_error:true}) before process.exit.

</details>

<details>
<summary><strong>🟡 MEDIUM</strong> — handleClaudeExit emits a result only when a turn is active; startup or post-turn crashes exit silently <em>(confirmed)</em></summary>

**Evidence:** session.ts:302-320: output.emitResult is inside `if (this.turnActive)` (lines 308-318). If Claude crashes after spawn but before the first turn goes busy (turnActive still false), or after a turn completed (turnActive reset at session.ts:685), the method skips emitResult and goes straight to requestCleanup. PTY onExit routes here via cli.ts:95-106.

**Impact:** A claude crash during startup (bad args, instant exit, OOM before first turn) yields no terminal stream-json result on stdout. In stream-json input mode the caller may keep waiting. Exit code is propagated but the stream itself is not cleanly terminated for parsers keying on the result event.

**Recommendation:** Track a session-level resultEmitted flag; in handleClaudeExit, when code != 0 and no result has been emitted, emit a terminal error result regardless of turnActive.

</details>

<details>
<summary><strong>🔵 LOW</strong> — ProxyBackend.emit() throws synchronously inside HTTP server callbacks <em>(likely)</em></summary>

**Evidence:** proxy-backend.ts:93-102: emit() throws when buffer.length >= STARTUP_BUFFER_CAP (10_000) before a subscriber attaches (line 99), and onObservation throws on a second subscriber (line 86). emit() is invoked from proxy callbacks (onSSEEvent line 40, onProxyError line 44, onRequestEnd line 49, onRateLimit line 52) which run inside the http.createServer request handler (proxy.ts:39, 105-119). A throw there is an uncaught exception in an http callback, surfacing only via fatal-cleanup's uncaughtException handler.

**Impact:** Under a flood of SSE/rate-limit observations before the SessionController subscribes (e.g. backend start delayed by the 1500ms pidWatcherTimer, session.ts:121-126), emit can exceed the cap and throw, taking down the whole process via the fatal net with no terminal result (see prior finding). Narrow window but plausible on a very chatty startup.

**Recommendation:** Make emit() drop-oldest or count-and-warn instead of throwing once the cap is hit; reserve throwing for genuine programming errors, not runtime overflow during normal startup buffering.

</details>

<details>
<summary><strong>🔵 LOW</strong> — Interrupt kill-fallback may skip the interrupted-turn result if turnActive was already cleared <em>(likely)</em></summary>

**Evidence:** session.ts:333-349: interrupt() sends the interrupt then setTimeout(2000)->ptyHandle.kill("SIGTERM") if not exited. The SIGTERM-driven exit flows through PTY onExit->handleClaudeExit, which only emits a result if turnActive (session.ts:308). The error_during_execution interrupted-turn result (completeInterruptedTurn, session.ts:733-746) is reached only via the pid_idle transcript path, not the kill fallback.

**Impact:** If an interrupt must escalate to killing the PTY (wedged Claude) after turnActive was cleared, the caller may not get the error_during_execution result a clean interrupt produces - exactly the wedged-Claude case resilience should cover.

**Recommendation:** Converge the kill-fallback path on the same terminal-result emission as completeInterruptedTurn, or emit a result in handleClaudeExit whenever an interrupt was in flight (interruptInFlight != null).

</details>

<details>
<summary><strong>⚪ NIT</strong> — Strengths: bounded timeouts, complete timer cleanup, and appropriate silent catches <em>(confirmed)</em></summary>

**Evidence:** shutdown() forceExitTimer (3s, session.ts:362-371) and interrupt() SIGTERM fallback (2s, session.ts:346-348) prevent hangs on a dead Claude; cleanup() clears forceExit/pidWatcher/emptyTurn/interrupt/readiness timers (session.ts:886-896). All FS/transcript/PID parsing uses try/catch returning safe defaults (pid-watcher.ts:159-165, transcript-observer.ts:68-71,83-93). stdin-reader caps single lines at 1MB to prevent OOM (stdin-reader.ts:3,42-58) and tolerates malformed JSON (stdin-reader.ts:91-97). Proxy tees bytes verbatim and only swallows parse errors of its own observation copy (proxy.ts:62-68,189).

**Impact:** Positive: no indefinite hangs during shutdown/interrupt, no timer leaks, and observation/polling failures degrade to no-ops rather than crashing. These are genuine resilience strengths; the remaining gap is purely that some timeout/error-driven exits do not emit a terminal result (covered above).

**Recommendation:** None. Preserve these patterns; focus remediation on guaranteeing a terminal stream-json result on every exit path.

</details>


### PTY & Process Lifecycle

I reviewed all four target files plus the full src/session.ts (952 lines) and the two readiness-timeout commits. clarp's shutdown logic is reasonably layered (fatal-cleanup handlers, a 3s force-exit timer, an escalating interrupt ladder ESC -> Ctrl-C -> SIGINT -> SIGTERM), and the hidden-PTY design correctly avoids touching the user's real TTY raw mode. The dominant lifecycle risk is ORPHANING: the wrapped claude (and any tool grandchildren it spawns) is spawned without a process group and is only ever killed with cooperative single SIGTERMs, so a SIGKILL/OOM/parent-death of clarp leaves claude running with no reaper and no on-disk record to clean it up later. The readiness timeout is a 30s watchdog that the recent commits narrowed to avoid firing during active turns; its arming predicate now looks correct, but on timeout it shuts the whole session down with a single SIGTERM, inheriting the same orphan weakness.

<details>
<summary><strong>🟠 HIGH</strong> — Wrapped claude (and its tool subprocesses) orphaned on SIGKILL/OOM/parent-death; no process group, no reaper <em>(confirmed)</em></summary>

**Evidence:** pty-host.ts spawnClaude (lines 103-109) calls nodePty.spawn with {name,cols,rows,cwd,env} and NO detached/process-group option. grep for detached|setpgid|kill(-|killpg|setsid across src returned nothing. All teardown is cooperative: fatal-cleanup.ts only hooks 'uncaughtException','unhandledRejection','exit' (lines 51-53) and sends one ptyHandle.kill("SIGTERM") (line 30); cli.ts handles only SIGINT (line 130) and SIGTERM (line 133), no SIGHUP. SIGKILL is uncatchable. node-pty reaps only the direct child, so any subprocess claude spawned (its own tool runs) is reparented to init on orphan.

**Impact:** After clarp is force-killed or its parent dies, an interactive claude on the user's subscription keeps running unattended, possibly holding the session and spawning further work. Repeated under a flaky parent (CI, editors) this accumulates orphans. Directly undermines the 'reliable wrapper' goal.

**Recommendation:** Spawn claude in its own process group and signal the whole group on every kill path; add a SIGHUP handler; write a small status file (clarpPid+claudePid) and, on startup, reap any claude whose recorded clarp pid is dead. A periodic parent-liveness check is the practical substitute for PR_SET_PDEATHSIG in Node.

</details>

<details>
<summary><strong>🟡 MEDIUM</strong> — Kill paths never escalate a stuck PTY to SIGKILL <em>(confirmed)</em></summary>

**Evidence:** Every PTY kill in the codebase is SIGTERM or softer: fatal-cleanup.ts line 30 (SIGTERM), session.ts shutdown line 364 (SIGTERM), interrupt() line 347 (SIGTERM after 2s), the interrupt ladder tops out at process_sigterm (lines 658-662), cli.ts line 80 (SIGTERM). No SIGKILL is sent anywhere. shutdown()'s forceExitTimer (line 365-370) only flips processExited=true and calls requestCleanup after 3s — it gives up waiting for claude but does NOT send a stronger signal, so a claude ignoring SIGTERM survives while clarp exits.

**Impact:** A wedged claude (mid tool-call, blocked IO, ignoring SIGTERM) is left alive even on a 'clean' shutdown when the 3s force-exit timer fires, recreating the orphan scenario without any abnormal clarp death.

**Recommendation:** On the forceExitTimer expiry (and in fatal cleanup), escalate to ptyHandle.kill("SIGKILL") (to the process group) before declaring the child gone.

</details>

<details>
<summary><strong>🟡 MEDIUM</strong> — process 'exit' handler is the weakest cleanup and cannot confirm the child died <em>(confirmed)</em></summary>

**Evidence:** fatal-cleanup.ts registers onExit=()=>killChild() (lines 47-49,53). Node's 'exit' event is synchronous: killChild() fires one ptyHandle.kill("SIGTERM") (line 30, errors swallowed) and returns with no ability to await, verify, or escalate. This is the only safety net for exit paths that bypass controller.shutdown.

**Impact:** Last-resort cleanup is a single fire-and-forget SIGTERM with no confirmation; if it is dropped or claude is mid-fork, the child survives.

**Recommendation:** Ensure the primary awaited path (controller.shutdown -> cleanup) reliably kills+confirms claude; treat 'exit' as best-effort and pair with the process-group/reaper fix above.

</details>

<details>
<summary><strong>🟡 MEDIUM</strong> — No clarp-owned PID/status file; PidWatcher is read-only with no cleanup <em>(confirmed)</em></summary>

**Evidence:** pid-watcher.ts only READS ~/.claude/sessions/<pid>.json (readPidFile lines 159-165) and ~/.claude/projects transcripts; it never writes a clarp lifecycle file and there is no unlink/cleanup logic in pid-watcher.ts or cli.ts. The status/waitingFor it consumes are Claude's own fields, not clarp's.

**Impact:** There is no on-disk record an external supervisor or a later clarp run could use to detect and reap an orphaned claude, and clarp cannot self-detect a stale prior instance. Missing safety net that compounds the orphaning finding.

**Recommendation:** If a reaper is added, atomically write {clarpPid,claudePid,startedAt} on spawn and unlink on clean shutdown; scan for stale files (dead clarpPid) on startup and kill any surviving claudePid.

</details>

<details>
<summary><strong>🔵 LOW</strong> — Readiness timeout shuts down the whole session but only via a single SIGTERM <em>(confirmed)</em></summary>

**Evidence:** session.ts waitForSessionOpChange arms readinessTimer = setTimeout(... READY_TIMEOUT_MS=30000 ...) (lines 434-447); on fire it calls reportAsyncError + requestShutdown(1) (lines 444-445). requestShutdown -> shutdown (line 916) -> kill("SIGTERM") + 3s forceExitTimer (lines 364-370). So a true readiness hang triggers the same non-escalating SIGTERM teardown as everything else.

**Impact:** If claude is genuinely stuck (e.g. a hidden prompt clarp cannot answer), the readiness watchdog correctly aborts clarp after 30s but may leave the stuck claude alive (see SIGKILL-escalation finding).

**Recommendation:** Have the readiness-timeout teardown escalate to SIGKILL of the process group, since by definition claude is non-responsive when this fires.

</details>

<details>
<summary><strong>🔵 LOW</strong> — Readiness timer arming predicate looks correct after recent fixes; verify the queued-prompt re-arm <em>(likely)</em></summary>

**Evidence:** Recent commits ca78eaf 'avoid readiness timeout during active turns' and 4ee59af 'restore queued readiness timeout' indicate prior false-trigger and failure-to-arm bugs. Current shouldArmReadinessTimer (lines 453-464) requires normalLength>0 && !isReadyForPrompt && !promptDispatchInFlight && interruptInFlight===null && !processExited && !shuttingDown && (!turnActive || blockedOnPermission). markReady() (line 522) clears the timer on ready, and the timer callback re-checks shouldArmReadinessTimer before firing (line 437). This correctly avoids firing during a legitimately long active turn (turnActive true and not permission-blocked => not armed) while still arming when a queued prompt cannot be dispatched. Tests at session.test.ts:421/454 cover startup no-op cases.

**Impact:** Low: the logic appears sound; residual risk is a subtle state where a prompt is queued but none of the gating flags reflect 'we are legitimately waiting on claude', which could still false-arm or fail to arm. Two fixes in one night suggest this state machine is fragile.

**Recommendation:** Add a regression test asserting a long active turn (>30s, turnActive true) never trips readiness, and one asserting a prompt queued while claude is stuck at startup DOES trip it after 30s. Keep the timer callback's re-check (line 437) as the safety guard.

</details>

<details>
<summary><strong>⚪ NIT</strong> — Hidden-PTY design correctly avoids breaking the user's real terminal raw mode <em>(confirmed)</em></summary>

**Evidence:** claude runs inside node-pty's own xterm-256color terminal (pty-host.ts lines 103-109); all of claude's TUI raw-mode manipulation stays inside that PTY. grep for setRawMode/isRaw across src found none — clarp never touches process.stdin raw mode; stdin-reader.ts only uses input.pause()/resume() (lines 47,70,82). So clarp cannot leave the caller's terminal in raw/broken mode.

**Impact:** Positive finding: terminal-corruption risk is structurally avoided by the design.

**Recommendation:** Keep it this way; never call process.stdin.setRawMode on the real TTY.

</details>

<details>
<summary><strong>⚪ NIT</strong> — markChildExited / processExited guards prevent signaling an already-reaped pid <em>(confirmed)</em></summary>

**Evidence:** fatal-cleanup.ts killChild() is guarded by childExited (line 28), set via markChildExited() which cli.ts onExit calls first (line 96). session.ts interrupt() (line 347), shutdown() (line 362), and forceExitTimer all check processExited before killing. So clarp avoids sending SIGTERM to a pid that may have been recycled after claude exited.

**Impact:** Positive: reduces risk of stray signals to an unrelated process that reused claude's pid.

**Recommendation:** No action; ensure markChildExited() remains called on all exit branches (currently in cli.ts onExit and the early-exit path line 144).

</details>


### Input Robustness & Validation

Incoming stream-json parsing is notably more defensive than a first glance suggests: stdin-reader.ts enforces a 1 MiB cap on both the accumulating buffer and each individual line before JSON.parse, catches malformed JSON and routes it to onMalformedLine rather than crashing, and handles EOF cleanly (stdin-reader.ts:3,42-58,91-97,63-69). Arg parsing is a strict allowlist that THROWS on any unrecognized flag (args.ts:261) and validates --input-format/--output-format against fixed sets, so the earlier concern about blind flag injection into the claude child does not hold. The real residual gaps are: unbounded buffering in text-prompt mode, unchecked content-block field types, no backpressure between stdin and the op queue / PTY, and silent dropping of unsupported message subtypes. None of these crash clarp on a single malformed line; the meaningful risk is memory growth under adversarial or slow-consumer conditions.

<details>
<summary><strong>🟡 MEDIUM</strong> — Text-prompt stdin mode buffers all input with no size limit <em>(confirmed)</em></summary>

**Evidence:** stdin-reader.ts:73-83 startTextPromptMode(): 'const chunks: string[] = []; this.input.on("data", (c) => chunks.push(c)); this.input.on("end", () => { const text = chunks.join("").trim(); ... })'. Unlike startStreamJsonMode (which enforces MAX_STREAM_JSON_LINE_BYTES = 1024*1024 at lines 42-58), the text path has no cap and accumulates the entire stdin into memory before emitting.

**Impact:** When clarp is used in its documented default text mode (e.g. 'clarp -p - < big.txt' or a pipe), an unbounded or very large stdin is fully buffered and then duplicated by join(), so a multi-hundred-MB input can spike RSS to several multiples and OOM-kill the process before the prompt is ever sent. This is the common invocation path, so it is more exposed than the guarded stream-json path.

**Recommendation:** Apply the same MAX byte cap (or a configurable limit) to the text-prompt accumulator, erroring out or truncating with a clear message instead of buffering without bound.

</details>

<details>
<summary><strong>🟡 MEDIUM</strong> — No backpressure between stdin reader, op queue, and PTY (unbounded queue growth) <em>(likely)</em></summary>

**Evidence:** Each accepted user message calls SessionController.enqueuePrompt -> opQueue.enqueue({type:'prompt'}) (session.ts:240-242) with no depth check; drainage only happens when isReadyForPrompt() is true (session.ts:466-478, 538-556), which is false while a turn is active or while blocked on an unanswered permission/trust prompt. The stream-json reader keeps reading and enqueuing regardless (stdin-reader.ts:40-62). The 1 MiB cap bounds a single line but not the number of queued messages.

**Impact:** A caller that streams many user messages while the wrapped claude is busy or stalled (e.g. waiting on a permission prompt the caller never answers) grows the in-memory op queue without limit, and the stdin reader never pauses to apply backpressure. Sustained input against a stalled claude leads to unbounded memory growth.

**Recommendation:** Cap op-queue depth (reject/emit an error once a threshold is exceeded) and/or pause the stdin reader when the queue is backed up, resuming on drain.

</details>

<details>
<summary><strong>🔵 LOW</strong> — Content-block text field is cast to string without validation <em>(confirmed)</em></summary>

**Evidence:** stdin-reader.ts:104-108: 'else if (Array.isArray(msg.content)) { content = (msg.content as Array<Record<string, unknown>>).filter((b) => b.type === "text").map((b) => b.text as string).join(""); }'. b.text is cast 'as string' with no typeof check; a block like {"type":"text","text":123} or {"type":"text"} (missing text) yields the number or undefined, which join() coerces to '123' / 'undefined'.

**Impact:** A malformed user message whose text block has a non-string 'text' produces a corrupted prompt (e.g. literal 'undefined' or a stringified number) forwarded into the wrapped claude, silently diverging from what the calling tool intended. No crash, but faithful parity is broken for malformed-but-parseable input.

**Recommendation:** Filter content blocks to those where typeof b.text === 'string' before joining, dropping or rejecting non-string text fields.

</details>

<details>
<summary><strong>🔵 LOW</strong> — Unrecognized stream-json message types and control subtypes are silently dropped <em>(confirmed)</em></summary>

**Evidence:** stdin-reader.ts:99-120 only handles type 'user', 'control_request', 'control_response', 'keep_alive'; any other type falls through with no callback and no onMalformedLine notice. Similarly session.ts:247-281 handleControlRequest only acts on subtypes interrupt/get_context_usage/set_model/stop_task; control_response with a non-matching request_id is dropped at session.ts:288 ('if (requestId !== this.pendingPermissionRequestId) return;').

**Impact:** If the calling tool sends a message type or control subtype that real 'claude -p' would understand but clarp does not, the message is silently ignored with no error surfaced, so the caller cannot distinguish 'unsupported' from 'lost'. This is a faithful-parity gap rather than a crash.

**Recommendation:** Emit a diagnostic (via onMalformedLine or a stderr/notice) for recognized-shape-but-unsupported types/subtypes so callers can detect unhandled protocol messages instead of silent drops.

</details>

<details>
<summary><strong>🔵 LOW</strong> — Non-UTF8 stdin is silently lossily decoded rather than rejected <em>(likely)</em></summary>

**Evidence:** stdin-reader.ts:39,75 set encoding 'utf8' on the stream; invalid byte sequences are decoded to U+FFFD replacement characters by Node's StringDecoder with no detection. Parsed user content is then forwarded verbatim into the PTY by the session layer.

**Impact:** Binary or non-UTF8 input is neither rejected nor flagged; it becomes replacement characters, so a caller piping non-UTF8 content gets silently corrupted prompts. Low risk because JSON framing prevents stream corruption, but it is a silent fidelity loss.

**Recommendation:** Decide explicitly whether to reject non-UTF8 lines (vs. silent replacement) and document the chosen behavior; low priority unless byte-faithful parity is required.

</details>

<details>
<summary><strong>⚪ NIT</strong> — Unknown CLI flags are rejected, not injected into claude (verified safe; corrects a common concern) <em>(confirmed)</em></summary>

**Evidence:** args.ts:259-266: for any token starting with '-', 'if (!KNOWN_CLAUDE_FLAGS.has(flagName)) throwUnknownOption(arg);' before pushing to claudeArgs. throwUnknownOption (args.ts:133-135) throws "error: unknown option '...'". Boolean flags given an '=' value also throw (args.ts:262). cli.test.ts:533-544 asserts these throws.

**Impact:** There is no arbitrary-flag passthrough channel: a caller cannot smuggle unrecognized flags into the claude child; they must be on the maintained allowlist (which does include sensitive flags like --dangerously-skip-permissions, but those are explicit and documented). Recorded to document that this vector was checked and is controlled.

**Recommendation:** No action needed beyond keeping the allowlist curated; consider noting in docs that security-sensitive allowlisted flags (--dangerously-skip-permissions, --mcp-config, --add-dir) are forwarded as-is.

</details>

<details>
<summary><strong>⚪ NIT</strong> — Per-line and buffer size caps for stream-json input are present and correct (verified safe) <em>(confirmed)</em></summary>

**Evidence:** stdin-reader.ts:3 'const MAX_STREAM_JSON_LINE_BYTES = 1024 * 1024;'; lines 42-49 abort and emit onMalformedLine + onEof if the accumulating buffer exceeds the cap before a newline; lines 54-58 skip any single line over the cap; lines 91-97 catch JSON.parse errors and route to onMalformedLine without throwing.

**Impact:** A single unbounded or malformed stream-json line cannot OOM or crash the process in stream-json mode; this previously-suspected vector is mitigated. Recorded for completeness.

**Recommendation:** No action needed for stream-json mode; extend the same guarantee to text-prompt mode (see separate finding).

</details>


### Security & Trust Boundaries

clarp's trust-boundary design is reasonable for its experimental purpose. The full environment is forwarded to the spawned claude child (required, and matching how claude -p already runs) and is never serialized into any log. The API debug logger redacts by default (logs lengths and sha256 prefixes, not raw text) and writes to stderr; raw text previews are a separate explicit opt-in. The postinstall chmod is tightly path-constrained and stat-gated. npm audit reports 0 vulnerabilities. The two areas worth attention are the workspace-trust auto-confirm (gated behind --dangerously-skip-permissions, so it inherits that flag's broad meaning) and the verbatim, unfiltered control-request forwarding path (the block-list is empty), where clarp adds no defense-in-depth of its own.

<details>
<summary><strong>🟡 MEDIUM</strong> — Workspace-trust prompt auto-confirm is bundled into --dangerously-skip-permissions rather than its own opt-in <em>(confirmed)</em></summary>

**Evidence:** src/claude-prompts.ts:14-16 shouldAutoConfirmWorkspaceTrust returns claudeArgs.includes('--dangerously-skip-permissions'). src/cli.ts:59-67: when that flag is present and the trust prompt is detected, clarp writes '\r' to the PTY to answer 'Yes, I trust this folder' automatically (cli.ts:66). When the flag is absent, clarp instead errors out and shuts down (cli.ts:69-81), so the human trust gate is preserved.

**Impact:** Claude Code's 'Quick safety check: Is this a project you created or one you trust?' prompt exists to stop a session from auto-loading project-scoped settings/hooks from an untrusted directory. clarp ties auto-trust to --dangerously-skip-permissions, which many CI users pass routinely (README.md:417 explicitly tells CI users to pass it). The result is that the workspace-trust decision and the permission-skip decision cannot be made independently: anyone who needed non-interactive permission skipping also silently gets auto-trust of whatever directory clarp is pointed at, including an attacker-controlled clone. The fail-closed default (without the flag) is good; the coupling is the concern.

**Recommendation:** Separate the two concerns: gate workspace-trust auto-confirm behind its own explicit flag/env (e.g. CLARP_AUTO_TRUST) defaulting OFF, independent of --dangerously-skip-permissions, so users can skip tool-permission prompts without also blanket-trusting an arbitrary directory. At minimum, document the coupling prominently as a security note.

</details>

<details>
<summary><strong>🔵 LOW</strong> — Control-request forwarding has an empty block-list; clarp adds no independent permission/control validation <em>(confirmed)</em></summary>

**Evidence:** src/message-request-filter.ts contains only session-title detection logic; there is no general control-request block-list in the codebase (the BLOCKED_SUBTYPES set I expected does not exist). src/session.ts:247-281 handleControlRequest forwards interrupt/get_context_usage/set_model/stop_task with no allow-list check. src/session.ts:286-297 handleControlResponse resolves a pending permission purely by matching requestId === this.pendingPermissionRequestId, with no authentication of the responder; a matching allow becomes sendPermissionAllow (session.ts:513-519 -> pty-host.ts:153-155 writes '\r').

**Impact:** clarp is a transparent broker between the caller and claude: it neither auto-approves nor independently sanitizes control/permission traffic, which is the correct default since the real authorization lives in claude. However it also provides zero defense-in-depth. A caller that controls stdin fully controls the control channel and can approve claude's permission prompts by sending behavior:'allow' for the in-flight requestId. This is inherent to faithfully proxying claude -p (the same caller could pass --dangerously-skip-permissions directly), so it is not a new privilege escalation, but operators should not assume clarp adds a safety layer.

**Recommendation:** Document explicitly that clarp performs no independent permission enforcement so integrators do not over-trust it. Optionally validate inbound control_request subtypes against an allow-list and verify the model's tool-use id matches before translating an allow into a PTY keystroke.

</details>

<details>
<summary><strong>🔵 LOW</strong> — Claude binary path and all CLI args come from caller-controlled input with no allow-list (argv passthrough, no shell) <em>(confirmed)</em></summary>

**Evidence:** src/pty-host.ts:65-82 findClaude resolves via `which claude` / `where claude.cmd` (PATH-dependent). src/pty-host.ts:103-109 nodePty.spawn(claudePath, args, ...) is argv-based (no shell), so there is no classic command-injection. src/args.ts:259-266 pushes every recognized-but-unhandled flag straight into claudeArgs; cli.ts:51-52 appends the prompt. Dangerous claude flags (--dangerously-skip-permissions, --add-dir, --mcp-config, --settings, --plugin-url) are all in the known-flags allow-list (args.ts:21-56) and forwarded verbatim.

**Impact:** Because spawn does not invoke a shell, prompt/arg content cannot inject shell commands. But there is no restriction on which claude flags pass through, so a caller can enable permission-disabling or directory-expanding behavior in the wrapped claude. This matches the stated drop-in goal (the caller already controls those flags when invoking claude directly), so risk is low. claude is resolved from PATH, so an attacker who controls PATH could shadow the binary — standard PATH-trust assumption, not clarp-specific.

**Recommendation:** Acceptable for the stated purpose. Consider emitting a stderr warning when permission-disabling flags are forwarded, and document that forwarded args are trusted inputs.

</details>

<details>
<summary><strong>⚪ NIT</strong> — Child environment forwards all secrets/tokens by design but is never logged (no leak path) <em>(confirmed)</em></summary>

**Evidence:** src/backends/proxy-backend.ts:64-67 getClaudeEnv only adds ANTHROPIC_BASE_URL pointing at the local 127.0.0.1 proxy. src/pty-host.ts:97-101 merges full process.env then overlays that. Grep across session.ts/proxy-backend.ts/pty-host.ts/api-debug.ts found no callsite that serializes process.env or getClaudeEnv() into a log. src/api-debug.ts:32-49 logs only model/counts/lengths/sha256; it never reads headers or env.

**Impact:** Full process.env inheritance into the child is required for claude to authenticate and matches how claude -p already runs. The proxy listens only on 127.0.0.1 (proxy-backend.ts:66). Critically, no credential is written to any clarp log, so there is no logging-based leak path.

**Recommendation:** No change needed; keep env and auth headers out of any future debug logging.

</details>

<details>
<summary><strong>⚪ NIT</strong> — API debug logger redacts by default and writes to stderr (well-designed; no credential/prompt leak by default) <em>(confirmed)</em></summary>

**Evidence:** src/api-debug.ts:30 default write target is process.stderr (not a cwd file). Default summaries (api-debug.ts:36-49, 67-76, 128-134) emit chars + sha256_12 hash, never raw text. Raw text previews (capped at 160 chars, api-debug.ts:14,123-126) are gated behind the separate CLARP_DEBUG_API_TEXT env (api-debug.ts:21-24,28). README.md:281 documents that the default mode 'does not log auth headers or prompt text' and that CLARP_DEBUG_API_TEXT is the explicit opt-in for previews.

**Impact:** The earlier concern about verbatim plaintext prompt/control logging to a world-readable cwd file does not apply: the default logger is redacted, hash-based, and goes to stderr. Only when the operator explicitly sets CLARP_DEBUG_API_TEXT=1 do short (<=160 char) previews appear, and even then only on stderr. This is a safe-by-default design.

**Recommendation:** No change required. Optionally note in --help (not just README) that CLARP_DEBUG_API_TEXT surfaces prompt/response text.

</details>

<details>
<summary><strong>⚪ NIT</strong> — postinstall chmod is platform/arch-gated, path-constrained, and stat-checked (negligible risk) <em>(confirmed)</em></summary>

**Evidence:** scripts/repair-node-pty-spawn-helper.mjs:10-12 exits on non-darwin or unsupported arch; :17-21 resolves node-pty via require.resolve (its own dependency); :23-28 builds helperPath only from that package dir + fixed 'prebuilds/darwin-<arch>/spawn-helper'; :30-39 statSync + bail if already executable; :41 chmods only that file to mode|0o755. No user input, no glob.

**Impact:** The script only makes node-pty's own prebuilt spawn-helper executable, scoped entirely within the resolved node-pty package directory. Exploiting it would require already controlling files inside node_modules. Negligible.

**Recommendation:** Optional hardening: use lstat to refuse a symlink at the helper path. Not required.

</details>


### Cross-Platform Support

clarp is deliberately and competently cross-platform-aware in its SOURCE: it has a Windows-specific claude resolver (where claude.cmd), a normalizePtyKillSignal shim that strips POSIX signal args on win32 (node-pty's Windows backend throws on them), a correctly darwin+arch-guarded spawn-helper repair that no-ops harmlessly elsewhere, portable path/os usage throughout, and trust-prompt detection that normalizes both ANSI and CRLF before matching. The genuine cross-platform risk is therefore NOT broken code but UNVERIFIED code: the CI matrix runs only build + unit tests + pack on all three OSes and never exercises the PTY stream-json round-trip, and the single node-pty spawn unit test is explicitly skipped on Windows. So Windows/Linux are 'claimed and plausibly coded' but the core product path (spawn claude in a PTY, proxy stream-json, forward control requests, interrupt) has zero integration coverage on any platform in CI, with Windows ConPTY the least de-risked. No BLOCKER cross-platform defect was found; the headline issue is a HIGH testing/assurance gap against the project's own parity-reliability goal.

<details>
<summary><strong>🟠 HIGH</strong> — CI claims Windows/Linux/macOS support but never exercises the PTY stream-json round-trip on any OS <em>(confirmed)</em></summary>

**Evidence:** .github/workflows/ci.yml lines 14-29: matrix os:[ubuntu-latest,macos-latest,windows-latest] x node:[20,22,24], but the only steps are `npm ci`, `npm run build`, `npm test`, `npm pack --dry-run`. The harnesses that actually drive a PTY (package.json:28-30 -> parity:stream, parity:interrupt, probe:pty-interrupt -> scripts/parity-stream.mjs, scripts/pty-interrupt-probe.mjs) are NOT invoked anywhere in ci.yml.

**Impact:** A green CI badge across all three OSes proves only that TypeScript compiles, unit tests pass, and the tarball packs. The product's entire reason for existing (wrap claude in a PTY and proxy stream-json + control/permission requests + interrupts) is never integration-tested on any platform in CI. Windows ConPTY behavior (data encoding, CRLF, kill/interrupt semantics) is wholly unvalidated by automation, so 'Windows supported' is claimed-but-not-verified against the project's stated parity-reliability goal.

**Recommendation:** Add at least one CI job per OS that runs the parity/probe harness against a stub PTY child (a trivial echo program, no real claude needed) to exercise spawn -> onData -> kill/interrupt. Prioritize windows-latest since ConPTY differs most. Otherwise downgrade the README claim to label Windows/Linux as untested/experimental.

</details>

<details>
<summary><strong>🟡 MEDIUM</strong> — The only node-pty spawn unit test is skipped on Windows, leaving the Windows spawn path with zero automated coverage <em>(confirmed)</em></summary>

**Evidence:** src/pty-host.test.ts:17 `const itIfPosix = process.platform === "win32" ? it.skip : it;`. The win32-relevant logic that IS tested is pure and runs on a fixed string platform arg, not the real runtime: normalizePtyKillSignal (lines 99-104) and getNodePtySpawnHelperPath (114-124). Combined with the HIGH finding, nothing on the windows-latest CI leg ever spawns through node-pty/ConPTY.

**Impact:** node-pty's ConPTY backend (spawn options, encoding, kill semantics, cwd/env handling) is never executed under test on Windows. A future regression in the Windows spawn path would pass CI green.

**Recommendation:** Add a Windows-runnable spawn smoke test (spawn `cmd /c echo hi`, assert onData + onExit) so the ConPTY path is touched on windows-latest. At minimum, document that itIfPosix leaves the Windows spawn path uncovered.

</details>

<details>
<summary><strong>🔵 LOW</strong> — POSIX path/temp assumptions confined to tests/fixtures; one latent Windows slug heuristic in pid-watcher <em>(likely)</em></summary>

**Evidence:** Full signal/path grep: every hardcoded /tmp is in test files or __fixtures__ JSONL (v04-features.test.ts:145-280, pid-watcher.test.ts:39, cli.test.ts:174-189, claude-p-*.jsonl). Shipped path code is portable (pid-watcher.ts:40-41,75-76 path.join + os.homedir; bin/clarp.js `#!/usr/bin/env node` + import). Latent point: pid-watcher.ts:74 builds the transcript slug via `"-" + data.cwd.replace(/\//g, "-").replace(/^-/, "")`, rewriting only forward slashes; a Windows cwd with backslashes would slugify differently than Claude Code's own scheme.

**Impact:** Runtime path handling is Windows-safe except the transcript-slug heuristic at pid-watcher.ts:74, which assumes a POSIX '/'-separated cwd; on Windows the direct slug path may miss, though the readdir fallback scan (lines 78-83) recovers the transcript by filename. Hardcoded /tmp in tests could make the Windows CI test leg less meaningful if any test touches real disk rather than a mock.

**Recommendation:** Confirm tests treat '/tmp' as opaque mocked paths. For pid-watcher.ts:74, either mirror Claude Code's actual Windows slug rule or rely on the documented readdir fallback; consider a Windows pid-watcher test. Low priority given the fallback mitigates it.

</details>

<details>
<summary><strong>⚪ NIT</strong> — Windows signal handling is correctly shimmed: SIGTERM/SIGINT kills are NOT a no-op or throw <em>(confirmed)</em></summary>

**Evidence:** pty-host.ts:28-31 normalizePtyKillSignal returns undefined on win32 (comment: 'node-pty's Windows backend throws on POSIX signal args; no-arg kill is its force-kill path'). The wrapped handle routes ALL kills through it (pty-host.ts:117 `kill: (signal?) => proc.kill(normalizePtyKillSignal(signal))`). Therefore the literal kill("SIGTERM") at fatal-cleanup.ts:30, cli.ts:80, session.ts:347/364/660 and kill("SIGINT") at session.ts:652 all become a no-arg force-kill on Windows. findClaude also branches: where claude.cmd on win32 (pty-host.ts:66-68) vs which claude (76).

**Impact:** None functionally; this is correct design. Recorded because a naive grep for kill("SIGTERM") looks like a Windows bug but is not. Note: the graduated soft-interrupt sequence (pty_escape ESC -> ctrl-C \x03 -> SIGINT -> SIGTERM, session.ts:637-662) degrades on Windows because ESC/ctrl-C writes still work via the PTY but the SIGINT step collapses to a hard force-kill rather than a deliverable signal.

**Recommendation:** No change to the kill plumbing. Optionally verify on Windows that the interrupt escalation still produces the expected stream-json result/terminal state when the SIGINT rung collapses to force-kill, to confirm interrupt parity.

</details>

<details>
<summary><strong>⚪ NIT</strong> — Trust-prompt / control-sequence detection IS Windows-safe: both ANSI and CRLF are normalized before matching <em>(confirmed)</em></summary>

**Evidence:** claude-prompts.ts:1 ANSI_PATTERN covers CSI/OSC/DCS/etc; line 4 stripTerminalControls does `.replace(ANSI_PATTERN, "").replace(/\r/g, "\n")` (explicit CR->LF); line 8 isWorkspaceTrustPrompt further reduces to alphanumerics via `.replace(/[^a-z0-9]/g, "")` before substring checks (quicksafetycheck / yesitrustthisfolder / noexit). The detector buffers and slices the last 16k of PTY data (lines 22-29), so split-across-chunk prompts are handled.

**Impact:** Resolves the plausible concern that ConPTY CRLF line endings or extra escape sequences would break workspace-trust detection: they are stripped/normalized away, and reducing to [a-z0-9] makes the match whitespace/punctuation/line-ending agnostic. This is robust against Windows terminal differences.

**Recommendation:** No change required. The remaining residual risk is only if ConPTY interleaves cursor-positioning escapes WITHIN the prompt words themselves; an optional Windows parity case feeding recorded ConPTY trust-prompt bytes would fully close it.

</details>

<details>
<summary><strong>⚪ NIT</strong> — darwin-only spawn-helper repair is correctly guarded and harmless on Linux/Windows (not a defect) <em>(confirmed)</em></summary>

**Evidence:** scripts/repair-node-pty-spawn-helper.mjs lines 7-12 exit(0) unless platform==='darwin' && arch in {arm64,x64}; it path.join's prebuilds/darwin-${arch}/spawn-helper, stats it, and chmods only when the exec bit is missing, with every failure path exit(0). The runtime mirror getNodePtySpawnHelperPath returns null for non-darwin (pty-host.ts:38) and is unit-tested for linux/ia32 returning null (pty-host.test.ts:123-124).

**Impact:** On Linux and Windows the postinstall is a clean no-op that cannot fail npm install; the exec-bit problem is genuinely darwin-prebuild-specific. The brief's worry that the darwin-only postinstall leaves other platforms 'unrepaired' is unfounded: they need no repair.

**Recommendation:** No change required.

</details>


### Packaging & Release

Packaging is sound for a bin-only CLI. The `files` array ships exactly the needed surface (dist, bin, scripts, README, LICENSE — confirmed via `npm pack --dry-run`: 47 files, 48.4kB, no source maps since tsconfig sets only `declaration:true`). The `bin/clarp.js` dynamic-import shim correctly resolves `../dist/cli.js`; `prepublishOnly` rebuilds and validates before publish; the CI publish job is gated on GitHub `release: published` with provenance and id-token:write. Releases ARE tracked: git tags v0.1.0–v0.1.6 plus GitHub Releases v0.1.4–v0.1.10 exist. The remaining gaps are release-hygiene: git tags lag GitHub releases (no v0.1.7–v0.1.10 git tags), there is no CHANGELOG, dist is gitignored so publish depends on prepublishOnly, and stale .tgz artifacts sit in the working tree. No BLOCKER packaging defects.

<details>
<summary><strong>🟡 MEDIUM</strong> — Git tags lag GitHub Releases: tags stop at v0.1.6 but GitHub Releases exist through v0.1.10 <em>(confirmed)</em></summary>

**Evidence:** `git tag` returns only v0.1.0 through v0.1.6. `gh release list` shows releases v0.1.4 through v0.1.10 (v0.1.10 Latest, 2026-05-29). So v0.1.7, v0.1.8, v0.1.9, v0.1.10 have GitHub Releases (which trigger the publish job) but no corresponding git tag is present locally. Current package.json is 0.1.10 (line 3).

**Impact:** Release provenance is partially broken: a developer with a local clone cannot `git checkout v0.1.10` to inspect exactly what was published. GitHub Releases reference tags, so either the tags exist remotely but were not fetched locally, or releases were created from a branch ref. Either way, the local tag history is an unreliable record of shipped versions, which complicates regression bisection for software whose value is faithful `claude -p` parity.

**Recommendation:** Confirm tags v0.1.7–v0.1.10 exist on the remote (`git fetch --tags`); if missing, create them. Ensure every GitHub Release is anchored to an annotated tag on the published commit so versions are reproducible.

</details>

<details>
<summary><strong>🔵 LOW</strong> — No CHANGELOG file; release notes live only in GitHub Releases <em>(confirmed)</em></summary>

**Evidence:** `ls CHANGELOG*` -> no matches. No CHANGELOG.md in repo root. README has no version history section (headings: Problem, Solution, Architecture, Install, Usage, Flags, Feature Parity, Testing, Limitations, FAQ, Disclaimer, Contributing, License). Release history is only in GitHub Releases (`gh release list`).

**Impact:** npm consumers (who install via `npm install -g clarp-cli`) get no in-package record of what changed between versions; they must visit GitHub. For experimental software that breaks across claude-code versions, a per-version changelog of behavior changes would materially help users diagnose parity breakage.

**Recommendation:** Add a CHANGELOG.md (Keep a Changelog format) and ship it via `files`, or at minimum cross-link GitHub Release notes from the README.

</details>

<details>
<summary><strong>🔵 LOW</strong> — dist is gitignored and never committed; publish correctness depends entirely on prepublishOnly/CI build firing <em>(confirmed)</em></summary>

**Evidence:** .gitignore line 2: `dist`. On a clean checkout `dist/cli.js` is absent until built. package.json:19 ships `dist/` in `files`. The build is produced only by `prepublishOnly` (package.json:27 `npm test && npm run build && npm pack --dry-run`) and by the CI publish job which DOES run an explicit `- run: npm run build` before `npm publish` (ci.yml:45-47). Build verified working: `npm run build` regenerates dist/cli.js with correct ESM entry (`#!/usr/bin/env node` + `import { parseArgs } from "./args.js"`).

**Impact:** Low because CI has a redundant explicit build step, so the supported publish path is safe. Risk only materializes for a manual `npm publish --ignore-scripts` outside CI, which would ship a tarball declaring `dist/` in `files` but with the directory absent, producing a package whose `bin/clarp.js` imports a nonexistent `../dist/cli.js`.

**Recommendation:** Keep the explicit CI build (already present). Optionally add a `prepack` hook so `npm pack` also rebuilds, fully decoupling from `--ignore-scripts`. Largely a non-issue given CI.

</details>

<details>
<summary><strong>🔵 LOW</strong> — Stale .tgz artifacts (0.1.1, 0.1.4-0.1.8) accumulated in the working tree <em>(confirmed)</em></summary>

**Evidence:** Root dir contains clarp-cli-0.1.1.tgz, -0.1.4, -0.1.5, -0.1.6, -0.1.7, -0.1.8.tgz. They are gitignored (.gitignore line 4 `*.tgz`) and excluded from the npm tarball (`files` does not include them).

**Impact:** No correctness or publish impact (gitignored + not shipped). Pure clutter; a stale older-version tarball could be accidentally hand-published (`npm publish clarp-cli-0.1.8.tgz`) regressing the registry.

**Recommendation:** Delete the stray .tgz files (`rm clarp-cli-*.tgz`). Cosmetic.

</details>

<details>
<summary><strong>🔵 LOW</strong> — No `exports`/`main`/`types` map while declaration:true emits unconsumable .d.ts files <em>(confirmed)</em></summary>

**Evidence:** package.json has `bin` (lines 14-16) but no `main`, `module`, `exports`, or `types`. tsconfig.json:11 `declaration: true` (no sourceMap/declarationMap), so the tarball ships one .d.ts per module (confirmed in `npm pack --dry-run`: dist/*.d.ts entries; 47 files total).

**Impact:** Acceptable for a bin-only CLI — users invoke `clarp`, not `import 'clarp-cli'`. Minor downsides: the package ships ~20 .d.ts files no consumer can resolve (dead weight, ~modest size), and `import 'clarp-cli'` fails with no entry. Not a defect against the stated bin-only purpose.

**Recommendation:** Either set `declaration:false` to slim the published tarball (bin-only), or add an `exports` map with types if a programmatic API is intended. Non-blocking.

</details>

<details>
<summary><strong>⚪ NIT</strong> — postinstall repair script is fail-safe — confirmed it cannot break `npm install` <em>(confirmed)</em></summary>

**Evidence:** scripts/repair-node-pty-spawn-helper.mjs: exits 0 on non-darwin/unsupported arch (lines 10-12), exits 0 when node-pty unresolvable (lines 17-21), exits 0 when helper stat fails (lines 31-35), and the only mutating call `fs.chmodSync` (line 41) is the last statement with no surrounding throw-guard but reached only after all guards pass. No path returns non-zero. The script ships in the tarball (confirmed in pack output: scripts/repair-node-pty-spawn-helper.mjs, 768B).

**Impact:** Positive finding addressing the stated concern: postinstall failure on CI/Linux/odd environments will not break installation. One residual edge: an unexpected throw from chmodSync (e.g. permission denied on a read-only global install) would surface as a non-zero postinstall and could abort `npm install`; wrapping line 41 in try/catch would fully harden it.

**Recommendation:** Optionally wrap the final `fs.chmodSync` in try/catch (warn-only) to guarantee install never fails. Otherwise no action needed.

</details>


### Test Coverage & Quality

The unit suite is broad and disciplined: 384 tests across 17 co-located src/*.test.ts files, all passing in ~600ms, with zero abuse of .only/.skip (the only it.skip is a legitimate Windows guard `itIfPosix` in pty-host.test.ts:17). Pure-logic and protocol modules (schema, control-schema, parity, output, message-assembler, args/cli, pty-host send-helpers) have real, assertion-rich tests. Two structural gaps are what hold this back for a parity-critical product: (1) coverage is unmeasurable in CI because @vitest/coverage-v8 is not installed and vitest.config.ts has no coverage block, so there is no floor and no gate; (2) the only checks that verify faithful stream-json parity and real escape-sequence interruption against a real claude binary are scripts/parity-stream.mjs and scripts/pty-interrupt-probe.mjs, which exist as npm scripts but are NOT in CI (.github/workflows/ci.yml runs only npm ci/build/test/pack). The single biggest gap: spawnClaude()/findClaude() — the real PTY spawn and binary-resolution seam — have no test at all, and parity/interrupt regressions in the real path can ship green.

<details>
<summary><strong>🟠 HIGH</strong> — spawnClaude() and findClaude() — the real PTY spawn + binary resolution seam — have zero tests <em>(confirmed)</em></summary>

**Evidence:** pty-host.test.ts (141 lines, 15 tests) imports and tests sendPrompt, sendInterrupt, sendPermissionAllow/Deny, sendSlashCommand, normalizePtyKillSignal, and the spawn-helper repair helpers (file content confirmed, imports at lines 2-12). It does NOT import or exercise spawnClaude or findClaude. Those two functions (src/pty-host.ts:65-82 findClaude, :88-120 spawnClaude) contain the only real node-pty.spawn call (:103) and the only binary discovery: win32 uses `where claude.cmd` (:68), POSIX uses `which claude` (:76). No test in the repo references spawnClaude (the session/integration tests inject a fake handle instead).

**Impact:** The actual process launch, env merging (:97-101), spawn options (cols/rows/cwd/env at :104-108), onData/onExit wiring (:111-112), and OS-specific binary resolution are never executed by any test. A regression in spawn args, env propagation, or claude discovery on any of the three CI OSes would not be caught. This is the core of how clarp wraps `claude -p`.

**Recommendation:** Add a test that drives spawnClaude against a trivial stub binary (e.g. a tiny node script that echoes input and exits) to cover spawn options, env merge, and onData/onExit wiring; and unit-test findClaude's win32 vs POSIX branches with execSync mocked, including the not-found error paths.

</details>

<details>
<summary><strong>🟠 HIGH</strong> — Faithful parity and real interrupt are only checked by manual harnesses not wired into CI <em>(confirmed)</em></summary>

**Evidence:** .github/workflows/ci.yml test job steps are exactly: `npm ci`, `npm run build`, `npm test`, `npm pack --dry-run` (lines 26-29; publish job mirrors). package.json defines parity:stream (scripts/parity-stream.mjs), parity:interrupt (scripts/parity-stream.mjs --cases scripts/cases-interrupt.json), probe:pty-interrupt (scripts/pty-interrupt-probe.mjs) but none is invoked by `test` (`vitest run`) or by CI. These harnesses require a real logged-in claude binary.

**Impact:** clarp's reason to exist is faithful stream-json parity with `claude -p` and reliable interruption against undocumented real claude-code behavior. A regression in stream-json shape, spawn args, or escape-sequence interrupt efficacy from a new claude-code version passes the enforced suite green; only a human remembering to run the parity harness catches it.

**Recommendation:** Add an opt-in/nightly/on-release CI lane (gated on a real claude binary or recorded fixtures) that runs parity-stream.mjs and pty-interrupt-probe.mjs, and document them as a required pre-release manual gate in the release checklist.

</details>

<details>
<summary><strong>🟠 HIGH</strong> — Coverage cannot be measured: @vitest/coverage-v8 missing, no coverage config, no CI gate <em>(confirmed)</em></summary>

**Evidence:** `npx vitest run --coverage` fails: `MISSING DEPENDENCY  Cannot find dependency '@vitest/coverage-v8'` (command output). vitest.config.ts contains only `test: { include: ["src/**/*.test.ts"] }` with no coverage block (full content confirmed). package.json devDependencies are only @types/node, typescript, vitest; `test` is `vitest run` with no coverage flag.

**Impact:** There is no quantitative visibility into which branches of the 952-line session.ts state machine the 1377-line session.test.ts actually exercises, and no enforced floor. For experimental software riding undocumented claude-code behavior, untracked coverage lets error/teardown/race branches rot silently. Any 'good coverage' claim is currently unfalsifiable in CI.

**Recommendation:** Add @vitest/coverage-v8, configure coverage in vitest.config.ts (include src/**/*.ts, exclude *.test.ts; text+lcov reporters), and add a CI coverage step with a threshold so regressions in the core state machine surface.

</details>

<details>
<summary><strong>🟡 MEDIUM</strong> — session.ts core state machine tested entirely through a fake PTY; failure/teardown branches likely uncovered <em>(likely)</em></summary>

**Evidence:** session.ts is 952 lines; session.test.ts is 1377 lines and drives the controller via injected fakes (handleClaudeExit called directly at session.test.ts:120,156,552,1020,1043,1053,...; confirmed). session.ts has a backend-spawn-failure catch (src/session.ts:93-96 `catch { ... emitFatal("backend_spawn_failed", err); return; }`, content confirmed) and a large cleanup tail near :925-952. Because the real PTY is never used and coverage is unmeasurable, it cannot be shown these failure/teardown branches execute under test.

**Impact:** Tests validate clarp's own bookkeeping (timer/resend, emit ordering, exit handling) but not real-process effects, and the most failure-relevant paths (backend spawn failure, cleanup/teardown) are exactly those a mocked PTY cannot prove. These govern process teardown, an experimental-risk area.

**Recommendation:** Add a test that makes the injected spawn dependency throw and asserts the backend_spawn_failed fatal stream-json; cover the cleanup tail. Once a coverage provider exists, target uncovered session.ts branches explicitly.

</details>

<details>
<summary><strong>🟡 MEDIUM</strong> — backends/proxy-backend.test.ts is only 15 lines / 2 tests for the 103-line spawn-wiring backend <em>(confirmed)</em></summary>

**Evidence:** proxy-backend.test.ts (full content confirmed) has exactly 2 tests: getClaudeEnv-before-prepare throws, and only-one-observation-subscriber throws. The 103-line proxy-backend.ts marshals config into spawnClaude and wires onData/onExit/start() — none of which is asserted.

**Impact:** Drift between config fields and what is forwarded to the PTY spawn (cwd/env/cols/rows/claudePath), or mishandling of backend start/exit, would not be caught. This is part of the untested real-spawn seam backing the product's core behavior.

**Recommendation:** Expand to assert start() forwards the expected option object to a spy spawnClaude and that onExit/onData/error are wired and propagated, independent of any fake handle behavior.

</details>

<details>
<summary><strong>🔵 LOW</strong> — Interrupt-resend / readiness-timeout tests prove clarp's timers, not real-process interruption <em>(likely)</em></summary>

**Evidence:** The escape-byte unit test exists (pty-host.test.ts:59-64 sendInterrupt 'sends ESC byte' asserts writes == ['\x1b']) and session.test.ts covers the readiness-timeout-during-active-turn / resend behavior touched by recent commits ca78eaf and 4ee59af, all against a fake handle that models a process which ignores the interrupt. None models a real claude that acks/exits on the escape. The real-effect check is pty-interrupt-probe.mjs, not in CI.

**Impact:** The regression these guard (clarp's own timer/resend/queue bookkeeping) is covered, but the higher-risk regression — that the ESC escape actually interrupts a current real claude-code version — is not enforced. This is precisely the gap the non-enforced probe was written for.

**Recommendation:** Keep the deterministic unit tests; additionally enforce pty-interrupt-probe.mjs in the opt-in/nightly CI lane so escape-sequence efficacy is regression-guarded as claude-code evolves.

</details>

<details>
<summary><strong>⚪ NIT</strong> — Positive: disciplined suite — no focused tests, real cross-platform guarding, 384/384 passing <em>(confirmed)</em></summary>

**Evidence:** `npx vitest run` => Test Files 17 passed (17), Tests 384 passed (384). grep for .only/.todo/xit/xdescribe across src/*.test.ts and backends found none; the only .skip is the deliberate Windows guard `const itIfPosix = process.platform === 'win32' ? it.skip : it` (pty-host.test.ts:17, used for the real-chmod test). pid-watcher.test.ts being absent from earlier confusion notwithstanding, pty-host's cross-platform helpers (normalizePtyKillSignal, getNodePtySpawnHelperPath) are tested for win32/linux/darwin explicitly (pty-host.test.ts:97-125).

**Impact:** Unit-testing discipline is genuinely strong; the testing weakness is concentrated at the real-spawn seam (spawnClaude/findClaude), unmeasured coverage, and unenforced parity/interrupt harnesses — not in missing files or disabled tests.

**Recommendation:** Preserve the no-focused-tests + platform-guard discipline; direct new effort at the real-spawn tests, coverage instrumentation, and enforcing the parity/interrupt harnesses rather than more pure-logic unit tests.

</details>


---

## What looks production-grade already

- **Build/CI:** strict TS compiles clean; 384 tests pass in ~0.7s; CI matrix covers {ubuntu, macos, windows} × node {20, 22, 24}; publish job uses npm provenance + id-token.
- **Packaging:** `files` allowlist ships exactly dist/bin/scripts/README/LICENSE (47 files, 48.4 kB) — no source, tests, secrets, `.tgz`, or `.parity-runs` leak.
- **Supply chain:** single runtime dep (`node-pty`), committed lockfile, `npm audit` = 0 vulnerabilities; the darwin postinstall chmod is platform/arch-gated, path-constrained, and stat-checked.
- **Security defaults:** full env is forwarded to the child (required, matches native) but never logged; the API debug logger redacts by default (sha256 + lengths) and only previews text behind an explicit opt-in; the workspace-trust auto-confirm fails *closed* without `--dangerously-skip-permissions`.
- **Resilience skeleton:** top-level `main().catch`, a fatal-cleanup net wiring `uncaughtException`/`unhandledRejection`/`exit`, bounded shutdown/interrupt force-kill timers, complete timer cleanup, and disciplined best-effort catches around all FS/transcript/PID parsing. stdin stream-json mode caps lines at 1 MiB.

## Recommended path to "bulletproof"

1. **Guarantee a terminal `result` event on *every* exit path** (readiness timeout, dispatch failure, backend-start failure, fatal handlers, startup/post-turn claude crash). This is the single highest-leverage fix — it restores `claude -p` parity in exactly the failure modes tools depend on. *(error-resilience)*
2. **Add a forward-compat passthrough** in the message-assembler for unknown content-block/delta types, and place blocks by `e.index`, so a future claude-code change can't silently drop content. *(protocol-parity)*
3. **Add a terminal watchdog to the interrupt path** so a never-idle PID can't wedge the session, and stop the unconditional 2s SIGTERM from killing a successfully-cancelled turn. *(interrupt-cancellation)*
4. **Wire the live parity + pty-interrupt harnesses into CI** (nightly/manual, needs a real subscription) so protocol/interrupt drift is caught instead of staying green against frozen May-2026 fixtures. *(protocol-parity, interrupt, testing)*
5. **Bound the text-prompt stdin buffer and the op-queue depth** to remove the unbounded-memory paths. *(input-robustness)*
6. **Release hygiene:** add git tags for v0.1.7–v0.1.10, a CHANGELOG, and a SECURITY.md. *(packaging-release)*

---

_Generated from the audit workflow's structured findings. Adversarial verification was not run; re-run it to adjudicate the HIGH/MEDIUM items before acting._
