/**
 * Behavioral tests for extracted CLI helpers — arg parsing, prompt queue,
 * stdin line parsing.
 */
import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { parseArgs, type Args } from "./args.js";
import { PromptQueue } from "./prompt-queue.js";
import { parseStdinLine, StdinReader } from "./stdin-reader.js";

describe("parseArgs", () => {
  it("returns null for -h", () => {
    expect(parseArgs(["-h"])).toBeNull();
  });

  it("returns null for --help", () => {
    expect(parseArgs(["--help"])).toBeNull();
  });

  it("returns null for -v", () => {
    expect(parseArgs(["-v"])).toBeNull();
  });

  it("skips -p flag", () => {
    const args = parseArgs(["-p", "hello"]) as Args;
    expect(args.prompt).toBe("hello");
  });

  it("treats bare dash as a stdin prompt sentinel", () => {
    const args = parseArgs(["-p", "-"]) as Args;
    expect(args.prompt).toBeNull();
    expect(args.readPromptFromStdin).toBe(true);
    expect(args.claudeArgs).toEqual([]);
  });

  it("supports stdin prompt sentinel without -p", () => {
    const args = parseArgs(["-"]) as Args;
    expect(args.prompt).toBeNull();
    expect(args.readPromptFromStdin).toBe(true);
    expect(args.claudeArgs).toEqual([]);
  });

  it("parses output format", () => {
    const args = parseArgs(["--output-format", "stream-json"]) as Args;
    expect(args.outputFormat).toBe("stream-json");
  });

  it("rejects invalid output format", () => {
    expect(() => parseArgs(["--output-format", "banana"])).toThrow("Invalid --output-format");
  });

  it("rejects invalid output format in equals form", () => {
    expect(() => parseArgs(["--output-format=banana"])).toThrow("Invalid --output-format");
  });

  it("parses input format", () => {
    const args = parseArgs(["--input-format", "stream-json"]) as Args;
    expect(args.inputFormat).toBe("stream-json");
  });

  it("rejects invalid input format", () => {
    expect(() => parseArgs(["--input-format", "banana"])).toThrow("Invalid --input-format");
  });

  it("rejects invalid input format in equals form", () => {
    expect(() => parseArgs(["--input-format=banana"])).toThrow("Invalid --input-format");
  });

  it("stream-json auto-enables verbose without partial deltas", () => {
    const args = parseArgs(["--output-format", "stream-json"]) as Args;
    expect(args.verbose).toBe(true);
    expect(args.includePartial).toBe(false);
  });

  it("sets includePartial only when explicitly requested", () => {
    const args = parseArgs(["--output-format", "stream-json", "--include-partial-messages"]) as Args;
    expect(args.verbose).toBe(true);
    expect(args.includePartial).toBe(true);
  });

  it("parses max-turns", () => {
    const args = parseArgs(["--max-turns", "5"]) as Args;
    expect(args.maxTurns).toBe(5);
  });

  it("parses max-turns in equals form", () => {
    const args = parseArgs(["--max-turns=5"]) as Args;
    expect(args.maxTurns).toBe(5);
  });

  it("parses max-budget-usd", () => {
    const args = parseArgs(["--max-budget-usd", "1.50"]) as Args;
    expect(args.maxBudgetUsd).toBe(1.5);
  });

  it("parses max-budget-usd in equals form", () => {
    const args = parseArgs(["--max-budget-usd=1.50"]) as Args;
    expect(args.maxBudgetUsd).toBe(1.5);
  });

  it("rejects invalid max-turns", () => {
    expect(() => parseArgs(["--max-turns", "abc"])).toThrow("Invalid --max-turns: abc");
    expect(() => parseArgs(["--max-turns=0"])).toThrow("Invalid --max-turns: 0");
    expect(() => parseArgs(["--max-turns"])).toThrow("Invalid --max-turns: (missing)");
  });

  it("rejects invalid max-budget-usd", () => {
    expect(() => parseArgs(["--max-budget-usd", "abc"])).toThrow("Invalid --max-budget-usd: abc");
    expect(() => parseArgs(["--max-budget-usd=0"])).toThrow("Invalid --max-budget-usd: 0");
    expect(() => parseArgs(["--max-budget-usd"])).toThrow("Invalid --max-budget-usd: (missing)");
  });

  it("passes through --model with value", () => {
    const args = parseArgs(["--model", "claude-opus-4-7"]) as Args;
    expect(args.claudeArgs).toEqual(["--model", "claude-opus-4-7"]);
  });

  it("passes through --dangerously-skip-permissions (no value)", () => {
    const args = parseArgs(["--dangerously-skip-permissions"]) as Args;
    expect(args.claudeArgs).toEqual(["--dangerously-skip-permissions"]);
  });

  it("passes through --permission-mode with value", () => {
    const args = parseArgs(["--permission-mode", "plan"]) as Args;
    expect(args.claudeArgs).toEqual(["--permission-mode", "plan"]);
  });

  it("passes through Claude tool allow/deny aliases with values", () => {
    const args = parseArgs([
      "--allowedTools", "WebSearch", "WebFetch", "Bash(git *)",
      "--disallowedTools", "Edit",
      "--allowed-tools", "Read",
      "--disallowed-tools", "Write",
      "-p", "hello",
    ]) as Args;

    expect(args.claudeArgs).toEqual([
      "--allowedTools", "WebSearch", "WebFetch", "Bash(git *)",
      "--disallowedTools", "Edit",
      "--allowed-tools", "Read",
      "--disallowed-tools", "Write",
    ]);
    expect(args.prompt).toBe("hello");
  });

  it("passes through comma-separated Claude tool values", () => {
    const args = parseArgs(["--allowedTools", "WebSearch,WebFetch", "-p", "hello"]) as Args;
    expect(args.claudeArgs).toEqual(["--allowedTools", "WebSearch,WebFetch"]);
    expect(args.prompt).toBe("hello");
  });

  it("passes through quoted space-separated Claude tool values", () => {
    const args = parseArgs(["--allowedTools", "Bash(git *) Edit", "-p", "hello"]) as Args;
    expect(args.claudeArgs).toEqual(["--allowedTools", "Bash(git *) Edit"]);
    expect(args.prompt).toBe("hello");
  });

  it("passes through newer value flags without treating values as prompts", () => {
    const args = parseArgs([
      "--fallback-model", "claude-sonnet-4-5",
      "--permission-prompt-tool", "mcp__permissions__prompt",
      "hello",
    ]) as Args;
    expect(args.claudeArgs).toEqual([
      "--fallback-model", "claude-sonnet-4-5",
      "--permission-prompt-tool", "mcp__permissions__prompt",
    ]);
    expect(args.prompt).toBe("hello");
  });

  it("passes through Claude scalar value flags", () => {
    const args = parseArgs([
      "--json-schema", "{\"type\":\"object\"}",
      "--debug-file", "/tmp/claude-debug.log",
      "--remote-control-session-name-prefix", "ci",
      "--plugin-dir", "/tmp/plugin",
      "--plugin-url", "https://example.com/plugin.zip",
      "--thinking", "enabled",
      "--task-budget", "1000",
      "--system-prompt-file", "/tmp/system.md",
      "--append-system-prompt-file", "/tmp/append.md",
      "--prefill", "draft",
      "--deep-link-repo", "owner/repo",
      "--deep-link-last-fetch", "12345",
      "--resume-session-at", "msg_123",
      "--rewind-files", "msg_456",
      "--workload", "cron",
      "--advisor", "opus",
      "--messaging-socket-path", "/tmp/claude.sock",
      "--agent-id", "agent-1",
      "--agent-name", "Agent One",
      "--team-name", "Team One",
      "--agent-color", "blue",
      "--parent-session-id", "parent-1",
      "--teammate-mode", "tmux",
      "--agent-type", "reviewer",
      "--sdk-url", "ws://localhost:1234",
      "-n", "named-session",
      "hello",
    ]) as Args;

    expect(args.claudeArgs).toEqual([
      "--json-schema", "{\"type\":\"object\"}",
      "--debug-file", "/tmp/claude-debug.log",
      "--remote-control-session-name-prefix", "ci",
      "--plugin-dir", "/tmp/plugin",
      "--plugin-url", "https://example.com/plugin.zip",
      "--thinking", "enabled",
      "--task-budget", "1000",
      "--system-prompt-file", "/tmp/system.md",
      "--append-system-prompt-file", "/tmp/append.md",
      "--prefill", "draft",
      "--deep-link-repo", "owner/repo",
      "--deep-link-last-fetch", "12345",
      "--resume-session-at", "msg_123",
      "--rewind-files", "msg_456",
      "--workload", "cron",
      "--advisor", "opus",
      "--messaging-socket-path", "/tmp/claude.sock",
      "--agent-id", "agent-1",
      "--agent-name", "Agent One",
      "--team-name", "Team One",
      "--agent-color", "blue",
      "--parent-session-id", "parent-1",
      "--teammate-mode", "tmux",
      "--agent-type", "reviewer",
      "--sdk-url", "ws://localhost:1234",
      "-n", "named-session",
    ]);
    expect(args.prompt).toBe("hello");
  });

  it("passes through Claude optional value flags", () => {
    const args = parseArgs([
      "--resume", "abc123",
      "-r", "def456",
      "--debug", "api,hooks",
      "-d", "!file",
      "--from-pr", "123",
      "--remote-control", "sidecar",
      "--rc", "sidecar-2",
      "--worktree", "scratch",
      "-w", "scratch-2",
      "--teleport", "tele-1",
      "--remote", "remote description",
      "--tasks", "tasklist",
      "hello",
    ]) as Args;

    expect(args.claudeArgs).toEqual([
      "--resume", "abc123",
      "-r", "def456",
      "--debug", "api,hooks",
      "-d", "!file",
      "--from-pr", "123",
      "--remote-control", "sidecar",
      "--rc", "sidecar-2",
      "--worktree", "scratch",
      "-w", "scratch-2",
      "--teleport", "tele-1",
      "--remote", "remote description",
      "--tasks", "tasklist",
    ]);
    expect(args.prompt).toBe("hello");
  });

  it("passes through Claude optional value flags without values", () => {
    const args = parseArgs([
      "--resume",
      "-r",
      "--debug",
      "-d",
      "--from-pr",
      "--remote-control",
      "--rc",
      "--worktree",
      "-w",
      "--teleport",
      "--remote",
      "--tasks",
      "-p", "hello",
    ]) as Args;

    expect(args.claudeArgs).toEqual([
      "--resume",
      "-r",
      "--debug",
      "-d",
      "--from-pr",
      "--remote-control",
      "--rc",
      "--worktree",
      "-w",
      "--teleport",
      "--remote",
      "--tasks",
    ]);
    expect(args.prompt).toBe("hello");
  });

  it("passes through Claude boolean flags without consuming the prompt", () => {
    const args = parseArgs([
      "--bare",
      "--continue",
      "-c",
      "--allow-dangerously-skip-permissions",
      "--dangerously-skip-permissions",
      "--strict-mcp-config",
      "--fork-session",
      "--no-session-persistence",
      "--disable-slash-commands",
      "--mcp-debug",
      "--ide",
      "--chrome",
      "--no-chrome",
      "--brief",
      "--tmux",
      "-d2e",
      "--debug-to-stderr",
      "--init",
      "--init-only",
      "--maintenance",
      "--enable-auth-status",
      "--deep-link-origin",
      "--plan-mode-required",
      "--delegate-permissions",
      "--dangerously-skip-permissions-with-classifiers",
      "--afk",
      "--agent-teams",
      "--enable-auto-mode",
      "--proactive",
      "--assistant",
      "--hard-fail",
      "hello",
    ]) as Args;

    expect(args.claudeArgs).toEqual([
      "--bare",
      "--continue",
      "-c",
      "--allow-dangerously-skip-permissions",
      "--dangerously-skip-permissions",
      "--strict-mcp-config",
      "--fork-session",
      "--no-session-persistence",
      "--disable-slash-commands",
      "--mcp-debug",
      "--ide",
      "--chrome",
      "--no-chrome",
      "--brief",
      "--tmux",
      "-d2e",
      "--debug-to-stderr",
      "--init",
      "--init-only",
      "--maintenance",
      "--enable-auth-status",
      "--deep-link-origin",
      "--plan-mode-required",
      "--delegate-permissions",
      "--dangerously-skip-permissions-with-classifiers",
      "--afk",
      "--agent-teams",
      "--enable-auto-mode",
      "--proactive",
      "--assistant",
      "--hard-fail",
    ]);
    expect(args.prompt).toBe("hello");
  });

  it("passes through Claude variadic value flags until the next flag", () => {
    const args = parseArgs([
      "--add-dir", "/tmp/a", "/tmp/b",
      "--mcp-config", "server-a.json", "server-b.json",
      "--betas", "beta-a", "beta-b",
      "--file", "file_abc:a.txt", "file_def:b.txt",
      "--tools", "Bash", "Read",
      "--allowedTools", "WebSearch", "WebFetch",
      "--disallowed-tools", "Edit", "Write",
      "--channels", "server-a", "server-b",
      "--dangerously-load-development-channels", "dev-a", "dev-b",
      "-p", "hello",
    ]) as Args;

    expect(args.claudeArgs).toEqual([
      "--add-dir", "/tmp/a", "/tmp/b",
      "--mcp-config", "server-a.json", "server-b.json",
      "--betas", "beta-a", "beta-b",
      "--file", "file_abc:a.txt", "file_def:b.txt",
      "--tools", "Bash", "Read",
      "--allowedTools", "WebSearch", "WebFetch",
      "--disallowed-tools", "Edit", "Write",
      "--channels", "server-a", "server-b",
      "--dangerously-load-development-channels", "dev-a", "dev-b",
    ]);
    expect(args.prompt).toBe("hello");
  });

  it("uses -- to separate prompt text after variadic Claude flags", () => {
    const args = parseArgs(["--add-dir", "/tmp/a", "--", "summarize", "this"]) as Args;
    expect(args.claudeArgs).toEqual(["--add-dir", "/tmp/a"]);
    expect(args.prompt).toBe("summarize");
  });

  it("passes through --flag=value form", () => {
    const args = parseArgs(["--model=claude-opus-4-7", "hello"]) as Args;
    expect(args.claudeArgs).toEqual(["--model=claude-opus-4-7"]);
    expect(args.prompt).toBe("hello");
  });

  it("passes through Claude value flags in equals form", () => {
    const args = parseArgs([
      "--model=opus",
      "--allowedTools=WebSearch,WebFetch",
      "--plugin-dir=/tmp/plugin",
      "hello",
    ]) as Args;

    expect(args.claudeArgs).toEqual([
      "--model=opus",
      "--allowedTools=WebSearch,WebFetch",
      "--plugin-dir=/tmp/plugin",
    ]);
    expect(args.prompt).toBe("hello");
  });

  it("rejects missing required Claude scalar flag values", () => {
    const cases = [
      ["--model", "model"],
      ["--permission-mode", "mode"],
      ["--system-prompt", "prompt"],
      ["--system-prompt-file", "file"],
      ["--append-system-prompt", "prompt"],
      ["--append-system-prompt-file", "file"],
      ["--session-id", "uuid"],
      ["--effort", "level"],
      ["--agent", "agent"],
      ["--agents", "json"],
      ["--name", "name"],
      ["-n", "name"],
      ["--setting-sources", "sources"],
      ["--settings", "file-or-json"],
      ["--fallback-model", "model"],
      ["--permission-prompt-tool", "tool"],
      ["--max-thinking-tokens", "tokens"],
      ["--output-style", "style"],
      ["--debug-file", "path"],
      ["--json-schema", "schema"],
      ["--remote-control-session-name-prefix", "prefix"],
      ["--plugin-dir", "path"],
      ["--plugin-url", "url"],
      ["--thinking", "mode"],
      ["--task-budget", "tokens"],
      ["--prefill", "text"],
      ["--deep-link-repo", "slug"],
      ["--deep-link-last-fetch", "ms"],
      ["--resume-session-at", "message id"],
      ["--rewind-files", "user-message-id"],
      ["--workload", "tag"],
      ["--advisor", "model"],
      ["--messaging-socket-path", "path"],
      ["--agent-id", "id"],
      ["--agent-name", "name"],
      ["--team-name", "name"],
      ["--agent-color", "color"],
      ["--parent-session-id", "id"],
      ["--teammate-mode", "mode"],
      ["--agent-type", "type"],
      ["--sdk-url", "url"],
    ];

    for (const [flag, label] of cases) {
      expect(() => parseArgs(["hello", flag!])).toThrow(`error: option '${flag} <${label}>' argument missing`);
      expect(() => parseArgs([flag!, "--model", "opus"])).toThrow(`error: option '${flag} <${label}>' argument missing`);
    }
  });

  it("rejects missing required Claude variadic flag values", () => {
    const cases = [
      ["--add-dir", "error: option '--add-dir <directories...>' argument missing"],
      ["--mcp-config", "error: option '--mcp-config <configs...>' argument missing"],
      ["--betas", "error: option '--betas <betas...>' argument missing"],
      ["--file", "error: option '--file <specs...>' argument missing"],
      ["--tools", "error: option '--tools <tools...>' argument missing"],
      ["--allowedTools", "error: option '--allowedTools, --allowed-tools <tools...>' argument missing"],
      ["--allowed-tools", "error: option '--allowedTools, --allowed-tools <tools...>' argument missing"],
      ["--disallowedTools", "error: option '--disallowedTools, --disallowed-tools <tools...>' argument missing"],
      ["--disallowed-tools", "error: option '--disallowedTools, --disallowed-tools <tools...>' argument missing"],
      ["--channels", "error: option '--channels <value>' argument missing"],
      [
        "--dangerously-load-development-channels",
        "error: option '--dangerously-load-development-channels <value>' argument missing",
      ],
    ];

    for (const [flag, message] of cases) {
      expect(() => parseArgs([flag!])).toThrow(message);
      expect(() => parseArgs([flag!, "--model", "opus"])).toThrow(message);
    }
  });

  it("uses only the first positional argument as the prompt", () => {
    const args = parseArgs(["-p", "say", "hello", "world"]) as Args;
    expect(args.prompt).toBe("say");
  });

  it("matches Claude when extra positional words surround options", () => {
    const args = parseArgs([
      "-p", "ello", "world",
      "--model", "claude-opus-4-6[1M]",
      "do", "yo", "usee", "model", "param",
    ]) as Args;

    expect(args.prompt).toBe("ello");
    expect(args.claudeArgs).toEqual(["--model", "claude-opus-4-6[1M]"]);
  });

  it("uses -- to pass multi-word prompt text explicitly", () => {
    const args = parseArgs(["--model", "opus", "--", "say", "hello", "world"]) as Args;
    expect(args.prompt).toBe("say");
    expect(args.claudeArgs).toEqual(["--model", "opus"]);
  });

  it("treats option-looking text after -- as the prompt", () => {
    const args = parseArgs(["-p", "--", "--model", "opus"]) as Args;
    expect(args.prompt).toBe("--model");
    expect(args.claudeArgs).toEqual([]);
  });

  it("rejects unknown options before spawning Claude", () => {
    expect(() => parseArgs(["-p", "hi", "--definitely-unknown"])).toThrow(
      "error: unknown option '--definitely-unknown'",
    );
    expect(() => parseArgs(["-p", "hi", "-Z"])).toThrow("error: unknown option '-Z'");
    expect(() => parseArgs(["-p", "hi", "--unknown=value"])).toThrow(
      "error: unknown option '--unknown=value'",
    );
  });

  it("rejects equals form for Claude boolean flags", () => {
    expect(() => parseArgs(["-p", "hi", "--tmux=classic"])).toThrow("error: unknown option '--tmux=classic'");
    expect(() => parseArgs(["-p", "hi", "--bare=true"])).toThrow("error: unknown option '--bare=true'");
  });

  it("parses clarp flags after the prompt", () => {
    const args = parseArgs(["-p", "hi", "--verbose", "--output-format", "json"]) as Args;
    expect(args.prompt).toBe("hi");
    expect(args.verbose).toBe(true);
    expect(args.outputFormat).toBe("json");
  });

  it("sets verbose flag", () => {
    const args = parseArgs(["--verbose"]) as Args;
    expect(args.verbose).toBe(true);
  });

  it("sets replay-user-messages flag", () => {
    const args = parseArgs(["--replay-user-messages"]) as Args;
    expect(args.replayUserMessages).toBe(true);
  });

  it("ignores --include-hook-events", () => {
    const args = parseArgs(["--include-hook-events", "hello"]) as Args;
    expect(args.prompt).toBe("hello");
  });

  it("defaults to text format", () => {
    const args = parseArgs([]) as Args;
    expect(args.outputFormat).toBe("text");
    expect(args.inputFormat).toBe("text");
    expect(args.verbose).toBe(false);
    expect(args.includePartial).toBe(false);
    expect(args.readPromptFromStdin).toBe(false);
  });
});

