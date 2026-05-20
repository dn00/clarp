#!/usr/bin/env node

import { parseArgs } from "./args.js";
import { ProxyBackend } from "./backends/proxy-backend.js";
import * as output from "./output.js";
import { spawnClaude } from "./pty-host.js";
import { SessionController } from "./session.js";
import { StdinReader } from "./stdin-reader.js";

function debug(msg: string, verbose: boolean): void {
  if (verbose) process.stderr.write(`[clarp] ${msg}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) process.exit(0);

  // No prompt and stdin is a TTY — nothing to do, show help
  if (!args.prompt && args.inputFormat === "text" && process.stdin.isTTY) {
    parseArgs(["--help"]);
    process.exit(0);
  }

  output.configureOutput({
    format: args.outputFormat,
    verbose: args.verbose,
    includePartial: args.includePartial,
    replayUserMessages: args.replayUserMessages,
  });

  const log = (msg: string) => debug(msg, args.verbose);
  if (args.maxBudgetUsd != null) {
    process.stderr.write("clarp warning: --max-budget-usd is accepted for compatibility but is not enforced yet.\n");
  }
  const backend = new ProxyBackend(log);
  await backend.prepare();

  const claudeArgs = [...args.claudeArgs];
  if (args.prompt) claudeArgs.push(args.prompt);

  let controller: SessionController | null = null;
  let earlyExitCode: number | null = null;

  log(`Spawning: claude ${claudeArgs.join(" ")}`);
  const ptyHandle = spawnClaude(
    claudeArgs,
    backend.getClaudeEnv(),
    args.cwd,
    {
      onData: (_data: string) => {
        // PTY output — discard in headless mode
      },
      onExit: (code: number) => {
        if (controller) {
          controller.handleClaudeExit(code);
        } else {
          earlyExitCode = code;
        }
      },
    },
  );
  log(`PID: ${ptyHandle.pid}`);

  controller = new SessionController({
    ptyHandle,
    pid: ptyHandle.pid,
    backend,
    args,
    log,
    onExit: (code) => process.exit(code),
  });

  const stdinReader = new StdinReader(process.stdin, args, {
    onUserMessage: (content) => controller!.enqueuePrompt(content),
    onControlRequest: (req, requestId) => controller!.handleControlRequest(req, requestId),
    onControlResponse: (resp, requestId) => controller!.handleControlResponse(resp, requestId),
    onKeepAlive: () => {},
    onEof: () => controller!.handleStdinEof(),
    onMalformedLine: (message) => process.stderr.write(`clarp input error: ${message}\n`),
  }, log);

  process.on("SIGINT", () => {
    controller!.interrupt();
  });
  process.on("SIGTERM", () => {
    if (!controller) {
      process.exit(143);
    }
    controller.shutdown(143).catch((err: Error) => {
      process.stderr.write(`clarp shutdown error: ${err.message}\n`);
      process.exit(1);
    });
  });

  if (earlyExitCode != null) {
    controller.handleClaudeExit(earlyExitCode);
    return;
  }

  stdinReader.start();
  await controller.start();
}

main().catch((err: Error) => {
  process.stderr.write(`clarp fatal: ${err.message}\n`);
  process.exit(1);
});
