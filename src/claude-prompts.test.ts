import { describe, expect, it, vi } from "vitest";
import {
  createWorkspaceTrustPromptDetector,
  isWorkspaceTrustPrompt,
  stripTerminalControls,
} from "./claude-prompts.js";

const TRUST_PROMPT = `
Accessing workspace:

 /Users/dn

 Quick safety check: Is this a project you created or one you trust?

 Claude Code'll be able to read, edit, and execute files here.

 ❯ 1. Yes, I trust this folder
   2. No, exit

 Enter to confirm · Esc to cancel
`;

describe("Claude prompt detection", () => {
  it("strips terminal controls", () => {
    expect(stripTerminalControls("\x1b[32mhello\x1b[0m\rworld")).toBe("hello\nworld");
  });

  it("detects the workspace trust prompt", () => {
    expect(isWorkspaceTrustPrompt(TRUST_PROMPT)).toBe(true);
  });

  it("detects compact terminal-rendered trust prompt text", () => {
    expect(isWorkspaceTrustPrompt(`
      Accessingworkspace:
      /Users/dn
      Quicksafetycheck:Isthisaprojectyoucreatedoroneyoutrust?
      ❯1.Yes,Itrustthisfolder
      2.No,exit
      Entertoconfirm·Esctocancel
    `)).toBe(true);
  });

  it("does not detect unrelated Claude output", () => {
    expect(isWorkspaceTrustPrompt("Hi! What can I help you with?")).toBe(false);
  });

  it("detects prompts split across PTY chunks only once", () => {
    const onDetected = vi.fn();
    const detector = createWorkspaceTrustPromptDetector(onDetected);

    detector(TRUST_PROMPT.slice(0, 120));
    expect(onDetected).not.toHaveBeenCalled();

    detector(TRUST_PROMPT.slice(120));
    detector(TRUST_PROMPT);

    expect(onDetected).toHaveBeenCalledTimes(1);
  });
});
