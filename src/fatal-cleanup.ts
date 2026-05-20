import type { PtyHandle } from "./pty-host.js";

type FatalCleanupProcess = {
  on: (event: "uncaughtException" | "unhandledRejection" | "exit", listener: (...args: unknown[]) => void) => unknown;
  off?: (event: "uncaughtException" | "unhandledRejection" | "exit", listener: (...args: unknown[]) => void) => unknown;
  exit: (code?: number) => never;
  stderr: { write: (message: string) => unknown };
};

export type FatalCleanupHandle = {
  killChild: () => void;
  markChildExited: () => void;
  remove: () => void;
};

function formatReason(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return String(reason);
}

export function installFatalCleanup(
  ptyHandle: Pick<PtyHandle, "kill">,
  proc: FatalCleanupProcess = process,
): FatalCleanupHandle {
  let childExited = false;

  const killChild = () => {
    if (childExited) return;
    try {
      ptyHandle.kill("SIGTERM");
    } catch {
    }
  };

  const onUncaughtException = (err: unknown) => {
    proc.stderr.write(`clarp fatal: ${formatReason(err)}\n`);
    killChild();
    proc.exit(1);
  };

  const onUnhandledRejection = (reason: unknown) => {
    proc.stderr.write(`clarp fatal: ${formatReason(reason)}\n`);
    killChild();
    proc.exit(1);
  };

  const onExit = () => {
    killChild();
  };

  proc.on("uncaughtException", onUncaughtException);
  proc.on("unhandledRejection", onUnhandledRejection);
  proc.on("exit", onExit);

  return {
    killChild,
    markChildExited: () => {
      childExited = true;
    },
    remove: () => {
      proc.off?.("uncaughtException", onUncaughtException);
      proc.off?.("unhandledRejection", onUnhandledRejection);
      proc.off?.("exit", onExit);
    },
  };
}
