import * as nodePty from "node-pty";
import * as os from "node:os";
import { execSync } from "node:child_process";

export type PtyCallbacks = {
  onData: (data: string) => void;
  onExit: (code: number, signal?: number) => void;
};

/**
 * Minimal handle used by higher-level session code so tests do not depend on
 * node-pty internals.
 */
export type PtyHandle = {
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: (signal?: string) => void;
  pid: number;
};

const BRACKETED_PASTE_OPEN = "\x1b[200~";
const BRACKETED_PASTE_CLOSE = "\x1b[201~";

export function normalizePtyKillSignal(signal: string | undefined, platform = os.platform()): string | undefined {
  // node-pty's Windows backend throws on POSIX signal args; no-arg kill is its force-kill path.
  return platform === "win32" ? undefined : signal;
}

function findClaude(): string {
  if (os.platform() === "win32") {
    try {
      return execSync("where claude.cmd", { encoding: "utf8" }).trim().split("\n")[0]!;
    } catch {
      throw new Error(
        "claude not found. Install Claude Code first: https://docs.anthropic.com/en/docs/claude-code"
      );
    }
  }
  try {
    return execSync("which claude", { encoding: "utf8" }).trim();
  } catch {
    throw new Error(
      "claude not found in PATH. Install Claude Code first: https://docs.anthropic.com/en/docs/claude-code"
    );
  }
}

/**
 * Starts Claude Code in an interactive PTY with extra environment variables,
 * usually pointing Claude at clarp's local proxy.
 */
export function spawnClaude(
  args: string[],
  env: Record<string, string>,
  cwd: string,
  callbacks: PtyCallbacks,
): PtyHandle {
  const claudePath = findClaude();
  const mergedEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) mergedEnv[k] = v;
  }
  Object.assign(mergedEnv, env);

  const proc = nodePty.spawn(claudePath, args, {
    name: "xterm-256color",
    cols: 120,
    rows: 24,
    cwd,
    env: mergedEnv,
  });

  proc.onData((data: string) => callbacks.onData(data));
  proc.onExit(({ exitCode, signal }) => callbacks.onExit(exitCode, signal));

  return {
    write: (data: string) => proc.write(data),
    resize: (cols: number, rows: number) => proc.resize(cols, rows),
    kill: (signal?: string) => proc.kill(normalizePtyKillSignal(signal)),
    pid: proc.pid,
  };
}

function sanitizePromptText(text: string): string {
  // Prevent prompt text from closing or reopening our bracketed-paste wrapper.
  return text
    .replaceAll(BRACKETED_PASTE_OPEN, "")
    .replaceAll(BRACKETED_PASTE_CLOSE, "");
}

/**
 * Writes a prompt into Claude's TUI and submits it. Multi-line prompts use
 * bracketed paste so terminal editors do not reinterpret line breaks.
 */
export function sendPrompt(handle: PtyHandle, text: string): void {
  const safeText = sanitizePromptText(text);
  if (safeText.includes("\n")) {
    handle.write(BRACKETED_PASTE_OPEN + safeText + BRACKETED_PASTE_CLOSE);
  } else {
    handle.write(safeText);
  }
  handle.write("\r");
}

/**
 * Sends an ESC keypress, which Claude Code treats as an interrupt/stop action.
 */
export function sendInterrupt(handle: PtyHandle): void {
  handle.write("\x1b");
}

/**
 * Approves the currently focused Claude permission prompt.
 */
export function sendPermissionAllow(handle: PtyHandle): void {
  handle.write("\r");
}

/**
 * Denies the currently focused Claude permission prompt.
 */
export function sendPermissionDeny(handle: PtyHandle): void {
  handle.write("\x1b");
}

/**
 * Sends a slash command such as `/model ...` to the interactive Claude process.
 */
export function sendSlashCommand(handle: PtyHandle, command: string): void {
  handle.write("/" + command + "\r");
}
