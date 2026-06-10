# Parity gaps: clarp vs native claude -p (2.1.170)

Derived by diffing `goldens/2026-06-09-claude-2.1.170/` (native ground truth)
against what clarp's `src/output.ts` / `src/message-assembler.ts` emit.
Ordered by likely impact on SDK-compatible consumers. Event shapes cited from
the golden `native.stdout.jsonl` files — read those, not memory, when fixing.

## Parity policy

clarp targets **contract parity**, not 100% literal parity. Tiers:

- **Tier 1 — lifecycle contract (always 100%):** exactly one terminal
  `result`, correct subtype/`is_error`/exit code, turn structure,
  `can_use_tool` round-trip, interrupts, never hangs silently.
- **Tier 2 — consumed fields (100%, finite list):** fields/acks real SDK
  clients read or block on: `error_max_turns`, control handshake acks,
  `stop_reason`, tool ids, thinking `signature`.
- **Tier 3 — shape completeness (on demand):** envelope `uuid`/`request_id`,
  full `usage` richness, `rate_limit_event` shape, `stream_event` counts,
  `system.task_started`/`task_notification` (observed in the task-subagent
  golden). Closed when a real consumer breaks on one.
- **Tier 4 — won't fix, by design:** values clarp cannot truthfully produce.
  Fabricating them would mislead consumers, so they are omitted instead:
  `total_cost_usd` (no metered cost exists on a subscription), `ttft_ms`
  (clarp's vantage differs), `thinking_tokens` estimates, the rich
  `initialize` ack payload (account/models/agents — clarp acks with what it
  truthfully observes: commands, output_style, pid), applying
  `set_permission_mode` to the hidden TUI (acked for protocol compatibility;
  permission decisions flow through `can_use_tool`/auto-deny).

## High impact — consumers parse these

1. **`result` field names and richness.** Native `result.success` carries
   `total_cost_usd`, `usage` (full object: cache tokens, `service_tier`,
   `iterations`, …), `modelUsage` (per-model tokens + `costUSD` +
   `contextWindow`), `duration_api_ms`, `permission_denials`, `uuid`,
   `ttft_ms`, `ttft_stream_ms`, `time_to_request_ms`, `fast_mode_state`.
   clarp emits `cost_usd` (wrong name — native is `total_cost_usd`) and has
   none of the rest. Golden: `text-multi-turn/native.stdout.jsonl`.

2. **Missing result subtype `error_max_turns`.** ✅ FIXED 2026-06-10. clarp now
   ends the session with `error_max_turns` (is_error, no `result` field) and
   exit 1 when `--max-turns` is exceeded, instead of interrupting and
   continuing with `result.success`.
   Golden: `max-turns-exhaustion/native.stdout.jsonl`.

3. **`thinking` blocks lose `signature`.** ✅ FIXED 2026-06-10. The assembler
   accumulates `signature_delta`; thinking blocks are `{type, thinking,
   signature}` like native. Golden: `thinking/native.stdout.jsonl`.

4. **`assistant` event envelope.** Native: `uuid`, `request_id`,
   `parent_tool_use_id` at top level; `message` includes `id`, `type:
   "message"`, `stop_sequence`, full `usage`, `context_management`,
   `diagnostics`, `stop_details`. clarp emits only
   `{role, content, model, stop_reason, usage}` and no envelope ids.

5. **`rate_limit_event` shape mismatch.** Native:
   `{rate_limit_info: {status, resetsAt, rateLimitType, overageStatus, …},
   uuid, session_id}` (sourced from API payload). clarp:
   `{status_code, retry_after?, limit_type?}` (sourced from HTTP headers).
   Different field set entirely. Golden: `text-multi-turn` run,
   `rate_limit_event` line.

## Medium impact

6. **`system.thinking_tokens` events.** Native streams
   `{estimated_tokens, estimated_tokens_delta}` during thinking; clarp never
   emits these. clarp observes thinking deltas over SSE, so it could estimate.

7. **`uuid` on every event.** Native stamps a uuid on each emitted event;
   clarp mostly doesn't. Cheap to add at the `writeLine` layer.

8. **`system.init` fields.** Native adds `analytics_disabled`,
   `product_feedback_disabled`, `uuid`. clarp's init lacks them.

9. **`user` (tool_result / replay) envelope.** Native includes `uuid`,
   `timestamp`, `isReplay`, `tool_use_result`; clarp's `emitUserReplay` sends
   a bare `{type, message, session_id}`.

10. **`stream_event` envelope.** Native includes `uuid`,
    `parent_tool_use_id`, `ttft_ms` alongside `event`.

## Semantics notes (not field gaps)

- Native `system.status` is emitted on permission-mode changes with
  `{status: null, permissionMode}` (golden: `control-protocol-misc`). clarp
  emits its own busy/idle `system.status` events — a clarp *extra* with
  colliding subtype but different meaning. Decide: rename clarp's, or adopt
  native's semantics and move busy/idle elsewhere.
- `system.notification` events are environment-dependent (e.g. hook errors
  from user-level settings); presence varies by machine. Compare shape, not
  presence.
- WebSearch at the stdout level is an ordinary `tool_use` named `WebSearch` +
  `tool_result` (golden: `websearch-server-tool-use`). `server_tool_use`
  blocks are an SSE-level (API) concern, which clarp's assembler now passes
  through raw.
- Known intentional clarp extras (keep): `system.session_state_changed`,
  `system.post_turn_summary`, `system.api_retry`, busy/idle status.
- `can_use_tool` allow with a *modified* `updatedInput`: native applies the
  rewritten input; clarp cannot inject input into the TUI dialog, so it
  denies instead (executing input the client never authorized would be
  worse). Identical/absent `updatedInput` allows normally. Same constraint
  applies to deny `message` text — the TUI decline is generic.

## Live replay findings (npm run parity:replay, 2026-06-09)

Found by running clarp through the golden case matrix and diffing against the
recorded native summaries (replay run: `.parity-runs/2026-06-10T06-19-26.162Z`).

11. **Permission flow wedges clarp (worst finding).** ✅ FIXED 2026-06-10
    (`fix/permission-flow-parity`). Root causes found: (a) clarp passed
    `--permission-prompt-tool stdio` through to the interactive TUI, which
    cannot honor a print-mode protocol flag — now intercepted; (b) SDK-shaped
    `control_response` answers (nested request_id) were silently dropped by
    the stdin parser — now accepted alongside the flat legacy shape; (c) stdin
    EOF with a pending permission never resolved — now auto-denied so the
    turn completes. Re-replay: all permission cases exit 0 with correct
    results; allow round-trip verified live (file written, result.success).
    Remaining: deny `message` text cannot reach the TUI (ESC is a generic
    decline), and forwarding latency is bounded by the TUI dialog appearing —
    re-measure after scratch-cwd templating.

12. **No `user` tool_result events.** ✅ FIXED 2026-06-10. Transcript
    tool-execution lines are reshaped into native's user event (`message`,
    `uuid`, `timestamp`, `tool_use_result`; sidechain excluded).
    Re-replay: `tool-use-bash-read` now shows zero key deltas vs golden.

