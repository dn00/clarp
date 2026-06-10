import type { OutputFormat } from "./output.js";
import * as fs from "node:fs";

const OUTPUT_FORMATS = new Set<OutputFormat>(["text", "json", "stream-json"]);
const INPUT_FORMATS = new Set(["text", "stream-json"]);

export type Args = {
  outputFormat: OutputFormat;
  inputFormat: "text" | "stream-json";
  verbose: boolean;
  includePartial: boolean;
  replayUserMessages: boolean;
  maxTurns: number | null;
  maxBudgetUsd: number | null;
  permissionPromptTool: string | null;
  prompt: string | null;
  readPromptFromStdin: boolean;
  claudeArgs: string[];
  cwd: string;
};

const SCALAR_VALUE_FLAGS = new Set([
  "--model", "--permission-mode", "--system-prompt", "--system-prompt-file",
  "--append-system-prompt", "--append-system-prompt-file",
  "--session-id", "--effort", "--agent", "--agents", "--name", "-n",
  "--setting-sources", "--settings", "--fallback-model",
  "--max-thinking-tokens", "--output-style", "--debug-file", "--json-schema",
  "--remote-control-session-name-prefix", "--plugin-dir", "--plugin-url",
  "--thinking", "--task-budget", "--prefill", "--deep-link-repo",
  "--deep-link-last-fetch", "--resume-session-at", "--rewind-files",
  "--workload", "--advisor", "--messaging-socket-path", "--agent-id",
  "--agent-name", "--team-name", "--agent-color", "--parent-session-id",
  "--teammate-mode", "--agent-type", "--sdk-url",
]);

const OPTIONAL_VALUE_FLAGS = new Set([
  "--resume", "-r", "--debug", "-d", "--from-pr", "--remote-control", "--rc",
  "--worktree", "-w", "--teleport", "--remote", "--tasks",
]);

const VARIADIC_VALUE_FLAGS = new Set([
  "--add-dir", "--mcp-config", "--betas", "--file", "--tools",
  "--allowed-tools", "--allowedTools", "--disallowed-tools", "--disallowedTools",
  "--channels", "--dangerously-load-development-channels",
]);

const BOOLEAN_FLAGS = new Set([
  "--bare", "--continue", "-c", "--allow-dangerously-skip-permissions",
  "--dangerously-skip-permissions", "--strict-mcp-config", "--fork-session",
  "--no-session-persistence", "--disable-slash-commands", "--mcp-debug",
  "--ide", "--chrome", "--no-chrome", "--brief", "--tmux", "-d2e",
  "--debug-to-stderr", "--init", "--init-only", "--maintenance",
  "--enable-auth-status", "--deep-link-origin", "--plan-mode-required",
  "--delegate-permissions", "--dangerously-skip-permissions-with-classifiers",
  "--afk", "--agent-teams", "--enable-auto-mode", "--proactive",
  "--assistant", "--hard-fail",
]);

export const VALUE_FLAGS = new Set([
  ...SCALAR_VALUE_FLAGS,
  ...OPTIONAL_VALUE_FLAGS,
  ...VARIADIC_VALUE_FLAGS,
]);

const KNOWN_CLAUDE_FLAGS = new Set([
  ...VALUE_FLAGS,
  ...BOOLEAN_FLAGS,
]);

const VALUE_LABELS = new Map([
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
  ["--add-dir", "directories..."],
  ["--mcp-config", "configs..."],
  ["--betas", "betas..."],
  ["--file", "specs..."],
  ["--tools", "tools..."],
  ["--allowedTools", "tools..."],
  ["--allowed-tools", "tools..."],
  ["--disallowedTools", "tools..."],
  ["--disallowed-tools", "tools..."],
]);

function throwMissingValue(flagName: string): never {
  if (flagName === "--allowedTools" || flagName === "--allowed-tools") {
    throw new Error("error: option '--allowedTools, --allowed-tools <tools...>' argument missing");
  }
  if (flagName === "--disallowedTools" || flagName === "--disallowed-tools") {
    throw new Error("error: option '--disallowedTools, --disallowed-tools <tools...>' argument missing");
  }
  const label = VALUE_LABELS.get(flagName) ?? "value";
  throw new Error(`error: option '${flagName} <${label}>' argument missing`);
}

