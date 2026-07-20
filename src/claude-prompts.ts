const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[PX^_].*?\x1b\\|[@-_])/g;

export function stripTerminalControls(text: string): string {
  return text.replace(ANSI_PATTERN, "").replace(/\r/g, "\n");
}

export function isWorkspaceTrustPrompt(text: string): boolean {
  const compact = stripTerminalControls(text).toLowerCase().replace(/[^a-z0-9]/g, "");
  return compact.includes("quicksafetycheck")
    && compact.includes("yesitrustthisfolder")
    && compact.includes("noexit");
}

/** Second startup dialog (only with --dangerously-skip-permissions); its default option is "No, exit", so a bare Enter quits. */
export function isBypassPermissionsPrompt(text: string): boolean {
  const compact = stripTerminalControls(text).toLowerCase().replace(/[^a-z0-9]/g, "");
  return compact.includes("bypasspermissionsmode")
    && compact.includes("yesiaccept")
    && compact.includes("noexit");
}

export function shouldAutoConfirmWorkspaceTrust(claudeArgs: string[]): boolean {
  return claudeArgs.includes("--dangerously-skip-permissions");
}

export type StartupPrompt = "trust" | "bypass";

/** Reports each first-run startup dialog (workspace trust, then bypass-permissions warning) at most once. */
export function createStartupPromptDetector(
  onDetected: (prompt: StartupPrompt) => void,
): (data: string) => void {
  let buffer = "";
  const fired = new Set<StartupPrompt>();

  return (data: string) => {
    buffer = (buffer + data).slice(-16_000);
    if (!fired.has("trust") && isWorkspaceTrustPrompt(buffer)) {
      fired.add("trust");
      onDetected("trust");
    }
    if (!fired.has("bypass") && isBypassPermissionsPrompt(buffer)) {
      fired.add("bypass");
      onDetected("bypass");
    }
  };
}
