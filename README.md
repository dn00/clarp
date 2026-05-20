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
  startObserving(opts: { transcriptPath?: string }): Promise<void>;
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
- If you see `posix_spawnp failed`, run `npm rebuild node-pty` to compile the native PTY module from source (requires Xcode CLI tools on macOS)

---

## Usage

### Single prompt

```bash
# Plain text output (default)
clarp "explain this function"

# JSON result
clarp --output-format json "explain this function"

# Full streaming (token-level events)
clarp --output-format stream-json "explain this function"
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

Each turn produces a full event cycle: `init → stream_events → assistant → result`. Prompts are queued and dispatched sequentially — clarp waits for Claude to be idle before sending the next prompt.

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
| `--verbose` | Include all events (automatic with `stream-json`) |
| `--include-partial-messages` | Include token-level `stream_event` deltas (automatic with `stream-json`) |
| `--replay-user-messages` | Echo accepted user messages back on stdout |
| `--max-turns <n>` | Stop after N agentic turns |
| `--max-budget-usd <n>` | Accepted for compatibility; currently warns and is not enforced |

### Pass-through to Claude Code

These flags are forwarded directly to the interactive Claude process:

| Flag | Flag |
|------|------|
| `--model` | `--permission-mode` |
| `--system-prompt` | `--append-system-prompt` |
| `--allowed-tools` | `--disallowed-tools` |
| `--session-id` | `--continue` / `--resume` |
| `--add-dir` | `--mcp-config` |
| `--bare` | `--effort` |
| `--agent` / `--agents` | `--name` |
| `--fallback-model` | `--permission-prompt-tool` |
| `--dangerously-skip-permissions` | `--settings` |

---

## Feature Parity

### Output events

| Event | `claude -p` | `clarp` | Notes |
|-------|:-----------:|:-------:|-------|
| `stream_event` (token deltas) | Yes | Yes | Real-time via SSE proxy |
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
| **Streaming** | Token-level | Token-level (identical) |
| **Terminal** | None | Full PTY (not exposed) |
| **Sessions** | Per-invocation | Persistent (resume with `--continue`) |
| **Latency** | Direct API | +~1ms (proxy hop) |

---

## Testing

```bash
npm test
npm run test:watch
```

Tests cover SSE parsing, message assembly, output formatting, PID file watching, session lifecycle, permission forwarding, and protocol parity against captured `claude -p` output. Includes schema validation for all 25 SDK output types and all 21 control request subtypes.

---

## Project Structure

```
src/
├── cli.ts                    # Entry point: wire components, start
├── args.ts                   # CLI arg parsing + help text
├── session.ts                # Turn state machine, prompt queue, readiness gate
├── stdin-reader.ts           # Parse stdin (text or stream-json)
├── prompt-queue.ts           # Async prompt queue with idle-wait
├── output.ts                 # Emit stream-json / text / json on stdout
├── message-assembler.ts      # Accumulate SSE events → complete assistant messages
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
- **Trust dialog** — Claude shows a workspace trust dialog for untrusted directories. Use `--dangerously-skip-permissions` or work in a trusted project.
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
npm rebuild node-pty    # if needed
npm test
npm run build           # compile TypeScript
```

## License

MIT