13. **`can_use_tool` over-emission.** ✅ FIXED 2026-06-10. Emission is gated
    on `--permission-prompt-tool stdio` + stream-json input like native;
    without it clarp auto-denies via the pty so the turn completes with the
    model's explanation (native's deny-by-default behavior).

14. **Missing control acks.** ✅ FIXED 2026-06-10. clarp acks `initialize`
    (with a truthful payload: commands from the transcript init, output_style,
    pid — not native's full account/models capabilities, see tier 4) and
    `set_permission_mode` (echoing `{mode}`), using native's nested shape
    `{type, response: {subtype, request_id, response}}`. The interrupt ack was
    also migrated from clarp's old flat shape to the nested one.

15. **`--max-turns` not enforced.** ✅ FIXED 2026-06-10. See #2: clarp now
    emits `error_max_turns` and exits 1 instead of continuing.

16. **Invalid model divergence.** ✅ FIXED 2026-06-10. Turn-level backend API
    errors now report subtype `success` with `is_error: true` (matching the
    invalid-model golden) instead of subtype `error`; `emitResult` decouples
    `is_error` from subtype to allow this.

17. **`stream_event` undercount.** With `--include-partial-messages`, clarp
    emitted 4 fewer `stream_event`s than native across two prompts —
    likely missing event kinds at stream boundaries, worth a per-event diff.

WebSearch's `assistant_count_delta: +21` is mostly explained by clarp's
per-content-block message emission against the TUI's many search rounds —
re-examine after #12 lands, since the missing tool_result framing distorts
the comparison.

## How these were found

Single pass over the golden field-shape inventory:

```
python3 - <<'PY'
import json, glob
shapes = {}
for p in glob.glob('goldens/2026-06-09-claude-2.1.170/*/native.stdout.jsonl'):
    for line in open(p):
        e = json.loads(line)
        k = e.get('type','?') + ('.' + e['subtype'] if e.get('subtype') else '')
        shapes.setdefault(k, set()).update(e.keys())
for k in sorted(shapes): print(k, sorted(shapes[k]))
PY
```
