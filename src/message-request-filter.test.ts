import { describe, expect, it } from "vitest";
import { shouldObserveMessagesRequest } from "./message-request-filter.js";

describe("shouldObserveMessagesRequest", () => {
  it("filters Claude Code session title generation requests", () => {
    expect(shouldObserveMessagesRequest({
      model: "claude-haiku",
      system: [
        {
          type: "text",
          text: 'Generate a concise, sentence-case title (3-7 words).\n\nReturn JSON with a single "title" field.',
        },
      ],
      messages: [{ role: "user", content: "answer in one word: ok" }],
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title"],
            additionalProperties: false,
          },
        },
      },
    })).toBe(false);
  });

  it("observes normal message requests", () => {
    expect(shouldObserveMessagesRequest({
      model: "claude-opus",
      system: [{ type: "text", text: "You are Claude Code." }],
      messages: [{ role: "user", content: "hello" }],
    })).toBe(true);
  });

  it("observes user JSON schema requests that happen to produce a title", () => {
    expect(shouldObserveMessagesRequest({
      model: "claude-opus",
      system: [{ type: "text", text: "Respond according to the user's schema." }],
      messages: [{ role: "user", content: "Return a title for this article." }],
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title"],
          },
        },
      },
    })).toBe(true);
  });
});
