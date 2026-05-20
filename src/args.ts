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
  prompt: string | null;
  claudeArgs: string[];
  cwd: string;
};

/**
 * Claude Code flags whose values must stay attached when forwarding unknown
 * options to the interactive `claude` process.
 */
export const VALUE_FLAGS = new Set([
  "--model", "--permission-mode", "--system-prompt", "--append-system-prompt",
  "--allowed-tools", "--disallowed-tools", "--session-id", "--resume",
  "--add-dir", "--mcp-config", "--effort", "--agent", "--agents", "--name",
  "--setting-sources", "--settings", "--fallback-model", "--permission-prompt-tool",
  "--max-thinking-tokens", "--output-style", "--input-format", "--output-format",
  "--include-partial-messages", "--max-turns", "--max-budget-usd",
]);

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
    replayUserMessages: false, maxTurns: null, maxBudgetUsd: null, prompt: null,
    claudeArgs: [], cwd: process.cwd(),
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") { printHelp(); return null; }
    if (arg === "-v" || arg === "--version") { console.log(`clarp ${getPackageVersion()}`); return null; }
    if (arg === "-p" || arg === "--print") { i++; continue; }
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
    if (arg === "--max-turns") { result.maxTurns = parseInt(argv[++i] || "0", 10) || null; i++; continue; }
    if (arg === "--max-budget-usd") { result.maxBudgetUsd = parseFloat(argv[++i] || "0") || null; i++; continue; }
    if (arg.startsWith("-")) {
      result.claudeArgs.push(arg);
      const flagName = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
      if (VALUE_FLAGS.has(flagName) && !arg.includes("=") && i + 1 < argv.length && !argv[i + 1]!.startsWith("-")) {
        result.claudeArgs.push(argv[++i]!);
      }
      i++; continue;
    }
    result.prompt = argv.slice(i).join(" ");
    break;
  }

  if (result.outputFormat === "stream-json") {
    result.verbose = true;
    result.includePartial = true;
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
  echo "prompt" | clarp
  clarp --input-format stream-json --output-format stream-json --verbose

Flags:
  -p, --print                     Print mode (always on)
  --output-format <format>        text (default), json, stream-json
  --input-format <format>         text (default), stream-json
  --verbose                       Include all events (auto with stream-json)
  --include-partial-messages      Include streaming deltas (auto with stream-json)
  --include-hook-events           Include hook lifecycle events
  --replay-user-messages          Echo accepted user messages back on stdout
  --max-turns <n>                 Stop after N turns
  --max-budget-usd <n>            Accepted for compatibility; not enforced

All other flags pass through to claude (interactive):
  --model, --permission-mode, --system-prompt, --append-system-prompt,
  --allowed-tools, --disallowed-tools, --session-id, --continue, --resume,
  --add-dir, --mcp-config, --bare, --effort, --agent, --agents, --name,
  --fallback-model, --permission-prompt-tool, --dangerously-skip-permissions
`);
}
