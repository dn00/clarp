import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";

export type PidFileData = {
  pid: number;
  sessionId: string;
  cwd: string;
  kind: string;
  status?: string;
  waitingFor?: string;
  updatedAt?: number;
};

/**
 * Callback invoked when Claude's PID status file changes status or wait state.
 */
export type PidWatcherCallbacks = {
  onStatusChange: (status: string, waitingFor: string | undefined, data: PidFileData) => void;
  onWarning?: (message: string) => void;
};

function isSafeSessionId(sessionId: string): boolean {
  // Session IDs are used as filenames under ~/.claude/projects.
  return /^[A-Za-z0-9._-]+$/.test(sessionId) && !sessionId.includes("..");
}

// Tolerance below clarp's start time when deciding a session file is fresh
// enough to adopt — small so a prior run's file in the same cwd is excluded,
// but non-zero to absorb filesystem mtime granularity.
const ADOPT_SKEW_MS = 2000;
const ADOPT_ANCESTRY_GRACE_MS = 10_000;

type AncestryMatch = "ours" | "foreign" | "indeterminate";

/**
 * Canonicalizes a cwd for cross-session comparison: resolves it, and on Windows
 * folds separator and case differences (`\` vs `/`, drive-letter casing).
 */
function normalizeCwd(p: string): string {
  let n: string;
  try { n = path.resolve(p); } catch { n = p; }
  if (process.platform === "win32") n = n.replace(/\\/g, "/").toLowerCase();
  return n.replace(/[\\/]+$/, "");
}

function safeMtimeMs(file: string): number {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

/** Existence check that treats a permission error as "alive". */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException)?.code === "EPERM"; }
}

/**
 * Returns the parent pid of `pid`, or null if it can't be determined. Used only
 * to disambiguate concurrent same-cwd sessions, so the subprocess cost is paid
 * only in that rare case. Exported for platform verification in tests.
 */
