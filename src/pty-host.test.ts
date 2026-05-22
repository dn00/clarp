import { describe, it, expect } from "vitest";
import {
  normalizePtyKillSignal,
  sendPrompt,
  sendInterrupt,
  sendPermissionAllow,
  sendPermissionDeny,
  sendSlashCommand,
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
  it("sends single-line text with carriage return", () => {
    const { handle, writes } = mockHandle();
    sendPrompt(handle, "hello world");
    expect(writes).toEqual(["hello world", "\r"]);
  });

  it("uses bracketed paste mode for multi-line text", () => {
    const { handle, writes } = mockHandle();
    sendPrompt(handle, "line1\nline2");
    expect(writes).toEqual(["\x1b[200~line1\nline2\x1b[201~", "\r"]);
  });

  it("detects newlines anywhere in text", () => {
    const { handle, writes } = mockHandle();
    sendPrompt(handle, "a\nb\nc");
    expect(writes[0]).toContain("\x1b[200~");
    expect(writes[0]).toContain("\x1b[201~");
  });

  it("strips bracketed paste delimiters from prompt text", () => {
    const { handle, writes } = mockHandle();
    sendPrompt(handle, "line1\n\x1b[201~escaped\n\x1b[200~line2");
    expect(writes).toEqual(["\x1b[200~line1\nescaped\nline2\x1b[201~", "\r"]);
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
