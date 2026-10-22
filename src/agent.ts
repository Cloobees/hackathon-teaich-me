import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentConfig } from "./config.js";
import { gatewayEnv } from "./gateway.js";
import { makeProgressHook, type ProgressTarget } from "./hooks/contextBuilderProgress.js";
import { writeGuard } from "./hooks/writeGuard.js";
import { ONBOARDING_PROMPT } from "./prompts/onboarding.js";
import { UPLOAD_TEST_SYSTEM_NOTE } from "./prompts/uploadTest.js";
import { getSession, setSession } from "./sessions.js";

const SERVER = "context-builder";
const READ_TOOLS = ["list_scopes", "semantic_search", "get_node", "read_file", "list_files"];
const WRITE_TOOLS = ["create_node", "revise_node", "link_nodes", "write_file"];
// Actions that may use write_file (still restricted by writeGuard to the personal onboarding/ folder).
export type TurnAction = "upload-test-file";
const mcp = (tool: string) => `mcp__${SERVER}__${tool}`;

export interface TurnInput {
  threadKey: string;
  text: string;
  slack: ProgressTarget;
  action?: TurnAction;
}

const UNREACHABLE = "Sorry, I can't reach Context Builder right now, so I can't look that up. Please try again later.";

export async function runTurn(config: AgentConfig, { threadKey, text, slack, action }: TurnInput): Promise<string> {
  let reply = "";
  const canWrite = action === "upload-test-file";
  // With the gateway, authenticate with a fresh Azure token instead of ANTHROPIC_API_KEY.
  const env: Record<string, string | undefined> = { ...process.env };
  if (config.gateway) {
    delete env.ANTHROPIC_API_KEY;
    Object.assign(env, await gatewayEnv(config.gateway));
  }

  for await (const msg of query({
    prompt: text,
    options: {
      model: config.model,
      systemPrompt: canWrite ? ONBOARDING_PROMPT + UPLOAD_TEST_SYSTEM_NOTE : ONBOARDING_PROMPT,
      mcpServers: {
        [SERVER]: {
          type: "http",
          url: config.contextBuilderUrl,
          headers: { Authorization: `Bearer ${config.contextBuilderToken}` },
        },
      },
      // Slack-facing bot: no built-in tools (Bash, Read, ...), only read-only Context Builder tools.
      tools: [],
      allowedTools: [...READ_TOOLS, ...(canWrite ? ["write_file"] : [])].map(mcp),
      disallowedTools: WRITE_TOOLS.filter((t) => !(canWrite && t === "write_file")).map(mcp),
      permissionMode: "dontAsk", // anything not allowlisted is denied instead of prompting
      settingSources: [],
      maxTurns: 10,
      resume: getSession(threadKey),
      env,
      hooks: {
        PreToolUse: [{ matcher: `^${mcp("write_file")}$`, hooks: [writeGuard] }],
        PostToolUse: [{ matcher: `^${mcp("")}`, hooks: [makeProgressHook(slack)] }],
      },
    },
  })) {
    if ("session_id" in msg && msg.session_id) setSession(threadKey, msg.session_id);

    if (msg.type === "system" && msg.subtype === "init") {
      const server = msg.mcp_servers.find((s) => s.name === SERVER);
      if (server && (server.status === "failed" || server.status === "needs-auth")) {
        console.error(`[agent] Context Builder MCP status: ${server.status}`);
        return UNREACHABLE;
      }
    }
    if (msg.type === "result") {
      reply = msg.subtype === "success" ? msg.result : "Sorry, something went wrong while working on that.";
    }
  }
  return reply;
}
