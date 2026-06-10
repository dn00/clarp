# Parity gaps: clarp vs native claude -p (2.1.170)

Derived by diffing `goldens/2026-06-09-claude-2.1.170/` (native ground truth)
against what clarp's `src/output.ts` / `src/message-assembler.ts` emit.
Ordered by likely impact on SDK-compatible consumers. Event shapes cited from
the golden `native.stdout.jsonl` files — read those, not memory, when fixing.

## High impact — consumers parse these

1. **`result` field names and richness.** Native `result.success` carries
   `total_cost_usd`, `usage` (full object: cache tokens, `service_tier`,
   `iterations`, …), `modelUsage` (per-model tokens + `costUSD` +
   `contextWindow`), `duration_api_ms`, `permission_denials`, `uuid`,
   `ttft_ms`, `ttft_stream_ms`, `time_to_request_ms`, `fast_mode_state`.
   clarp emits `cost_usd` (wrong name — native is `total_cost_usd`) and has
   none of the rest. Golden: `text-multi-turn/native.stdout.jsonl`.

2. **Missing result subtype `error_max_turns`.** Native exits code 1 with
   `subtype: "error_max_turns"`, `errors: [...]`, no `result` field, when
   `--max-turns` is exhausted. clarp has no such subtype anywhere.
   Golden: `max-turns-exhaustion/native.stdout.jsonl`.

3. **`thinking` blocks lose `signature`.** Native thinking blocks are
   `{type, thinking, signature}`; clarp's assembler ignores `signature_delta`
   so its thinking blocks have no signature. Consumers that replay assistant
   content to the API need the signature. Golden: `thinking/native.stdout.jsonl`.

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

## Live replay findings (npm run parity:replay, 2026-06-09)

Found by running clarp through the golden case matrix and diffing against the
recorded native summaries (replay run: `.parity-runs/2026-06-10T06-19-26.162Z`).

11. **Permission flow wedges clarp (worst finding).** All three permission
    cases ended in SIGTERM (exit 143). Two distinct bugs:
    a. *Late forwarding:* native surfaces `can_use_tool` ~3s after the Write
       attempt; under clarp the TUI retried the tool three times
       (thinking+tool_use ×3) before clarp emitted the `control_request` at
       ~100s. Whatever clarp keys its permission detection on is slow or
       missing the first attempts.
    b. *No exit on EOF with pending permission:* after stdin closes while a
       `can_use_tool` request is outstanding, clarp never exits — hangs until
       killed. Native exits promptly when stdin closes.

12. **No `user` tool_result events.** Native emits a `user` event carrying
    `tool_use_result` after every tool execution; clarp emitted zero across
    all tool cases. SDK-style consumers watching tool results see nothing.

13. **`can_use_tool` over-emission.** Native only emits permission
    control_requests when started with `--permission-prompt-tool stdio`;
    clarp emits them unconditionally (saw one in the no-flag case).

14. **Missing control acks.** Native answers `initialize` (with a rich
    capabilities payload — commands list, etc.) and `set_permission_mode`
    (`{"mode": ...}`) with `control_response` events; clarp answered neither.

15. **`--max-turns` not enforced.** Native stops after N turns with
    `result.error_max_turns` (exit 1); clarp kept going (4 extra assistant
    events) and reported `result.success` (exit 0).

16. **Invalid model divergence.** Native reports a *success* result whose
    text explains the model problem; clarp reports `result.error`.

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
