import type { PostToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { makeProgressHook } from "./hooks/contextBuilderProgress.js";
import type { TurnInput } from "./agent.js";
import { UPLOAD_TEST_PATH } from "./prompts/uploadTest.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const fakeCall = (tool: string, input: unknown) =>
  ({
    hook_event_name: "PostToolUse",
    tool_name: `mcp__context-builder__${tool}`,
    tool_input: input,
    tool_response: {},
    tool_use_id: "echo",
  }) as unknown as PostToolUseHookInput;

/**
 * No-credentials stand-in for runTurn: skips the agent and Context Builder, fires the real
 * progress hook with fake tool calls, then echoes the message back. Tests the Slack wiring only.
 */
export async function runEchoTurn({ text, slack, action }: TurnInput): Promise<string> {
  const hook = makeProgressHook(slack);
  const opts = { signal: new AbortController().signal };
  if (action === "upload-test-file") {
    await hook(fakeCall("write_file", { scopeType: "USER", path: UPLOAD_TEST_PATH }), "echo", opts);
    return `Echo mode (no agent): pretending I saved \`${UPLOAD_TEST_PATH}\` to your personal workspace. Nothing was actually uploaded.`;
  }
  await hook(fakeCall("list_scopes", {}), "echo", opts);
  await sleep(1500);
  await hook(fakeCall("semantic_search", { query: text }), "echo", opts);
  await sleep(1500);
  await hook(fakeCall("read_file", { path: "onboarding/getting-started.md" }), "echo", opts);
  return `Echo mode (no agent): you said "${text}". The progress note above came from the real PostToolUse hook.`;
}
