import { describe, expect, it } from "vitest";
import { installFatalCleanup } from "./fatal-cleanup.js";

type Listener = (...args: unknown[]) => void;

function makeProcessDouble() {
  const listeners = new Map<string, Listener[]>();
  const stderr: string[] = [];
  const exitCodes: number[] = [];

  const proc = {
    on(event: "uncaughtException" | "unhandledRejection" | "exit", listener: Listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    off(event: "uncaughtException" | "unhandledRejection" | "exit", listener: Listener) {
      listeners.set(event, (listeners.get(event) ?? []).filter((existing) => existing !== listener));
    },
    exit(code?: number): never {
      exitCodes.push(code ?? 0);
      throw new Error(`exit ${code ?? 0}`);
    },
    stderr: {
      write(message: string) {
        stderr.push(message);
      },
    },
  };

  return {
    proc,
    stderr,
    exitCodes,
    emit(event: "uncaughtException" | "unhandledRejection" | "exit", ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
  };
}

describe("installFatalCleanup", () => {
  it("kills the PTY child on uncaught exceptions", () => {
    const kills: string[] = [];
    const fake = makeProcessDouble();

    installFatalCleanup({ kill: (signal?: string) => kills.push(signal ?? "SIGTERM") }, fake.proc);

    expect(() => fake.emit("uncaughtException", new Error("boom"))).toThrow("exit 1");
    expect(kills).toEqual(["SIGTERM"]);
    expect(fake.exitCodes).toEqual([1]);
    expect(fake.stderr[0]).toBe("clarp fatal: boom\n");
  });

  it("kills the PTY child on unhandled rejections", () => {
    const kills: string[] = [];
    const fake = makeProcessDouble();

    installFatalCleanup({ kill: (signal?: string) => kills.push(signal ?? "SIGTERM") }, fake.proc);

    expect(() => fake.emit("unhandledRejection", "rejected")).toThrow("exit 1");
    expect(kills).toEqual(["SIGTERM"]);
    expect(fake.exitCodes).toEqual([1]);
    expect(fake.stderr[0]).toBe("clarp fatal: rejected\n");
  });

  it("kills the PTY child on process exit before the child exits", () => {
    const kills: string[] = [];
    const fake = makeProcessDouble();

    installFatalCleanup({ kill: (signal?: string) => kills.push(signal ?? "SIGTERM") }, fake.proc);

    fake.emit("exit");
    expect(kills).toEqual(["SIGTERM"]);
  });

  it("does not kill the PTY child after the child already exited", () => {
    const kills: string[] = [];
    const fake = makeProcessDouble();
    const cleanup = installFatalCleanup({ kill: (signal?: string) => kills.push(signal ?? "SIGTERM") }, fake.proc);

    cleanup.markChildExited();
    fake.emit("exit");

    expect(kills).toEqual([]);
  });

  it("removes installed handlers", () => {
    const kills: string[] = [];
    const fake = makeProcessDouble();
    const cleanup = installFatalCleanup({ kill: (signal?: string) => kills.push(signal ?? "SIGTERM") }, fake.proc);

    cleanup.remove();
    fake.emit("exit");

    expect(kills).toEqual([]);
  });
});
