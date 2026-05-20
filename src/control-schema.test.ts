/**
 * Schema tests for all control_request and control_response types.
 * Built from controlSchemas.ts — 21 request subtypes + responses.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const lines: any[] = fs.readFileSync(
  path.join(import.meta.dirname, "__fixtures__", "claude-p-control-requests-all.jsonl"),
  "utf8",
).trim().split("\n").map(l => JSON.parse(l));

const requests = lines.filter(l => l.type === "control_request");
const responses = lines.filter(l => l.type === "control_response");
const cancels = lines.filter(l => l.type === "control_cancel_request");

function findRequest(subtype: string) {
  return requests.find(r => r.request.subtype === subtype);
}

describe("control_request common fields", () => {
  it("all have request_id and request.subtype", () => {
    for (const r of requests) {
      expect(typeof r.request_id).toBe("string");
      expect(typeof r.request.subtype).toBe("string");
    }
  });

  it("covers all 21 subtypes", () => {
    const subtypes = new Set(requests.map(r => r.request.subtype));
    const expected = [
      "interrupt", "can_use_tool", "initialize", "set_permission_mode",
      "set_model", "set_max_thinking_tokens", "mcp_status", "get_context_usage",
      "hook_callback", "mcp_message", "rewind_files", "cancel_async_message",
      "seed_read_state", "mcp_set_servers", "reload_plugins", "mcp_reconnect",
      "mcp_toggle", "stop_task", "apply_flag_settings", "get_settings",
      "elicitation",
    ];
    for (const e of expected) {
      expect(subtypes.has(e)).toBe(true);
    }
  });
});

describe("interrupt", () => {
  it("has no extra fields", () => {
    const r = findRequest("interrupt")!;
    expect(Object.keys(r.request)).toEqual(["subtype"]);
  });
});

describe("can_use_tool", () => {
  const r = findRequest("can_use_tool")!;
  it("has tool_name, input, tool_use_id", () => {
    expect(typeof r.request.tool_name).toBe("string");
    expect(typeof r.request.input).toBe("object");
    expect(typeof r.request.tool_use_id).toBe("string");
  });
  it("has optional description, title, display_name", () => {
    expect(r.request).toHaveProperty("description");
    expect(r.request).toHaveProperty("title");
  });
});

describe("initialize", () => {
  const r = findRequest("initialize")!;
  it("has hooks object", () => {
    expect(typeof r.request.hooks).toBe("object");
  });
  it("has optional prompts, agents, suggestions", () => {
    expect(r.request).toHaveProperty("appendSystemPrompt");
    expect(r.request).toHaveProperty("agents");
    expect(r.request).toHaveProperty("promptSuggestions");
    expect(r.request).toHaveProperty("agentProgressSummaries");
  });
});

describe("set_permission_mode", () => {
  it("has mode string", () => {
    const r = findRequest("set_permission_mode")!;
    expect(typeof r.request.mode).toBe("string");
  });
});

describe("set_model", () => {
  it("has model string", () => {
    const r = findRequest("set_model")!;
    expect(typeof r.request.model).toBe("string");
  });
});

describe("set_max_thinking_tokens", () => {
  it("supports number value", () => {
    const r = requests.filter(r => r.request.subtype === "set_max_thinking_tokens");
    const withNum = r.find(x => x.request.max_thinking_tokens !== null);
    expect(typeof withNum!.request.max_thinking_tokens).toBe("number");
  });
  it("supports null (disable)", () => {
    const r = requests.filter(r => r.request.subtype === "set_max_thinking_tokens");
    const withNull = r.find(x => x.request.max_thinking_tokens === null);
    expect(withNull).toBeDefined();
  });
});


describe("hook_callback", () => {
  const r = findRequest("hook_callback")!;
  it("has callback_id and input", () => {
    expect(typeof r.request.callback_id).toBe("string");
    expect(typeof r.request.input).toBe("object");
    expect(r.request.input.hook_event_name).toBeDefined();
  });
});

describe("mcp_message", () => {
  const r = findRequest("mcp_message")!;
  it("has server_name and message", () => {
    expect(typeof r.request.server_name).toBe("string");
    expect(r.request.message.jsonrpc).toBe("2.0");
  });
});

describe("rewind_files", () => {
  const r = findRequest("rewind_files")!;
  it("has user_message_id", () => {
    expect(typeof r.request.user_message_id).toBe("string");
  });
  it("has optional dry_run", () => {
    expect(typeof r.request.dry_run).toBe("boolean");
  });
});

describe("cancel_async_message", () => {
  it("has message_uuid", () => {
    const r = findRequest("cancel_async_message")!;
    expect(typeof r.request.message_uuid).toBe("string");
  });
});

describe("seed_read_state", () => {
  const r = findRequest("seed_read_state")!;
  it("has path and mtime", () => {
    expect(typeof r.request.path).toBe("string");
    expect(typeof r.request.mtime).toBe("number");
  });
});

describe("mcp_set_servers", () => {
  const r = findRequest("mcp_set_servers")!;
  it("has servers record", () => {
    expect(typeof r.request.servers).toBe("object");
    const server = r.request.servers["my-server"];
    expect(server.type).toBe("stdio");
    expect(server.command).toBeDefined();
  });
});

describe("mcp_reconnect", () => {
  it("has serverName", () => {
    const r = findRequest("mcp_reconnect")!;
    expect(typeof r.request.serverName).toBe("string");
  });
});

describe("mcp_toggle", () => {
  const r = findRequest("mcp_toggle")!;
  it("has serverName and enabled", () => {
    expect(typeof r.request.serverName).toBe("string");
    expect(typeof r.request.enabled).toBe("boolean");
  });
});

describe("stop_task", () => {
  it("has task_id", () => {
    const r = findRequest("stop_task")!;
    expect(typeof r.request.task_id).toBe("string");
  });
});

describe("apply_flag_settings", () => {
  it("has settings record", () => {
    const r = findRequest("apply_flag_settings")!;
    expect(typeof r.request.settings).toBe("object");
  });
});

describe("elicitation", () => {
  const r = findRequest("elicitation")!;
  it("has mcp_server_name, message", () => {
    expect(typeof r.request.mcp_server_name).toBe("string");
    expect(typeof r.request.message).toBe("string");
  });
  it("has optional mode, url, elicitation_id, requested_schema", () => {
    expect(r.request.mode).toBe("url");
    expect(typeof r.request.url).toBe("string");
    expect(typeof r.request.elicitation_id).toBe("string");
  });
});

// ---- control_cancel_request ----

describe("control_cancel_request", () => {
  it("has request_id", () => {
    expect(cancels.length).toBeGreaterThan(0);
    expect(typeof cancels[0]!.request_id).toBe("string");
  });
});

// ---- control_response ----

describe("control_response", () => {
  it("has multiple variants", () => {
    expect(responses.length).toBeGreaterThan(2);
  });

  it("permission allow response", () => {
    const allow = responses.find(r => r.response.response?.behavior === "allow" && !r.response.response?.updatedPermissions);
    expect(allow).toBeDefined();
    expect(allow.response.response.toolUseID).toBeDefined();
  });

  it("permission deny response", () => {
    const deny = responses.find(r => r.response.response?.behavior === "deny");
    expect(deny).toBeDefined();
    expect(typeof deny.response.response.message).toBe("string");
  });

  it("permission allow with updatedPermissions", () => {
    const withPerms = responses.find(r => r.response.response?.updatedPermissions);
    expect(withPerms).toBeDefined();
    const perm = withPerms.response.response.updatedPermissions[0];
    expect(perm.type).toBe("addRules");
    expect(perm.behavior).toBe("allow");
    expect(["userSettings", "projectSettings", "localSettings", "session", "cliArg"]).toContain(perm.destination);
  });

  it("hook callback response", () => {
    const hook = responses.find(r => r.response.response?.hookSpecificOutput);
    expect(hook).toBeDefined();
    expect(hook.response.response.continue).toBe(true);
    expect(hook.response.response.hookSpecificOutput.hookEventName).toBe("PreToolUse");
  });

  it("elicitation accept response", () => {
    const accept = responses.find(r => r.response.response?.action === "accept");
    expect(accept).toBeDefined();
    expect(accept.response.response.content).toBeDefined();
  });

  it("elicitation decline response", () => {
    const decline = responses.find(r => r.response.response?.action === "decline");
    expect(decline).toBeDefined();
  });
});
