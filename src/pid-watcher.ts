import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

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
};

function isSafeSessionId(sessionId: string): boolean {
  // Session IDs are used as filenames under ~/.claude/projects.
  return /^[A-Za-z0-9._-]+$/.test(sessionId) && !sessionId.includes("..");
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
  private homeDir: string;

  constructor(private pid: number, private callbacks: PidWatcherCallbacks, homeDir?: string) {
    this.homeDir = homeDir || os.homedir();
    const sessionsDir = path.join(this.homeDir, ".claude", "sessions");
    this.pidFilePath = path.join(sessionsDir, `${pid}.json`);
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
    const slug = "-" + data.cwd.replace(/\//g, "-").replace(/^-/, "");
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
    try {
      return JSON.parse(fs.readFileSync(this.pidFilePath, "utf8")) as PidFileData;
    } catch {
      return null;
    }
  }
}
