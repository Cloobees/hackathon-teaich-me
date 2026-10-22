import { describe, expect, it, vi } from "vitest";
import { describeToolCall, makeProgressHook, type SlackPoster } from "./contextBuilderProgress.js";

const post = (tool_name: string, tool_input: unknown) =>
  ({ hook_event_name: "PostToolUse", tool_name, tool_input, tool_response: {}, tool_use_id: "t" }) as never;
const opts = { signal: new AbortController().signal };

function stub(): SlackPoster & { postMessage: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> } {
  const postMessage = vi.fn().mockResolvedValue({ ts: "99.1" });
  const update = vi.fn().mockResolvedValue({});
  return { chat: { postMessage, update }, postMessage, update };
}

describe("describeToolCall", () => {
  it("describes a search with its query", () => {
    expect(describeToolCall("mcp__context-builder__semantic_search", { query: "onboarding" })).toBe(
      '🔎 Searched Context Builder for "onboarding"',
    );
  });
  it("describes a file write", () => {
    expect(describeToolCall("mcp__context-builder__write_file", { path: "onboarding/a.txt" })).toBe(
      "📝 Saved onboarding/a.txt to your personal workspace",
    );
  });
  it("falls back for unknown tools", () => {
    expect(describeToolCall("mcp__context-builder__traverse", {})).toContain("traverse");
  });
});

describe("makeProgressHook", () => {
  it("posts once, then updates the same message", async () => {
    const client = stub();
    const hook = makeProgressHook({ client, channel: "C1", threadTs: "1.0" });
    await hook(post("mcp__context-builder__list_scopes", {}), "t", opts);
    await hook(post("mcp__context-builder__read_file", { path: "a.md" }), "t", opts);
    expect(client.postMessage).toHaveBeenCalledTimes(1);
    expect(client.update).toHaveBeenCalledTimes(1);
    expect(client.update.mock.calls[0][0]).toMatchObject({ channel: "C1", ts: "99.1" });
    expect(client.update.mock.calls[0][0].text).toContain("📄 Read a.md");
  });

  it("swallows Slack errors", async () => {
    const client = stub();
    client.postMessage.mockRejectedValue(new Error("rate_limited"));
    const hook = makeProgressHook({ client, channel: "C1", threadTs: "1.0" });
    await expect(hook(post("mcp__context-builder__list_scopes", {}), "t", opts)).resolves.toEqual({});
  });
});
