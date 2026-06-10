import * as nodePty from "node-pty";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";

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
const require = createRequire(import.meta.url);

export function normalizePtyKillSignal(signal: string | undefined, platform = os.platform()): string | undefined {
  // node-pty's Windows backend throws on POSIX signal args; no-arg kill is its force-kill path.
  return platform === "win32" ? undefined : signal;
}

export function getNodePtySpawnHelperPath(
  platform = os.platform(),
  arch = os.arch(),
  nodePtyRoot = path.dirname(require.resolve("node-pty/package.json")),
): string | null {
  if (platform !== "darwin") return null;
  if (arch !== "arm64" && arch !== "x64") return null;
  return path.join(nodePtyRoot, "prebuilds", `darwin-${arch}`, "spawn-helper");
}

export function ensureNodePtySpawnHelperExecutable(helperPath = getNodePtySpawnHelperPath()): void {
  if (helperPath === null) return;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(helperPath);
  } catch {
    return;
  }

  if ((stat.mode & 0o111) !== 0) return;

  try {
    fs.chmodSync(helperPath, stat.mode | 0o755);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `node-pty spawn-helper is not executable and clarp could not repair it: ${helperPath}. ${message}`
    );
  }
}

function findClaude(): string {
  if (os.platform() === "win32") {
    // npm install gives claude.cmd; the native installer ships claude.exe; a
    // bare `claude` covers anything else on PATH.
    for (const name of ["claude.cmd", "claude.exe", "claude"]) {
      try {
        const found = execSync(`where ${name}`, { encoding: "utf8" }).trim().split(/\r?\n/)[0];
        if (found) return found;
      } catch {
        // Not found under this name; try the next.
      }
    }
    throw new Error(
      "claude not found. Install Claude Code first: https://docs.anthropic.com/en/docs/claude-code"
    );
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
  ensureNodePtySpawnHelperExecutable();

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
