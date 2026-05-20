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

  it("stream-json auto-enables verbose and includePartial", () => {
    const args = parseArgs(["--output-format", "stream-json"]) as Args;
    expect(args.verbose).toBe(true);
    expect(args.includePartial).toBe(true);
  });

  it("parses max-turns", () => {
    const args = parseArgs(["--max-turns", "5"]) as Args;
    expect(args.maxTurns).toBe(5);
  });

  it("parses max-budget-usd", () => {
    const args = parseArgs(["--max-budget-usd", "1.50"]) as Args;
    expect(args.maxBudgetUsd).toBe(1.5);
  });

  it("invalid max-turns returns null", () => {
    const args = parseArgs(["--max-turns", "abc"]) as Args;
    expect(args.maxTurns).toBeNull();
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

  it("passes through --flag=value form", () => {
    const args = parseArgs(["--model=claude-opus-4-7", "hello"]) as Args;
    expect(args.claudeArgs).toEqual(["--model=claude-opus-4-7"]);
    expect(args.prompt).toBe("hello");
  });

  it("collects prompt as remaining positional args", () => {
    const args = parseArgs(["-p", "say", "hello", "world"]) as Args;
    expect(args.prompt).toBe("say hello world");
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
    const reader = new StdinReader(input, { inputFormat: "text", prompt: null }, {
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
    const reader = new StdinReader(input, { inputFormat: "text", prompt: null }, {
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

  it("stream-json mode rejects oversized lines", async () => {
    const input = new PassThrough();
    const events: string[] = [];
    const reader = new StdinReader(input, { inputFormat: "stream-json", prompt: null }, {
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
});
