import { describe, it, expect } from "vitest";
import { parseStdinLine } from "./stdin-reader.js";

type Captured = { resp: Record<string, unknown>; requestId: string } | null;

function captureControlResponse(line: string): Captured {
  let captured: Captured = null;
  parseStdinLine(line, {
    onUserMessage: () => {},
    onControlRequest: () => {},
    onControlResponse: (resp, requestId) => { captured = { resp, requestId }; },
    onKeepAlive: () => {},
  });
  return captured;
}

describe("parseStdinLine control_response extraction", () => {
  // The SDK nests the behavior payload two levels deep. The modified-input
  // safety check in handleControlResponse only fires if updatedInput survives
  // extraction, so it must reach onControlResponse intact (Codex P1).
  it("preserves updatedInput from the SDK-nested allow shape", () => {
    const line = JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "req-1",
        response: { behavior: "allow", updatedInput: { command: "rm -rf /" }, toolUseID: "toolu_1" },
      },
    });
    const captured = captureControlResponse(line);
    expect(captured).not.toBeNull();
    expect(captured!.requestId).toBe("req-1");
    expect(captured!.resp.behavior).toBe("allow");
    expect(captured!.resp.updatedInput).toEqual({ command: "rm -rf /" });
  });

  it("accepts the flat legacy shape", () => {
    const line = JSON.stringify({
      type: "control_response",
      request_id: "req-2",
      response: { behavior: "allow", updatedInput: { command: "ls" } },
    });
    const captured = captureControlResponse(line);
    expect(captured).not.toBeNull();
    expect(captured!.requestId).toBe("req-2");
    expect(captured!.resp.behavior).toBe("allow");
    expect(captured!.resp.updatedInput).toEqual({ command: "ls" });
  });
});