export function getParentPid(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const cmd = process.platform === "win32"
      ? `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').ParentProcessId"`
      : `ps -o ppid= -p ${pid}`;
    const out = execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
    const value = parseInt(out.trim(), 10);
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Polls Claude Code's per-process session file for status and transcript
 * metadata. Tests can pass a homeDir to isolate filesystem state.
 */
export class PidWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastStatus: string | null = null;
  private lastWaitingFor: string | undefined = undefined;
  private pidFilePath: string;
  private sessionsDir: string;
  private homeDir: string;
  // clarp's working dir and start time, used to discover Claude's real session
  // file when node-pty's reported pid points at a wrapper (Windows claude.cmd
  // or a POSIX version-manager shim) rather than Claude's own process.
  private cwd: string | undefined;
  private startedAt: number;
  // Once a session file is located, we pin it and stat it directly instead of
  // re-scanning the sessions directory on every poll.
  private adoptedPath: string | null = null;
  // Injectable for tests; default to real process probes.
  private isAlive: (pid: number) => boolean;
  private parentPidOf: (pid: number) => number | null;

  constructor(
    private pid: number,
    private callbacks: PidWatcherCallbacks,
    homeDir?: string,
    opts?: {
      cwd?: string;
      startedAt?: number;
      isPidAlive?: (pid: number) => boolean;
      getParentPid?: (pid: number) => number | null;
    },
  ) {
    this.homeDir = homeDir || os.homedir();
    this.sessionsDir = path.join(this.homeDir, ".claude", "sessions");
    this.pidFilePath = path.join(this.sessionsDir, `${pid}.json`);
    this.cwd = opts?.cwd;
    this.startedAt = opts?.startedAt ?? 0;
    this.isAlive = opts?.isPidAlive ?? isPidAlive;
    this.parentPidOf = opts?.getParentPid ?? getParentPid;
  }

  /**
   * Starts polling immediately, then every 500ms.
   */
  start(): void {
    this.poll();
    this.timer = setInterval(() => this.poll(), 500);
  }

  /**
   * Stops any active polling interval.
   */
  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /**
   * Returns the current session ID from the PID file, if it is safe to use as a filename.
   */
  getSessionId(): string | null {
    const sessionId = this.readPidFile()?.sessionId;
    return sessionId && isSafeSessionId(sessionId) ? sessionId : null;
  }

  /**
   * Finds the JSONL transcript path for the current session, if Claude has written one.
   */
  getTranscriptPath(): string | null {
    const data = this.readPidFile();
    if (!data) return null;
    if (!isSafeSessionId(data.sessionId)) return null;
    // Claude encodes the project dir by replacing path separators with "-".
    // Normalize Windows backslashes first so the direct path is tried; the
    // readdir fallback below still covers any encoding we don't reproduce.
    const slug = "-" + data.cwd.replace(/\\/g, "/").replace(/\//g, "-").replace(/^-/, "");
    const projectsDir = path.join(this.homeDir, ".claude", "projects");
    const direct = path.join(projectsDir, slug, `${data.sessionId}.jsonl`);
    if (fs.existsSync(direct)) return direct;
    try {
      for (const dir of fs.readdirSync(projectsDir)) {
        const candidate = path.join(projectsDir, dir, `${data.sessionId}.jsonl`);
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch {}
    return null;
  }

  private poll(): void {
    const data = this.readPidFile();
    if (!data) return;
    const status = data.status || "unknown";
    const waitingFor = data.waitingFor;
    if (status !== this.lastStatus || waitingFor !== this.lastWaitingFor) {
      this.lastStatus = status;
      this.lastWaitingFor = waitingFor;
      this.callbacks.onStatusChange(status, waitingFor, data);
    }
  }

  /**
   * Reads the first system init event from the transcript head.
   */
  readTranscriptInit(): Record<string, unknown> | null {
    const tPath = this.getTranscriptPath();
    if (!tPath) return null;
    let fd: number | null = null;
    try {
      fd = fs.openSync(tPath, "r");
      const buf = Buffer.alloc(64 * 1024);
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
      const chunk = buf.toString("utf8", 0, bytesRead);
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          if (obj.type === "system" && obj.subtype === "init") return obj;
        } catch {}
      }
    } catch {}
    finally {
      if (fd != null) {
        try { fs.closeSync(fd); } catch {}
      }
    }
    return null;
  }

  /**
   * Reads matching system events from the transcript tail.
   */
  readTranscriptEvents(subtype: string, fromEnd = 4096): Record<string, unknown>[] {
    const tPath = this.getTranscriptPath();
    if (!tPath) return [];
    let fd: number | null = null;
    try {
      const stat = fs.statSync(tPath);
      fd = fs.openSync(tPath, "r");
      const readSize = Math.min(fromEnd, stat.size);
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
      const chunk = buf.toString("utf8");
      const results: Record<string, unknown>[] = [];
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          if (obj.type === "system" && obj.subtype === subtype) results.push(obj);
        } catch {}
      }
      return results;
    } catch {}
    finally {
      if (fd != null) {
        try { fs.closeSync(fd); } catch {}
      }
    }
    return [];
  }

  private readPidFile(): PidFileData | null {
    // Without a cwd we can't discover by content, so trust the reported pid
    // directly (unchanged legacy behavior).
    if (this.cwd === undefined) return this.tryReadFile(this.pidFilePath);

    if (!this.adoptedPath) {
      this.adoptedPath = this.discoverSessionFile();
      if (!this.adoptedPath) return null;
    }
    const data = this.tryReadFile(this.adoptedPath);
    if (!data) {
      // The adopted file vanished (rotated/cleaned); re-discover next poll.
      this.adoptedPath = null;
      return null;
    }
    return data;
  }

  /**
   * Locates Claude's real session file. The reported pid is authoritative when
   * its file exists (POSIX, where claude is a node-shebang script). When it
   * doesn't — Claude was launched via claude.cmd on Windows or a version-manager
   * shim, so node-pty reports the wrapper's pid and the real file is keyed on a
   * grandchild pid — find it by matching cwd and recency.
   */
  private discoverSessionFile(): string | null {
    if (fs.existsSync(this.pidFilePath)) return this.pidFilePath;
    if (this.cwd === undefined) return null;

    const targetCwd = normalizeCwd(this.cwd);
    let names: string[];
    try { names = fs.readdirSync(this.sessionsDir); } catch { return null; }

    const candidates: Array<{ file: string; pid: number; when: number }> = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(this.sessionsDir, name);
      const data = this.tryReadFile(file);
      if (!data || typeof data.cwd !== "string") continue;
      if (normalizeCwd(data.cwd) !== targetCwd) continue;
      const when = typeof data.updatedAt === "number" ? data.updatedAt : safeMtimeMs(file);
      // Exclude a prior run's stale file in the same cwd, and any session whose
      // process is already gone (claim a live, current session only).
      if (when < this.startedAt - ADOPT_SKEW_MS) continue;
      if (!this.isAlive(data.pid)) continue;
      candidates.push({ file, pid: data.pid, when });
    }

    if (candidates.length === 0) return null;

    // Same-cwd sessions can appear before our real child writes its file. Always
    // prefer a verified descendant, even when there is only one candidate.
    const classified = candidates.map((c) => ({
      ...c,
      ancestry: this.classifyDescendantOf(c.pid, this.pid),
    }));
    const ours = classified.filter((c) => c.ancestry === "ours");
    if (ours.length > 0) return ours.reduce((a, b) => (b.when > a.when ? b : a)).file;

    if (Date.now() - this.startedAt < ADOPT_ANCESTRY_GRACE_MS) return null;

    if (classified.every((c) => c.ancestry === "foreign")) return null;

    const indeterminate = classified.filter((c) => c.ancestry === "indeterminate");
    if (indeterminate.length === 0) return null;
    this.callbacks.onWarning?.(
      "could not verify Claude session ancestry; adopting newest matching cwd session after grace period",
    );
    return indeterminate.reduce((a, b) => (b.when > a.when ? b : a)).file;
  }

  /** Walks the parent chain from `pid` looking for `ancestor` (bounded depth). */
  private classifyDescendantOf(pid: number, ancestor: number, maxDepth = 6): AncestryMatch {
    let current = pid;
    for (let i = 0; i < maxDepth; i++) {
      if (current === ancestor) return "ours";
      if (current === 1) return "foreign";
      const parent = this.parentPidOf(current);
      if (parent == null || parent <= 0 || parent === current) return "indeterminate";
      current = parent;
    }
    return "foreign";
  }

  private tryReadFile(filePath: string): PidFileData | null {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8")) as PidFileData;
    } catch {
      return null;
    }
  }
}
