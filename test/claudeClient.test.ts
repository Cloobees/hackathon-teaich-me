import type { query } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { createClaudeCodeClient } from "../src/claudeClient.js";

type Run = typeof query;
type Params = Parameters<Run>[0];

/** A stand-in for the SDK's query(): yields the given messages and records what it was called with. */
function fakeRun(messages: unknown[]) {
  const seen: Params[] = [];
  const run = ((params: Params) => {
    seen.push(params);
    return (async function* () {
      for (const m of messages) yield m;
    })();
  }) as unknown as Run;
  return { run, seen };
}

describe("createClaudeCodeClient (option B)", () => {
  it("returns the result text and asks for a plain, tool-free, one-turn completion", async () => {
    const { run, seen } = fakeRun([{ type: "system" }, { type: "result", subtype: "success", result: "hello [Glossary]" }]);
    const reply = await createClaudeCodeClient(undefined, run).complete({ system: "RULES", user: "QUESTION" });
    expect(reply).toBe("hello [Glossary]");
    const options = seen[0]?.options;
    expect(seen[0]?.prompt).toBe("QUESTION");
    expect(options).toMatchObject({ systemPrompt: "RULES", tools: [], settingSources: [], maxTurns: 1 });
  });

  it("removes key and gateway variables so the local login is used", async () => {
    process.env.ANTHROPIC_API_KEY = "k";
    process.env.ANTHROPIC_BASE_URL = "https://example.invalid";
    const { run, seen } = fakeRun([{ type: "result", subtype: "success", result: "x" }]);
    await createClaudeCodeClient(undefined, run).complete({ system: "s", user: "u" });
    const env = seen[0]?.options?.env as Record<string, string | undefined>;
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
  });

  it("throws on a failed run so Assist replies with the error text", async () => {
    const { run } = fakeRun([{ type: "result", subtype: "error_max_turns" }]);
    await expect(createClaudeCodeClient(undefined, run).complete({ system: "s", user: "u" })).rejects.toThrow("error_max_turns");
  });

  it("throws when no result arrives", async () => {
    const { run } = fakeRun([{ type: "system" }]);
    await expect(createClaudeCodeClient(undefined, run).complete({ system: "s", user: "u" })).rejects.toThrow("no result");
  });
});
