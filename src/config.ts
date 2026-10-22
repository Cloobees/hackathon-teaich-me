import "dotenv/config";
import { loadGatewayConfig, type GatewayConfig } from "./gateway.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name} (see .env.example)`);
  return value;
}

/** Settings needed by the agent itself (no Slack). */
export function loadAgentConfig(): AgentConfig {
  const gateway = loadGatewayConfig();
  return {
    gateway,
    // The company gateway only serves claude-fable-5-1, claude-opus-5, claude-sonnet-5, claude-haiku-4-5.
    model: process.env.MODEL || (gateway ? "claude-sonnet-5" : "claude-opus-5-5"),
    contextBuilderUrl: required("CONTEXT_BUILDER_URL"),
    contextBuilderToken: required("CONTEXT_BUILDER_TOKEN"),
  };
}

/** Settings needed to run the Slack app. */
export function loadSlackConfig() {
  return {
    botToken: required("SLACK_BOT_TOKEN"),
    appToken: required("SLACK_APP_TOKEN"),
  };
}

export interface AgentConfig {
  gateway?: GatewayConfig;
  model: string;
  contextBuilderUrl: string;
  contextBuilderToken: string;
}