function throwUnknownOption(arg: string): never {
  throw new Error(`error: unknown option '${arg}'`);
}

function consumeValueArgs(argv: string[], i: number, flagName: string, result: Args): number {
  if (argHasValue(argv[i]!)) return i;
  const start = i;
  if (VARIADIC_VALUE_FLAGS.has(flagName)) {
    while (i + 1 < argv.length && !argv[i + 1]!.startsWith("-")) {
      result.claudeArgs.push(argv[++i]!);
    }
    if (i === start) throwMissingValue(flagName);
    return i;
  }
  if (SCALAR_VALUE_FLAGS.has(flagName)) {
    if (i + 1 >= argv.length || argv[i + 1]!.startsWith("-")) throwMissingValue(flagName);
    result.claudeArgs.push(argv[++i]!);
    return i;
  }
  if (OPTIONAL_VALUE_FLAGS.has(flagName) && i + 1 < argv.length && !argv[i + 1]!.startsWith("-")) {
    result.claudeArgs.push(argv[++i]!);
  }
  return i;
}

function argHasValue(arg: string): boolean {
  return arg.includes("=");
}

function parsePositiveIntegerFlag(flag: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${flag}: ${value || "(missing)"}`);
  }
  return parsed;
}

function parsePositiveNumberFlag(flag: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${flag}: ${value || "(missing)"}`);
  }
  return parsed;
}

