import { describe, expect, it, vi } from "vitest";
import {
  createStartupPromptDetector,
  isBypassPermissionsPrompt,
  isWorkspaceTrustPrompt,
  shouldAutoConfirmWorkspaceTrust,
  stripTerminalControls,
} from "./claude-prompts.js";

const TRUST_PROMPT = `
Accessing workspace:

 ~

 Quick safety check: Is this a project you created or one you trust?

 Claude Code'll be able to read, edit, and execute files here.

 ❯ 1. Yes, I trust this folder
   2. No, exit

 Enter to confirm · Esc to cancel
`;

const BYPASS_PROMPT = `
 WARNING: Claude Code running in Bypass Permissions mode

 In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous commands.

 By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode.

 ❯ 1. No, exit
   2. Yes, I accept

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
      ~
      Quicksafetycheck:Isthisaprojectyoucreatedoroneyoutrust?
      ❯1.Yes,Itrustthisfolder
      2.No,exit
      Entertoconfirm·Esctocancel
    `)).toBe(true);
  });

  it("does not detect unrelated Claude output", () => {
    expect(isWorkspaceTrustPrompt("Hi! What can I help you with?")).toBe(false);
  });

  it("detects the bypass-permissions warning prompt", () => {
    expect(isBypassPermissionsPrompt(BYPASS_PROMPT)).toBe(true);
    expect(isBypassPermissionsPrompt(TRUST_PROMPT)).toBe(false);
    expect(isBypassPermissionsPrompt("Hi! What can I help you with?")).toBe(false);
  });

  it("auto-confirms workspace trust only for explicit permission bypass", () => {
    expect(shouldAutoConfirmWorkspaceTrust(["--dangerously-skip-permissions"])).toBe(true);
    expect(shouldAutoConfirmWorkspaceTrust(["--permission-mode", "bypassPermissions"])).toBe(false);
    expect(shouldAutoConfirmWorkspaceTrust(["hello"])).toBe(false);
  });

  it("detects prompts split across PTY chunks only once", () => {
    const onDetected = vi.fn();
    const detector = createStartupPromptDetector(onDetected);

    detector(TRUST_PROMPT.slice(0, 120));
    expect(onDetected).not.toHaveBeenCalled();

    detector(TRUST_PROMPT.slice(120));
    detector(TRUST_PROMPT);

    expect(onDetected).toHaveBeenCalledTimes(1);
    expect(onDetected).toHaveBeenCalledWith("trust");
  });

  it("reports trust then bypass, each once, as the dialogs stream in", () => {
    const onDetected = vi.fn();
    const detector = createStartupPromptDetector(onDetected);

    detector(TRUST_PROMPT);
    detector(BYPASS_PROMPT);
    detector(BYPASS_PROMPT);

    expect(onDetected).toHaveBeenNthCalledWith(1, "trust");
    expect(onDetected).toHaveBeenNthCalledWith(2, "bypass");
    expect(onDetected).toHaveBeenCalledTimes(2);
  });
});
