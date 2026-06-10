# Native `claude -p` golden captures

Recorded ground-truth output of **native** `claude -p` across the behavior
surface clarp emulates. Captured while `claude -p` was still covered by the
Claude Code subscription; after 2026-06-15 it bills at metered API pricing, so
these recordings are how clarp checks parity without paying for native runs.

## What's here

Each dated directory is one capture session of `scripts/cases-goldens.json`
run with `npm run parity:golden-capture`:

- `report.json` — per-case event-count summaries plus capture metadata
  (`native_version`, `captured_at`, model).
- `<case>/native.stdout.jsonl` — every stream-json event native claude
  emitted, verbatim, in order.
- `<case>/native.timeline.jsonl` — timestamped record of what the harness
  sent (prompts, control requests/responses, signals) and received.
- `<case>/native.stderr.log` — native stderr.

The case matrix covers: multi-turn text, tool use (Bash/Read), the
`can_use_tool` permission round-trip (allow and deny via
`--permission-prompt-tool stdio`), deny-by-default with no permission tool,
WebSearch (`server_tool_use` blocks), extended thinking,
`--include-partial-messages`, `--replay-user-messages`, `--max-turns`
exhaustion, invalid-model error shapes, `--session-id`/`--resume`/`--continue`,
the `initialize`/`set_permission_mode` control protocol, and `json`/`text`
output formats.

Two additional capture sets use their own case files:

- `2026-06-10-interrupt/` — `scripts/cases-interrupt.json`: interrupt during a
  long task (control-protocol and SIGINT), double interrupt, and
  interrupt-then-prompt pipelines. Native answers an interrupted turn with
  `result.error_during_execution`; follow-up prompts produce normal
  `result.success`.
- `2026-06-10-task-subagent/` — `scripts/cases-task-subagent.json`: a Task
  subagent round-trip (tool name `Agent` in 2.1.170). Notable ground truth:
  native emits **zero** sidechain lines on stdout, and emits
  `system.task_started` / `system.task_notification` events for the subagent
  lifecycle.

## How to use

Check clarp against the goldens (free — never spawns native):

```
npm run parity:replay
```

This runs clarp through the same case matrix and diffs its event summaries
against the recorded native summaries in `report.json`.

To study exact native event shapes (field names, nesting, ordering), read the
`native.stdout.jsonl` files directly — they are the authority whenever a test
fixture and reality disagree.

## Capture conventions

- Captured from this repo's root (no `.claude/` or `CLAUDE.md` exists here, so
  no project-level settings leak in). Permission cases run in
  `.parity-runs/golden-cwd` (gitignored scratch).
- Assistant text content is nondeterministic run-to-run; event *structure* is
  the contract. Compare shapes and counts, not prose.
- Re-capture (`npm run parity:golden-capture -- --out goldens/<date>-claude-<version>`)
  only when a new claude version changes the protocol — and from 2026-06-15 on,
  expect it to cost API credits.