function getPackageVersion(): string {
  try {
    const packageJsonUrl = new URL("../package.json", import.meta.url);
    const packageJson = JSON.parse(fs.readFileSync(packageJsonUrl, "utf8")) as { version?: string };
    return packageJson.version || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Parses clarp-compatible CLI flags and preserves unknown Claude flags for
 * pass-through. Returns null after printing help/version output.
 */
export function parseArgs(argv: string[]): Args | null {
  const result: Args = {
    outputFormat: "text", inputFormat: "text", verbose: false, includePartial: false,
    replayUserMessages: false, maxTurns: null, maxBudgetUsd: null,
    permissionPromptTool: null, prompt: null,
    readPromptFromStdin: false,
    claudeArgs: [], cwd: process.cwd(),
  };

  let i = 0;
  let prompt: string | null = null;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") { printHelp(); return null; }
    if (arg === "-v" || arg === "--version") { console.log(`clarp ${getPackageVersion()}`); return null; }
    if (arg === "-p" || arg === "--print") { i++; continue; }
    if (arg === "-") {
      if (prompt == null) result.readPromptFromStdin = true;
      i++; continue;
    }
    if (arg.startsWith("--output-format=")) {
      const value = arg.slice("--output-format=".length);
      if (!OUTPUT_FORMATS.has(value as OutputFormat)) throw new Error(`Invalid --output-format: ${value || "(missing)"}`);
      result.outputFormat = value as OutputFormat;
      i++; continue;
    }
    if (arg === "--output-format") {
      const value = argv[++i] || "";
      if (!OUTPUT_FORMATS.has(value as OutputFormat)) throw new Error(`Invalid --output-format: ${value || "(missing)"}`);
      result.outputFormat = value as OutputFormat;
      i++; continue;
    }
    if (arg.startsWith("--input-format=")) {
      const value = arg.slice("--input-format=".length);
      if (!INPUT_FORMATS.has(value)) throw new Error(`Invalid --input-format: ${value || "(missing)"}`);
      result.inputFormat = value as "text" | "stream-json";
      i++; continue;
    }
    if (arg === "--input-format") {
      const value = argv[++i] || "";
      if (!INPUT_FORMATS.has(value)) throw new Error(`Invalid --input-format: ${value || "(missing)"}`);
      result.inputFormat = value as "text" | "stream-json";
      i++; continue;
    }
    if (arg === "--verbose") { result.verbose = true; i++; continue; }
    if (arg === "--include-partial-messages") { result.includePartial = true; i++; continue; }
    if (arg === "--include-hook-events") { i++; continue; }
    if (arg === "--replay-user-messages") { result.replayUserMessages = true; i++; continue; }
    if (arg.startsWith("--max-turns=")) {
      result.maxTurns = parsePositiveIntegerFlag("--max-turns", arg.slice("--max-turns=".length));
      i++; continue;
    }
    if (arg === "--max-turns") {
      result.maxTurns = parsePositiveIntegerFlag("--max-turns", argv[++i] || "");
      i++; continue;
    }
    // Intercepted, never passed through: the interactive TUI cannot honor a
    // print-mode permission protocol flag, and passing it corrupts the TUI's
    // permission behavior. clarp implements the stdio protocol itself.
    if (arg.startsWith("--permission-prompt-tool=")) {
      const value = arg.slice("--permission-prompt-tool=".length);
      if (!value) throw new Error("error: option '--permission-prompt-tool <tool>' argument missing");
      result.permissionPromptTool = value;
      i++; continue;
    }
    if (arg === "--permission-prompt-tool") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) throw new Error("error: option '--permission-prompt-tool <tool>' argument missing");
      result.permissionPromptTool = value;
      i += 2; continue;
    }
    if (arg.startsWith("--max-budget-usd=")) {
      result.maxBudgetUsd = parsePositiveNumberFlag("--max-budget-usd", arg.slice("--max-budget-usd=".length));
      i++; continue;
    }
    if (arg === "--max-budget-usd") {
      result.maxBudgetUsd = parsePositiveNumberFlag("--max-budget-usd", argv[++i] || "");
      i++; continue;
    }
    if (arg === "--") {
      prompt = argv[i + 1] ?? null;
      break;
    }
    if (arg.startsWith("-")) {
      const flagName = argHasValue(arg) ? arg.slice(0, arg.indexOf("=")) : arg;
      if (!KNOWN_CLAUDE_FLAGS.has(flagName)) throwUnknownOption(arg);
      if (BOOLEAN_FLAGS.has(flagName) && argHasValue(arg)) throwUnknownOption(arg);
      result.claudeArgs.push(arg);
      if (VALUE_FLAGS.has(flagName)) i = consumeValueArgs(argv, i, flagName, result);
      i++; continue;
    }
    if (prompt == null) prompt = arg;
    i++;
  }

  result.prompt = prompt;
  if (result.outputFormat === "stream-json") {
    result.verbose = true;
  }
  return result;
}

/**
 * Prints the public command-line help text.
 */
export function printHelp(): void {
  process.stderr.write(`clarp — Drop-in replacement for claude -p

Usage:
  clarp [options] [prompt]
  clarp -p - < prompt.txt
  echo "prompt" | clarp
  clarp --input-format stream-json --output-format stream-json --verbose

Flags:
  -p, --print                     Print mode (always on)
  --output-format <format>        text (default), json, stream-json
  --input-format <format>         text (default), stream-json
  --verbose                       Include all events (auto with stream-json)
  --include-partial-messages      Include streaming deltas
  --include-hook-events           Include hook lifecycle events
  --replay-user-messages          Echo accepted user messages back on stdout
  --max-turns <n>                 Stop after N turns
  --max-budget-usd <n>            Accepted for compatibility; not enforced
  --permission-prompt-tool stdio  Forward permission prompts as can_use_tool
                                  control requests (stream-json input only)

All other flags pass through to claude (interactive):
  --model, --permission-mode, --system-prompt, --append-system-prompt,
  --allowedTools/--allowed-tools, --disallowedTools/--disallowed-tools, --tools,
  --add-dir, --mcp-config, --settings, --json-schema, --debug, --debug-file,
  --plugin-dir, --plugin-url, --session-id, --continue, --resume,
  --bare, --effort, --agent, --agents, --name, --worktree,
  --fallback-model, --dangerously-skip-permissions
`);
}
