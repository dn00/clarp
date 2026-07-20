#!/usr/bin/env node

import { parseArgs } from "./args.js";
import { ProxyBackend } from "./backends/proxy-backend.js";
import {
  createStartupPromptDetector,
  shouldAutoConfirmWorkspaceTrust,
  stripTerminalControls,
} from "./claude-prompts.js";
import { installFatalCleanup, type FatalCleanupHandle } from "./fatal-cleanup.js";
import * as output from "./output.js";
import { spawnClaude, type PtyHandle } from "./pty-host.js";
import { SessionController } from "./session.js";
import { StdinReader } from "./stdin-reader.js";

function isEnvEnabled(name: string): boolean {
  const value = process.env[name]?.toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function debug(msg: string, enabled: boolean): void {
  if (enabled) process.stderr.write(`[clarp] ${msg}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) process.exit(0);

  // No prompt and stdin is a TTY — nothing to do, show help
  if (!args.prompt && !args.readPromptFromStdin && args.inputFormat === "text" && process.stdin.isTTY) {
    parseArgs(["--help"]);
    process.exit(0);
  }

  output.configureOutput({
    format: args.outputFormat,
    verbose: args.verbose,
    includePartial: args.includePartial,
    replayUserMessages: args.replayUserMessages,
  });

  const debugLogs = isEnvEnabled("CLARP_DEBUG");
  const debugPty = isEnvEnabled("CLARP_DEBUG_PTY");
  const log = (msg: string) => debug(msg, debugLogs);
  if (args.maxBudgetUsd != null) {
    process.stderr.write("clarp warning: --max-budget-usd is accepted for compatibility but is not enforced yet.\n");
  }
  const backend = new ProxyBackend(log);
  await backend.prepare();

  const claudeArgs = [...args.claudeArgs];
  if (args.prompt) claudeArgs.push(args.prompt);

  let controller: SessionController | null = null;
  let earlyExitCode: number | null = null;
  let fatalCleanup: FatalCleanupHandle | null = null;
  let trustPromptDetected = false;
  let ptyHandle: PtyHandle | null = null;
  const shouldAutoTrustWorkspace = shouldAutoConfirmWorkspaceTrust(args.claudeArgs);

  log(`Spawning: claude ${claudeArgs.join(" ")}`);
  const detectStartupPrompt = createStartupPromptDetector((prompt) => {
    if (prompt === "bypass") {
      // Default-highlighted option is "No, exit"; pick option "2. Yes, I accept" by number then confirm.
      log("Auto-accepting Claude Bypass Permissions mode warning because --dangerously-skip-permissions was passed.");
      ptyHandle?.write("2\r");
      return;
    }
    trustPromptDetected = true;
    if (shouldAutoTrustWorkspace) {
      log("Auto-confirming Claude workspace trust prompt because --dangerously-skip-permissions was passed.");
      ptyHandle?.write("\r");
      return;
    }
    process.stderr.write(
      `clarp error: Claude Code is asking to trust this workspace (${args.cwd}), but clarp runs Claude in a hidden PTY.\n` +
      "Run `claude` in this directory and choose \"Yes, I trust this folder\", then retry clarp. " +
      "Alternatively, retry with --dangerously-skip-permissions if that is appropriate for this workspace.\n",
    );
    if (controller) {
      controller.shutdown(1).catch((err: Error) => {
        process.stderr.write(`clarp shutdown error: ${err.message}\n`);
        process.exit(1);
      });
    } else {
      ptyHandle?.kill("SIGTERM");
    }
  });
  ptyHandle = spawnClaude(
    claudeArgs,
    backend.getClaudeEnv(),
    args.cwd,
    {
      onData: (data: string) => {
        if (debugPty) {
          const text = stripTerminalControls(data).trim();
          if (text) process.stderr.write(`[clarp] Claude PTY: ${text}\n`);
        }
        detectStartupPrompt(data);
      },
      onExit: (code: number) => {
        fatalCleanup?.markChildExited();
        if (trustPromptDetected && !controller) {
          earlyExitCode = 1;
          return;
        }
        if (controller) {
          controller.handleClaudeExit(code);
        } else {
          earlyExitCode = code;
        }
      },
    },
  );
  log(`PID: ${ptyHandle.pid}`);
  fatalCleanup = installFatalCleanup(ptyHandle);

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
    fatalCleanup.markChildExited();
    if (trustPromptDetected) {
      await controller.shutdown(earlyExitCode);
    } else {
      controller.handleClaudeExit(earlyExitCode);
    }
    return;
  }

  stdinReader.start();
  await controller.start();
}

main().catch((err: Error) => {
  if (err.message.startsWith("error: ")) {
    process.stderr.write(`${err.message}\n`);
  } else {
    process.stderr.write(`clarp fatal: ${err.message}\n`);
  }
  process.exit(1);
});
