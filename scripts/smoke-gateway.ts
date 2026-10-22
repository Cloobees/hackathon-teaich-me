import "dotenv/config";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { gatewayEnv, getGatewayToken, loadGatewayConfig } from "../src/gateway.js";

// Checks the company gateway in two steps: (1) a raw Messages API call, (2) the Agent SDK with no tools.
const config = loadGatewayConfig();
if (!config) throw new Error("Set GATEWAY_BASE_URL and AZURE_TENANT_ID in .env");
const model = process.env.MODEL || "claude-sonnet-5";

console.log(`1) Raw Messages API call to ${config.baseUrl} (model ${model})`);
const res = await fetch(`${config.baseUrl}/v1/messages`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${await getGatewayToken(config)}`,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  },
  body: JSON.stringify({ model, max_tokens: 256, messages: [{ role: "user", content: "Reply with the single word: pong" }] }),
});
const body = (await res.json().catch(() => ({}))) as { content?: { type: string; text?: string }[] };
console.log("   HTTP", res.status, "->", body.content?.filter((b) => b.type === "text").map((b) => b.text).join("") ?? JSON.stringify(body));
if (!res.ok) process.exit(1);

console.log("2) Agent SDK through the gateway (no tools)");
const env: Record<string, string | undefined> = { ...process.env, ...(await gatewayEnv(config)) };
delete env.ANTHROPIC_API_KEY;
for await (const msg of query({
  prompt: "Reply with the single word: pong",
  options: { model, tools: [], settingSources: [], maxTurns: 1, env },
})) {
  if (msg.type === "result") console.log("   ", msg.subtype, "->", msg.subtype === "success" ? msg.result : JSON.stringify(msg).slice(0, 400));
}
