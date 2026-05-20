import { describe, expect, it } from "vitest";
import { ProxyBackend } from "./proxy-backend.js";

describe("ProxyBackend", () => {
  it("throws if getClaudeEnv is called before prepare", () => {
    const backend = new ProxyBackend();
    expect(() => backend.getClaudeEnv()).toThrow(/before prepare/);
  });

  it("allows only one observation subscriber", () => {
    const backend = new ProxyBackend();
    backend.onObservation(() => {});
    expect(() => backend.onObservation(() => {})).toThrow(/one observation subscriber/);
  });
});