describe("PromptQueue", () => {
  it("enqueue and dequeue FIFO", () => {
    const q = new PromptQueue();
    q.enqueue({ content: "first" });
    q.enqueue({ content: "second" });
    expect(q.dequeue()).toEqual({ content: "first" });
    expect(q.dequeue()).toEqual({ content: "second" });
  });

  it("dequeue returns undefined when empty", () => {
    const q = new PromptQueue();
    expect(q.dequeue()).toBeUndefined();
  });

  it("length tracks queue size", () => {
    const q = new PromptQueue();
    expect(q.length).toBe(0);
    q.enqueue({ content: "a" });
    expect(q.length).toBe(1);
    q.dequeue();
    expect(q.length).toBe(0);
  });

  it("waitForItem resolves immediately if queue non-empty", async () => {
    const q = new PromptQueue();
    q.enqueue({ content: "ready" });
    await expect(q.waitForItem()).resolves.toBe(true);
    expect(q.dequeue()).toEqual({ content: "ready" });
  });

  it("waitForItem waits for next enqueue", async () => {
    const q = new PromptQueue();
    let resolved = false;
    const p = q.waitForItem().then((hasItem) => { resolved = hasItem; });
    expect(resolved).toBe(false);
    q.enqueue({ content: "later" });
    await p;
    expect(resolved).toBe(true);
  });

  it("close wakes pending waiters", async () => {
    const q = new PromptQueue();
    const p = q.waitForItem();
    q.close();
    await expect(p).resolves.toBe(false);
  });
});

