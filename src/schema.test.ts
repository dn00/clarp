/**
 * Schema tests for every SDKMessage type in the claude -p protocol.
 * Uses synthetic fixtures built from coreSchemas.ts Zod definitions.
 * Validates required fields exist and have correct types.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const lines: any[] = fs.readFileSync(
  path.join(import.meta.dirname, "__fixtures__", "claude-p-all-types.jsonl"),
  "utf8",
).trim().split("\n").map(l => JSON.parse(l));

function find(type: string, subtype?: string) {
  return lines.filter(l => l.type === type && (subtype === undefined || l.subtype === subtype));
}

describe("system.session_state_changed", () => {
  const events = find("system", "session_state_changed");
  it("has all three states", () => {
    const states = events.map(e => e.state);
    expect(states).toContain("idle");
    expect(states).toContain("running");
    expect(states).toContain("requires_action");
  });
  it("has uuid and session_id", () => {
    for (const e of events) {
      expect(typeof e.uuid).toBe("string");
      expect(typeof e.session_id).toBe("string");
    }
  });
});

describe("system.post_turn_summary", () => {
  const events = find("system", "post_turn_summary");
  it("exists", () => { expect(events.length).toBeGreaterThan(0); });
  it("has required fields", () => {
    const e = events[0]!;
    expect(typeof e.summarizes_uuid).toBe("string");
    expect(["blocked", "waiting", "completed", "review_ready", "failed"]).toContain(e.status_category);
    expect(typeof e.status_detail).toBe("string");
    expect(typeof e.is_noteworthy).toBe("boolean");
    expect(typeof e.title).toBe("string");
    expect(typeof e.description).toBe("string");
    expect(typeof e.recent_action).toBe("string");
    expect(typeof e.needs_action).toBe("string");
    expect(Array.isArray(e.artifact_urls)).toBe(true);
  });
  it("has blocked status variant", () => {
    const blocked = events.find(e => e.status_category === "blocked");
    expect(blocked).toBeDefined();
    expect(blocked.needs_action.length).toBeGreaterThan(0);
  });
});

describe("system.task_started", () => {
  const events = find("system", "task_started");
  it("has required fields", () => {
    const e = events[0]!;
    expect(typeof e.task_id).toBe("string");
    expect(typeof e.description).toBe("string");
    expect(e).toHaveProperty("uuid");
    expect(e).toHaveProperty("session_id");
  });
  it("has optional task_type", () => {
    expect(events[0]).toHaveProperty("task_type");
  });
});

describe("system.task_progress", () => {
  const events = find("system", "task_progress");
  it("has required fields", () => {
    const e = events[0]!;
    expect(typeof e.task_id).toBe("string");
    expect(typeof e.description).toBe("string");
    expect(typeof e.usage.total_tokens).toBe("number");
    expect(typeof e.usage.tool_uses).toBe("number");
    expect(typeof e.usage.duration_ms).toBe("number");
  });
  it("has optional summary and last_tool_name", () => {
    const e = events[0]!;
    expect(typeof e.summary).toBe("string");
    expect(typeof e.last_tool_name).toBe("string");
  });
});

describe("system.task_notification", () => {
  const events = find("system", "task_notification");
  it("has both completed and failed", () => {
    expect(events.some(e => e.status === "completed")).toBe(true);
    expect(events.some(e => e.status === "failed")).toBe(true);
  });
  it("has required fields", () => {
    const e = events[0]!;
    expect(typeof e.task_id).toBe("string");
    expect(["completed", "failed", "stopped"]).toContain(e.status);
    expect(typeof e.output_file).toBe("string");
    expect(typeof e.summary).toBe("string");
  });
  it("completed has usage", () => {
    const completed = events.find(e => e.status === "completed")!;
    expect(completed.usage).toBeDefined();
    expect(typeof completed.usage.total_tokens).toBe("number");
  });
});

describe("system.compact_boundary", () => {
  const events = find("system", "compact_boundary");
  it("has compact_metadata", () => {
    const e = events[0]!;
    expect(["manual", "auto"]).toContain(e.compact_metadata.trigger);
    expect(typeof e.compact_metadata.pre_tokens).toBe("number");
  });
});

describe("system.files_persisted", () => {
  const events = find("system", "files_persisted");
  it("has files array", () => {
    const e = events[0]!;
    expect(Array.isArray(e.files)).toBe(true);
    expect(e.files[0]).toHaveProperty("filename");
    expect(e.files[0]).toHaveProperty("file_id");
  });
  it("has failed array", () => {
    expect(Array.isArray(events[0]!.failed)).toBe(true);
  });
});

describe("system.api_retry", () => {
  const events = find("system", "api_retry");
  it("has required fields", () => {
    const e = events[0]!;
    expect(typeof e.attempt).toBe("number");
    expect(typeof e.max_retries).toBe("number");
    expect(typeof e.retry_delay_ms).toBe("number");
    expect(e).toHaveProperty("error_status");
    expect(e).toHaveProperty("error");
  });
  it("error_status is nullable (null for connection errors)", () => {
    const connErr = events.find(e => e.error_status === null);
    expect(connErr).toBeDefined();
  });
});

describe("system.elicitation_complete", () => {
  const events = find("system", "elicitation_complete");
  it("has required fields", () => {
    const e = events[0]!;
    expect(typeof e.mcp_server_name).toBe("string");
    expect(typeof e.elicitation_id).toBe("string");
  });
});

describe("auth_status", () => {
  const events = find("auth_status");
  it("has both authenticating states", () => {
    expect(events.some(e => e.isAuthenticating === true)).toBe(true);
    expect(events.some(e => e.isAuthenticating === false)).toBe(true);
  });
  it("has output array", () => {
    expect(Array.isArray(events[0]!.output)).toBe(true);
  });
});

describe("tool_progress", () => {
  const events = find("tool_progress");
  it("has required fields", () => {
    const e = events[0]!;
    expect(typeof e.tool_use_id).toBe("string");
    expect(typeof e.tool_name).toBe("string");
    expect(typeof e.elapsed_time_seconds).toBe("number");
  });
  it("supports parent_tool_use_id for nested tools", () => {
    const nested = events.find(e => e.parent_tool_use_id !== null);
    expect(nested).toBeDefined();
    expect(nested.task_id).toBeDefined();
  });
});

describe("tool_use_summary", () => {
  const events = find("tool_use_summary");
  it("has required fields", () => {
    const e = events[0]!;
    expect(typeof e.summary).toBe("string");
    expect(Array.isArray(e.preceding_tool_use_ids)).toBe(true);
    expect(e.preceding_tool_use_ids.length).toBeGreaterThan(0);
  });
});

describe("prompt_suggestion", () => {
  const events = find("prompt_suggestion");
  it("has suggestion string", () => {
    const e = events[0]!;
    expect(typeof e.suggestion).toBe("string");
    expect(e.suggestion.length).toBeGreaterThan(0);
  });
});

describe("all events have uuid and session_id", () => {
  it("every event has session_id", () => {
    for (const l of lines) {
      expect(l).toHaveProperty("session_id");
    }
  });
  it("every event has uuid (except compact_boundary)", () => {
    for (const l of lines) {
      if (l.subtype !== "compact_boundary") {
        expect(l).toHaveProperty("uuid");
      }
    }
  });
});
