import type { HookCallback, PostToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";

/** The slice of the Slack WebClient this hook needs; lets tests pass a stub. */
export interface SlackPoster {
  chat: {
    postMessage(args: { channel: string; thread_ts: string; text: string }): Promise<{ ts?: string }>;
    update(args: { channel: string; ts: string; text: string }): Promise<unknown>;
  };
}

export interface ProgressTarget {
  client: SlackPoster;
  channel: string;
  threadTs: string;
}

const PREFIX = "mcp__context-builder__";

function str(value: unknown, max = 80): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** One human-readable line for a Context Builder tool call. Uses tool_input only. */
export function describeToolCall(toolName: string, toolInput: unknown): string {
  const name = toolName.startsWith(PREFIX) ? toolName.slice(PREFIX.length) : toolName;
  const input = (toolInput ?? {}) as Record<string, unknown>;
  switch (name) {
    case "semantic_search":
      return `🔎 Searched Context Builder for "${str(input.query) ?? "…"}"`;
    case "read_file":
      return `📄 Read ${str(input.path) ?? "a file"}`;
    case "get_node":
      return `🧩 Opened a Context Builder node`;
    case "list_files":
      return `📁 Listed files in Context Builder`;
    case "write_file":
      return `📝 Saved ${str(input.path) ?? "a file"} to your personal workspace`;
    case "list_scopes":
      return `🗂️ Checked which Context Builder scopes you can access`;
    default:
      return `🔧 Used Context Builder (${name})`;
  }
}

/**
 * PostToolUse hook: keeps one status message per turn in the Slack thread and
 * appends a line to it after every Context Builder tool call. It never throws
 * and never blocks the agent; a Slack failure only loses the progress note.
 */
export function makeProgressHook(target: ProgressTarget): HookCallback {
  const lines: string[] = [];
  let statusTs: string | undefined;
  // Serialize Slack calls so the first postMessage finishes before any update.
  let queue: Promise<void> = Promise.resolve();

  const render = () => `_Working on it…_\n${lines.join("\n")}`;

  const push = async () => {
    try {
      if (!statusTs) {
        const res = await target.client.chat.postMessage({
          channel: target.channel,
          thread_ts: target.threadTs,
          text: render(),
        });
        statusTs = res.ts;
      } else {
        await target.client.chat.update({ channel: target.channel, ts: statusTs, text: render() });
      }
    } catch (error) {
      console.error("[progress-hook] Slack update failed:", error);
    }
  };

  return async (input) => {
    if (input.hook_event_name !== "PostToolUse") return {};
    const { tool_name, tool_input } = input as PostToolUseHookInput;
    lines.push(describeToolCall(tool_name, tool_input));
    queue = queue.then(push);
    await queue;
    return {};
  };
}