describe("parseStdinLine", () => {
  function makeCallbacks() {
    return {
      userMessages: [] as string[],
      controlRequests: [] as Array<{ req: Record<string, unknown>; requestId?: string }>,
      controlResponses: [] as Array<{ resp: Record<string, unknown>; requestId: string }>,
      keepAlives: 0,
      malformedLines: [] as string[],
      onUserMessage(content: string) { this.userMessages.push(content); },
      onControlRequest(req: Record<string, unknown>, requestId?: string) { this.controlRequests.push({ req, requestId }); },
      onControlResponse(resp: Record<string, unknown>, requestId: string) { this.controlResponses.push({ resp, requestId }); },
      onKeepAlive() { this.keepAlives++; },
      onMalformedLine(message: string) { this.malformedLines.push(message); },
    };
  }

  it("parses user message with string content", () => {
    const cb = makeCallbacks();
    parseStdinLine(JSON.stringify({ type: "user", message: { role: "user", content: "hello" } }), cb);
    expect(cb.userMessages).toEqual(["hello"]);
  });

  it("parses user message with array content, extracts text blocks", () => {
    const cb = makeCallbacks();
    parseStdinLine(JSON.stringify({
      type: "user",
      message: { role: "user", content: [
        { type: "text", text: "part1" },
        { type: "image", data: "..." },
        { type: "text", text: "part2" },
      ]},
    }), cb);
    expect(cb.userMessages).toEqual(["part1part2"]);
  });

  it("skips user message with empty content", () => {
    const cb = makeCallbacks();
    parseStdinLine(JSON.stringify({ type: "user", message: { role: "user", content: "" } }), cb);
    expect(cb.userMessages).toHaveLength(0);
  });

  it("routes control_request with subtype", () => {
    const cb = makeCallbacks();
    parseStdinLine(JSON.stringify({
      type: "control_request",
      request_id: "req-1",
      request: { subtype: "interrupt" },
    }), cb);
    expect(cb.controlRequests).toHaveLength(1);
    expect(cb.controlRequests[0]!.req.subtype).toBe("interrupt");
    expect(cb.controlRequests[0]!.requestId).toBe("req-1");
  });

  it("routes control_response with allow", () => {
    const cb = makeCallbacks();
    parseStdinLine(JSON.stringify({
      type: "control_response",
      request_id: "req-1",
      response: { behavior: "allow", toolUseID: "t1" },
    }), cb);
    expect(cb.controlResponses).toHaveLength(1);
    expect(cb.controlResponses[0]!.resp.behavior).toBe("allow");
    expect(cb.controlResponses[0]!.requestId).toBe("req-1");
  });

  it("handles keep_alive", () => {
    const cb = makeCallbacks();
    parseStdinLine(JSON.stringify({ type: "keep_alive" }), cb);
    expect(cb.keepAlives).toBe(1);
  });

  it("reports malformed JSON", () => {
    const cb = makeCallbacks();
    parseStdinLine("not json at all", cb);
    expect(cb.userMessages).toHaveLength(0);
    expect(cb.controlRequests).toHaveLength(0);
    expect(cb.keepAlives).toBe(0);
    expect(cb.malformedLines[0]).toContain("Malformed stream-json input ignored");
  });
});

