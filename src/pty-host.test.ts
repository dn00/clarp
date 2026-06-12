import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  normalizePtyKillSignal,
  sendPrompt,
  sendInterrupt,
  sendPermissionAllow,
  sendPermissionDeny,
  sendSlashCommand,
  SUBMIT_KEY_DELAY_MS,
  type PtyHandle,
} from "./pty-host.js";

function mockHandle(): { handle: PtyHandle; writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    handle: {
      write: (data: string) => writes.push(data),
      resize: () => {},
      kill: () => {},
      pid: 1,
    },
  };
}

describe("sendPrompt", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("wraps single-line text in bracketed paste and submits with a delayed Enter", () => {
    const { handle, writes } = mockHandle();
    sendPrompt(handle, "hello world");
    expect(writes).toEqual(["\x1b[200~hello world\x1b[201~"]);
    vi.advanceTimersByTime(SUBMIT_KEY_DELAY_MS);
    expect(writes).toEqual(["\x1b[200~hello world\x1b[201~", "\r"]);
  });

  // Regression: a long single-line prompt written together with its Enter can
  // coalesce into one PTY read; Claude's TUI then treats the chunk as a paste
  // and the \r as a literal newline, leaving the prompt unsent in the
  // composer. Paste-wrapping plus a separate Enter write prevents that.
  it("paste-wraps long single-line prompts so a coalesced read cannot eat the Enter", () => {
    const longText = "x".repeat(189);
    const { handle, writes } = mockHandle();
    sendPrompt(handle, longText, 0);
    expect(writes).toEqual(["\x1b[200~" + longText + "\x1b[201~", "\r"]);
  });

  it("submits immediately when the delay is zero", () => {
    const { handle, writes } = mockHandle();
    sendPrompt(handle, "hello", 0);
    expect(writes).toEqual(["\x1b[200~hello\x1b[201~", "\r"]);
  });

  it("uses bracketed paste mode for multi-line text", () => {
    const { handle, writes } = mockHandle();
    sendPrompt(handle, "line1\nline2", 0);
    expect(writes).toEqual(["\x1b[200~line1\nline2\x1b[201~", "\r"]);
  });

  it("strips bracketed paste delimiters from prompt text", () => {
    const { handle, writes } = mockHandle();
    sendPrompt(handle, "line1\n\x1b[201~escaped\n\x1b[200~line2", 0);
    expect(writes).toEqual(["\x1b[200~line1\nescaped\nline2\x1b[201~", "\r"]);
  });

  it("does not throw when the PTY dies before the delayed Enter fires", () => {
    const writes: string[] = [];
    const handle: PtyHandle = {
      write: (data: string) => {
        if (data === "\r") throw new Error("EIO");
        writes.push(data);
      },
      resize: () => {},
      kill: () => {},
      pid: 1,
    };
    sendPrompt(handle, "hello");
    expect(() => vi.advanceTimersByTime(SUBMIT_KEY_DELAY_MS)).not.toThrow();
  });
});

describe("sendInterrupt", () => {
  it("sends ESC byte", () => {
    const { handle, writes } = mockHandle();
    sendInterrupt(handle);
    expect(writes).toEqual(["\x1b"]);
  });
});

describe("sendPermissionAllow", () => {
  it("sends carriage return", () => {
    const { handle, writes } = mockHandle();
    sendPermissionAllow(handle);
    expect(writes).toEqual(["\r"]);
  });
});

describe("sendPermissionDeny", () => {
  it("sends ESC byte", () => {
    const { handle, writes } = mockHandle();
    sendPermissionDeny(handle);
    expect(writes).toEqual(["\x1b"]);
  });
});

describe("sendSlashCommand", () => {
  it("sends /command with carriage return", () => {
    const { handle, writes } = mockHandle();
    sendSlashCommand(handle, "model claude-sonnet-4-6");
    expect(writes).toEqual(["/model claude-sonnet-4-6\r"]);
  });

  it("handles empty command", () => {
    const { handle, writes } = mockHandle();
    sendSlashCommand(handle, "");
    expect(writes).toEqual(["/\r"]);
  });
});

describe("normalizePtyKillSignal", () => {
  it("drops signal names on Windows", () => {
    expect(normalizePtyKillSignal("SIGTERM", "win32")).toBeUndefined();
  });

  it("preserves signal names on POSIX platforms", () => {
    expect(normalizePtyKillSignal("SIGTERM", "linux")).toBe("SIGTERM");
    expect(normalizePtyKillSignal("SIGTERM", "darwin")).toBe("SIGTERM");
  });

  it("preserves undefined signals", () => {
    expect(normalizePtyKillSignal(undefined, "linux")).toBeUndefined();
  });
});
