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

export function createWorkspaceTrustPromptDetector(onDetected: () => void): (data: string) => void {
  let buffer = "";
  let detected = false;

  return (data: string) => {
    if (detected) return;
    buffer = (buffer + data).slice(-16_000);
    if (isWorkspaceTrustPrompt(buffer)) {
      detected = true;
      onDetected();
    }
  };
}