describe("StdinReader", () => {
  it("text mode emits prompt and EOF", async () => {
    const input = new PassThrough();
    const events: string[] = [];
    const reader = new StdinReader(input, { inputFormat: "text", prompt: null, readPromptFromStdin: false }, {
      onUserMessage: (content) => events.push(`user:${content}`),
      onControlRequest: () => {},
      onControlResponse: () => {},
      onKeepAlive: () => {},
      onEof: () => events.push("eof"),
    });

    reader.start();
    input.end("hello from stdin\n");
    await new Promise(resolve => setImmediate(resolve));

    expect(events).toEqual(["user:hello from stdin", "eof"]);
  });

  it("text mode emits EOF for empty stdin", async () => {
    const input = new PassThrough();
    const events: string[] = [];
    const reader = new StdinReader(input, { inputFormat: "text", prompt: null, readPromptFromStdin: false }, {
      onUserMessage: (content) => events.push(`user:${content}`),
      onControlRequest: () => {},
      onControlResponse: () => {},
      onKeepAlive: () => {},
      onEof: () => events.push("eof"),
    });

    reader.start();
    input.end("");
    await new Promise(resolve => setImmediate(resolve));

    expect(events).toEqual(["eof"]);
  });

  it("text mode reads stdin when dash sentinel is set", async () => {
    const input = new PassThrough();
    const events: string[] = [];
    const reader = new StdinReader(input, { inputFormat: "text", prompt: null, readPromptFromStdin: true }, {
      onUserMessage: (content) => events.push(`user:${content}`),
      onControlRequest: () => {},
      onControlResponse: () => {},
      onKeepAlive: () => {},
      onEof: () => events.push("eof"),
    });

    reader.start();
    input.end("hello from dash\n");
    await new Promise(resolve => setImmediate(resolve));

    expect(events).toEqual(["user:hello from dash", "eof"]);
  });

  it("text mode ignores stdin when an explicit prompt is present", async () => {
    const input = new PassThrough();
    const events: string[] = [];
    const reader = new StdinReader(input, { inputFormat: "text", prompt: "hello", readPromptFromStdin: false }, {
      onUserMessage: (content) => events.push(`user:${content}`),
      onControlRequest: () => {},
      onControlResponse: () => {},
      onKeepAlive: () => {},
      onEof: () => events.push("eof"),
    });

    reader.start();
    input.end("ignored\n");
    await new Promise(resolve => setImmediate(resolve));

    expect(events).toEqual([]);
  });

  it("stream-json mode rejects oversized lines", async () => {
    const input = new PassThrough();
    const events: string[] = [];
    const reader = new StdinReader(input, { inputFormat: "stream-json", prompt: null, readPromptFromStdin: false }, {
      onUserMessage: (content) => events.push(`user:${content}`),
      onControlRequest: () => {},
      onControlResponse: () => {},
      onKeepAlive: () => {},
      onEof: () => events.push("eof"),
      onMalformedLine: (message) => events.push(`malformed:${message}`),
    });

    reader.start();
    input.write("x".repeat(1024 * 1024 + 1));
    await new Promise(resolve => setImmediate(resolve));

    expect(events.some(e => e.startsWith("malformed:stream-json input line exceeded"))).toBe(true);
    expect(events).toContain("eof");
  });

  it("stream-json mode parses trailing line on EOF", async () => {
    const input = new PassThrough();
    const events: string[] = [];
    const reader = new StdinReader(input, { inputFormat: "stream-json", prompt: null, readPromptFromStdin: false }, {
      onUserMessage: (content) => events.push(`user:${content}`),
      onControlRequest: () => {},
      onControlResponse: () => {},
      onKeepAlive: () => {},
      onEof: () => events.push("eof"),
      onMalformedLine: (message) => events.push(`malformed:${message}`),
    });

    reader.start();
    input.end(JSON.stringify({ type: "user", message: { role: "user", content: "last" } }));
    await new Promise(resolve => setImmediate(resolve));

    expect(events).toEqual(["user:last", "eof"]);
  });
});
