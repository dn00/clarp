<div align="center">
<pre>
 ██████╗██╗      █████╗ ██████╗ ██████╗ 
██╔════╝██║     ██╔══██╗██╔══██╗██╔══██╗
██║     ██║     ███████║██████╔╝██████╔╝
██║     ██║     ██╔══██║██╔══██╗██╔═══╝ 
╚██████╗███████╗██║  ██║██║  ██║██║     
 ╚═════╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     
</pre>

<b>claude api relay proxy</b> — LARPing as <code>claude -p</code>

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-green.svg)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/Tests-passing-brightgreen.svg)](#testing)
[![npm](https://img.shields.io/npm/v/clarp-cli.svg)](https://www.npmjs.com/package/clarp-cli)

Drop-in replacement for `claude -p` that runs on your Claude Code subscription instead of metered API pricing.

</div>

> **EXPERIMENTAL** — Not affiliated with Anthropic. May break with any Claude Code update. Use at your own risk.

---

## The Problem

`claude -p` (print mode) is how Claude Code integrates with scripts, CI/CD pipelines, IDE extensions, and automation tools. It accepts structured JSON on stdin and emits structured streaming events on stdout.

When [`-p` becomes separately metered](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), every tool in that ecosystem pays per-call on top of your existing subscription.

## The Solution

`clarp` wraps an interactive Claude Code session and exposes the **exact same protocol**. Your tools don't know the difference — same input format, same output events, same flags. Just swap the binary name.

```bash
# Before (metered)
claude -p "explain this function"

# After (subscription)
clarp -p "explain this function"
```

---

## Architecture

```
Your tool
  │
  │ stdin: stream-json
  ▼
clarp
  ┌──────────────┐     ┌────────────────────┐     ┌────────────────┐
  │ Stdin Reader │────▶│ Session Controller │────▶│ Output Emitter │────▶ stdout
  └──────────────┘     └─────────┬──────────┘     └───────▲────────┘
                                 │                        │
                                 ├──▶ PID Watcher          │
                                 │    status file          │
                                 │                        │
                                 └──▶ PTY Host             │
                                      │                    │ SSE events
                                      ▼                    │
                                Claude Code                │
                                      │                    │
                                      │ HTTP via proxy env │
                                      ▼                    │
                                Observation Backend ───────┘
                                local proxy + SSE tee
                                      │
                                      ▼
                                api.anthropic.com
```

### How the proxy works

The core mechanism is a transparent HTTP proxy on `127.0.0.1`:

1. clarp starts a local HTTP server on a random port
2. Claude Code is spawned in a PTY with `ANTHROPIC_BASE_URL=http://127.0.0.1:{port}`
3. Claude's API requests route through the proxy instead of going directly to Anthropic
4. The proxy forwards every request to `api.anthropic.com` **byte-for-byte unchanged**
5. The API responds with an SSE (Server-Sent Events) stream
6. The proxy forwards the full response to Claude **and** copies each SSE event to clarp's output
7. Claude Code behaves identically — it doesn't know the proxy exists

This gives clarp access to the same token-level streaming events that `claude -p` sees, without using `-p` mode.

**What the proxy touches:**
- Reads HTTP headers to route requests (but does not store or log them)
- Strips `Accept-Encoding` so responses arrive uncompressed (for SSE parsing)

**What the proxy does NOT touch:**
- Auth tokens (passed through, never stored)
- Request bodies (forwarded unchanged)
- Response bodies (forwarded unchanged)
- Claude Code's behavior (no modifications to any request or response)
- Other processes (scoped to the single Claude process it spawned)
- The network (binds to `127.0.0.1` only)

### Session state tracking

In addition to the proxy, clarp watches Claude Code's PID file at `~/.claude/sessions/{pid}.json` for state changes:

| PID Status | Meaning | clarp Event |
|:----------:|---------|-------------|
| `busy` | Claude is processing | `session_state_changed: running` |
| `idle` | Claude is waiting for input | `session_state_changed: idle` + `result` |
| `waiting` | Claude needs permission approval | `session_state_changed: requires_action` + `control_request` |

This is the same mechanism `claude ps` uses — no custom hooks or configuration required.

### Backend abstraction

clarp's observation layer is pluggable. The proxy is the default backend, but the architecture supports alternatives:

```typescript
interface ObservationBackend {
  prepare(): Promise<void>;
  getClaudeEnv(): Record<string, string>;
  startObserving(): Promise<void>;
  stop(): Promise<void>;
  onObservation(cb: (obs: Observation) => void): void;
}
```

A JSONL transcript backend (tails Claude's session file for block-level events without any proxy) is planned as a fallback for environments where the proxy approach isn't suitable.

---

## Install

```bash
npm install -g clarp-cli
```

**Requirements:**
- Node.js 20–24 (LTS recommended)
- Claude Code installed and authenticated (`claude auth login`)

**Platform notes:**
- macOS, Linux, Windows (via WSL or native) supported
- If you see `posix_spawnp failed`, reinstall under Node.js 20-24 first. On macOS, `node-pty`'s packaged `spawn-helper` may also lose its executable bit during install:

```bash
chmod +x "$(npm root -g)/clarp-cli/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper"
```

Fish users should use `chmod +x (npm root -g)/clarp-cli/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper`. If that does not fix it, rebuild the installed PTY module manually:

```bash
cd "$(npm root -g)/clarp-cli"
npx node-gyp rebuild --directory=node_modules/node-pty
```

Fish users should use `cd (npm root -g)/clarp-cli`. Source compilation requires Xcode Command Line Tools on macOS.

---

## Usage

### Single prompt

```bash
# Plain text output (default)
clarp "explain this function"

# JSON result
clarp --output-format json "explain this function"

# Stream-json event output
clarp --output-format stream-json "explain this function"

# Include token-level partial deltas
clarp --output-format stream-json --include-partial-messages "explain this function"
```

### Piped input

```bash
echo "explain this code" | clarp
cat prompt.txt | clarp --output-format json
```

### Multi-turn sessions

```bash
clarp \
  --input-format stream-json \
  --output-format stream-json

# Send prompts as NDJSON on stdin:
{"type":"user","message":{"role":"user","content":"find the bug in auth.ts"},"parent_tool_use_id":null}
{"type":"user","message":{"role":"user","content":"now fix it"},"parent_tool_use_id":null}
```

Each turn produces a full event cycle: `init → assistant → result`. Add `--include-partial-messages` when you want token-level `stream_event` deltas. Prompts are queued and dispatched sequentially — clarp waits for Claude to be idle before sending the next prompt.

By default, `stream-json` is optimized for clients that consume completed `assistant` and `result` messages. `--include-partial-messages` adds raw token-level `stream_event` records before the completed assistant message; clients that consume both should dedupe or ignore one path.

### Interrupt

Send an interrupt control request on stdin:

```json
{"type":"control_request","request_id":"int-1","request":{"subtype":"interrupt"}}
```

Or press `Ctrl+C`.

### Permission handling

When Claude needs tool approval, clarp emits a `control_request`:

```json
{"type":"control_request","request_id":"perm-1","request":{"subtype":"can_use_tool","tool_name":"Bash","tool_use_id":"toolu_01","input":{"command":"rm -rf /tmp/test"}}}
```

Respond with allow or deny:

```json
{"type":"control_response","request_id":"perm-1","response":{"behavior":"allow","toolUseID":"toolu_01"}}
```

Or skip this entirely with `--dangerously-skip-permissions`.

### Resume sessions

```bash
# Continue most recent session
clarp --continue "add tests for what we just built"

# Resume specific session
clarp --resume abc123 "let's keep going"
```

---

## Flags

### clarp flags

| Flag | Description |
|------|-------------|
| `-p, --print` | Print mode (always on, accepted for compatibility) |
| `--output-format <fmt>` | `text` (default), `json`, or `stream-json` |
| `--input-format <fmt>` | `text` (default) or `stream-json` |
| `--verbose` | Include verbose non-partial events (automatic with `stream-json`) |
| `--include-partial-messages` | Include token-level `stream_event` deltas |
| `--replay-user-messages` | Echo accepted user messages back on stdout |
| `--max-turns <n>` | Stop after N agentic turns |
| `--max-budget-usd <n>` | Accepted for compatibility; currently warns and is not enforced |

### Pass-through to Claude Code

These flags are forwarded directly to the interactive Claude process:

| Flag | Flag |
|------|------|
| `--model` | `--permission-mode` |
| `--system-prompt` | `--append-system-prompt` |
| `--json-schema` | `--output-style` |
| `--allowedTools` / `--allowed-tools` | `--disallowedTools` / `--disallowed-tools` |
| `--tools` | `--file` |
| `--session-id` | `-c, --continue` / `-r, --resume` |
| `--add-dir` | `--mcp-config` / `--strict-mcp-config` |
| `--bare` | `--effort` / `--max-thinking-tokens` |
| `--agent` / `--agents` | `--name` |
| `--fallback-model` | `--permission-prompt-tool` |
| `--settings` | `--setting-sources` |
| `--dangerously-skip-permissions` | `--allow-dangerously-skip-permissions` |
| `--debug` / `--debug-file` | `--mcp-debug` |
| `--plugin-dir` | `--plugin-url` |
| `--remote-control` | `--remote-control-session-name-prefix` |
| `--worktree` | `--from-pr` |
| `--chrome` / `--no-chrome` | `--ide` |
| `--brief` | `--tmux` |

Set `CLARP_DEBUG=1` to print clarp's proxy/session diagnostics to stderr. Set `CLARP_DEBUG_PTY=1` only when you need to inspect Claude's hidden PTY screen output.

Set `CLARP_DEBUG_API=1` to print redacted API observation summaries to stderr. This logs request ids, model, token limits, tool counts, output-config shape, and text lengths/hashes; it does not log auth headers or prompt text. Add `CLARP_DEBUG_API_TEXT=1` only when you explicitly want short text previews in those summaries.

---

## Feature Parity

### Output events

| Event | `claude -p` | `clarp` | Notes |
|-------|:-----------:|:-------:|-------|
| `stream_event` (token deltas) | Optional | Optional | Emitted with `--include-partial-messages` |
| `assistant` (complete messages) | Yes | Yes | Emitted per content block |
| `system.init` | Yes | Yes | From JSONL transcript or synthesized |
| `system.session_state_changed` | Yes | Yes | From PID file polling |
| `system.status` | Yes | Yes | From PID file polling |
| `system.api_retry` | Yes | Yes | From proxy 429/529 detection |
| `system.post_turn_summary` | Yes | Yes | From transcript or synthesized |
| `rate_limit_event` | Yes | Yes | From proxy headers |
| `result` (success/error) | Yes | Yes | Synthesized on turn completion |
| `control_request` (can_use_tool) | Yes | Yes | From PID waiting state + tool tracking |
| User message replay | Yes | Yes | `--replay-user-messages` |
| Hook events | Yes | Planned | |
| Task events | Yes | Planned | |
| `tool_progress` | Yes | Planned | |
| `prompt_suggestion` | Yes | Planned | |

### Input handling

| Message Type | `claude -p` | `clarp` |
|-------------|:-----------:|:-------:|
| User messages | Yes | Yes |
| `control_request` interrupt | Yes | Yes |
| `control_request` set_model | Yes | Yes |
| `control_request` get_context_usage | Yes | Yes |
| `control_request` stop_task | Yes | Yes |
| `control_response` (permission) | Yes | Yes |
| `keep_alive` | Yes | Yes |
| `control_request` initialize | Yes | Planned |
| MCP control requests | Yes | Not planned |

### What's different

| | `claude -p` | `clarp` |
|---|---|---|
| **Billing** | Metered per-call | Subscription |
| **Streaming** | Completed stream-json messages by default | Completed stream-json messages by default; token deltas are opt-in |
| **Terminal** | None | Full PTY (not exposed) |
| **Sessions** | Per-invocation | Persistent (resume with `--continue`) |
| **Latency** | Direct API | +~1ms (proxy hop) |

### Known limitations

`stream-json` assistant and result messages are the primary compatibility target. Some non-assistant sideband events differ from native `claude -p` because clarp observes Claude through a hidden PTY plus local proxy instead of Claude Code's internal print-mode pipeline.

Clients should treat unknown non-assistant events as optional metadata. In current parity runs, clarp may emit extra events such as `ping`, `system.status`, `system.session_state_changed`, `system.api_retry`, and `system.post_turn_summary`; native `claude -p` may emit sideband events such as `system.notification`.

---

## Testing

```bash
npm test
npm run test:watch
npm run parity:stream
npm run parity:interrupt
```

Tests cover SSE parsing, message assembly, output formatting, PID file watching, session lifecycle, permission forwarding, and protocol parity against captured `claude -p` output. Includes schema validation for all 25 SDK output types and all 21 control request subtypes.

`npm run parity:stream` builds clarp, runs a 20-prompt stream-json session through native `claude -p` and clarp, writes JSONL/debug artifacts under `.parity-runs/`, and reports public stream differences. Use `-- --prompts prompts.txt --limit 20 --model sonnet` to run a custom prompt list. Use `-- --extra-args "--permission-mode plan"` for one flag variant, or `-- --cases cases.json` for a matrix of `{ "name": "...", "args": ["--flag", "value"], "prompts": ["..."] }` cases.

`npm run parity:interrupt` runs scripted interrupt parity cases covering immediate follow-up prompts, zero-delay prompt dispatch, SIGINT, duplicate interrupts, and queued prompts after interruption.

When changing output behavior, run the parity harness in both modes:

```bash
npm run parity:stream -- --limit 3 --model sonnet
npm run parity:stream -- --limit 3 --model sonnet --extra-args "--include-partial-messages"
```

The first command should not emit `stream_event` deltas. The second should emit them and still produce one completed `assistant` plus one `result` per turn.

---

## Project Structure

```
src/
├── cli.ts                    # Entry point: wire components, start
├── args.ts                   # CLI arg parsing + help text
├── session.ts                # Turn/control state machine and operation runner
├── stdin-reader.ts           # Parse stdin (text or stream-json)
├── session-op-queue.ts       # Priority queue for prompts and controls
├── output.ts                 # Emit stream-json / text / json on stdout
├── message-assembler.ts      # Accumulate SSE events → complete assistant messages
├── message-request-filter.ts # Keep internal Claude API calls out of public output
├── api-debug.ts              # Redacted proxy API diagnostics
├── proxy.ts                  # HTTP proxy server + SSE event extraction
├── pty-host.ts               # Spawn claude in PTY, send keystrokes
├── pid-watcher.ts            # Poll PID file for status, read transcript
└── backends/
    ├── types.ts              # ObservationBackend interface
    └── proxy-backend.ts      # Proxy backend implementation
```

---

## Limitations

- **Requires Claude Code** installed and authenticated on the target machine
- **`node-pty` native module** may need source compilation on some platforms
- **Trust dialog** — clarp runs Claude Code in a hidden interactive PTY. If Claude asks to trust the current folder, clarp exits with a message. Run `claude` in that directory once and choose "Yes, I trust this folder". If `--dangerously-skip-permissions` is passed, clarp auto-confirms Claude's workspace trust prompt.
- **MCP control requests** (`mcp_status`, `mcp_message`, etc.) are not supported — these are SDK-specific
- **`--json-schema`** is not supported — would require modifying API request bodies
- **`ANTHROPIC_BASE_URL`** — if Claude Code stops honoring this environment variable, the proxy approach breaks. A JSONL transcript fallback backend is planned.

---

## FAQ

**Is this against Anthropic's terms of service?**

clarp uses your own Claude Code subscription through the official `claude` binary. It doesn't bypass authentication, modify API requests, or access other users' sessions. The proxy observes API traffic from a process you own on your own machine — similar to running a network inspector like Wireshark or Charles Proxy.

That said, this is experimental software and the approach is unconventional. Review Anthropic's terms and decide for yourself.

**What happens if Anthropic blocks this?**

The most likely breakpoint is `ANTHROPIC_BASE_URL` being restricted. clarp's architecture supports alternative observation backends (like JSONL transcript tailing) that don't require the proxy. The `ObservationBackend` interface exists for exactly this reason.

**Does this work with Claude Max / Pro / Team?**

Yes — any plan that runs Claude Code interactively.

**Can I use this in CI/CD?**

Yes, if Claude Code is installed and authenticated on the CI runner. You'll need `--dangerously-skip-permissions` since there's no TTY for approval prompts.

**Is the proxy a security risk?**

The proxy binds to `127.0.0.1` (localhost only), doesn't store any data, and is scoped to the single Claude process it spawned. It cannot see traffic from other processes or users. The source code is fully auditable.

**Why not just use `claude -p`?**

If `-p` metering doesn't concern you, use `claude -p`. clarp exists specifically for the case where you want the same protocol without per-call pricing.

---

## Disclaimer

This project is **experimental software** provided as-is.

- **Not affiliated with Anthropic** in any way
- **Not guaranteed to work** across Claude Code versions
- **Not intended to circumvent** any terms of service — it uses your own subscription through the official Claude Code process
- **Potentially breakable** by any Claude Code update that changes internal behavior

**Use at your own risk.** Review the source code before running.

---

## Contributing

Issues and PRs welcome. Please include test cases for any new features.

```bash
git clone https://github.com/dn00/clarp.git
cd clarp
npm install
npm test
npm run build           # compile TypeScript
```

## License

MIT
