import { query } from "@anthropic-ai/claude-agent-sdk";
import { getGatewayToken, loadGatewayConfig, type GatewayConfig } from "./gateway.js";

/** One interface for the model call, so the Assist logic is tested with a fake (assist design, BP-027). */
export interface ClaudeClient {
  complete(args: { system: string; user: string }): Promise<string>;
}

/** The gateway serves claude-sonnet-5 (see gateway.ts); a direct key uses the SDK default. MODEL overrides both. */
export const defaultModel = (gateway?: GatewayConfig, env: NodeJS.ProcessEnv = process.env) =>
  env.MODEL || (gateway ? "claude-sonnet-5" : "claude-opus-5-5");

/**
 * A plain Messages API call, the same shape `scripts/smoke-gateway.ts` step 1 uses. With a gateway the bearer token is
 * a fresh Azure token on every call; without one the call goes to Anthropic with ANTHROPIC_API_KEY.
 */
export function createClaudeClient(model: string, gateway?: GatewayConfig, env: NodeJS.ProcessEnv = process.env): ClaudeClient {
  return {
    async complete({ system, user }) {
      const headers: Record<string, string> = { "anthropic-version": "2023-06-01", "content-type": "application/json" };
      let base = "https://api.anthropic.com";
      if (gateway) {
        base = gateway.baseUrl;
        headers.Authorization = `Bearer ${await getGatewayToken(gateway)}`;
      } else {
        if (!env.ANTHROPIC_API_KEY) throw new Error("missing GATEWAY_BASE_URL or ANTHROPIC_API_KEY");
        headers["x-api-key"] = env.ANTHROPIC_API_KEY;
      }
      const res = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model, max_tokens: 1024, system, messages: [{ role: "user", content: user }] }),
      });
      if (!res.ok) throw new Error(`Claude call failed: HTTP ${res.status}`);
      const body = (await res.json()) as { content?: { type: string; text?: string }[] };
      return (body.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
    },
  };
}

/**
 * Option B: the signed-in Claude Code session, through the Agent SDK's bundled `claude`. No key, no gateway.
 * No tools, no settings files, one turn, so it behaves as a plain completion. Anthropic's terms do not let a
 * product offer claude.ai login (see README), so this is for local use by a team member on their own seat until
 * a key is available (option A). `model` is left to Claude Code's default unless MODEL is set.
 */
export function createClaudeCodeClient(model?: string, run: typeof query = query): ClaudeClient {
  return {
    async complete({ system, user }) {
      // Drop any key or gateway variables so the SDK uses the local Claude Code login.
      const env: Record<string, string | undefined> = { ...process.env };
      for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]) delete env[name];
      for await (const msg of run({ prompt: user, options: { model, systemPrompt: system, tools: [], settingSources: [], maxTurns: 1, env } })) {
        if (msg.type !== "result") continue;
        if (msg.subtype === "success") return msg.result;
        throw new Error(`Claude Code run failed: ${msg.subtype}`);
      }
      throw new Error("Claude Code returned no result");
    },
  };
}

/** CLAUDE_AUTH=claude-code picks option B. Anything else uses the gateway when set, otherwise ANTHROPIC_API_KEY (option A). */
export function selectClaudeClient(env: NodeJS.ProcessEnv = process.env): ClaudeClient {
  if (env.CLAUDE_AUTH === "claude-code") return createClaudeCodeClient(env.MODEL || undefined);
  const gateway = loadGatewayConfig();
  return createClaudeClient(defaultModel(gateway, env), gateway, env);
}
