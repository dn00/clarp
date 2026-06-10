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
