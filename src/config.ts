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

export interface CopilotConfig {
  botToken: string;
  appToken: string;
  operatorIds: string[];
  dbPath: string;
  libraryDir: string;
  dashboardPort: number;
  glossaryUrl?: string;
  checkChannelId?: string;
  reportPasteFallback: boolean;
  skillZipPath: string;
}

/** Settings for the Toolchain Copilot. Throws `missing <NAME>` for the first required variable that is absent. */
export function loadCopilotConfig(env: NodeJS.ProcessEnv = process.env): CopilotConfig {
  const need = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`missing ${name}`);
    return value;
  };
  return {
    botToken: need("SLACK_BOT_TOKEN"),
    appToken: need("SLACK_APP_TOKEN"),
    // Commas, semicolons or spaces between ids.
    operatorIds: need("OPERATOR_USER_IDS").split(/[,;\s]+/).filter(Boolean),
    dbPath: env.DB_PATH || "state/copilot.db",
    libraryDir: env.LIBRARY_DIR || "library",
    dashboardPort: Number(env.DASHBOARD_PORT) || 3000,
    glossaryUrl: env.GLOSSARY_CANVAS_URL || undefined,
    // Where the member's Claude posts its report block; optional, the check button says it is not set up without it.
    checkChannelId: env.CHECK_CHANNEL_ID?.trim() || undefined,
    // Off unless true or 1 (FR-VF-015, BP-052).
    reportPasteFallback: ["true", "1"].includes(env.REPORT_PASTE_FALLBACK?.trim().toLowerCase() ?? ""),
    // The copilot-check zip sits in library-files/, beside library/ so the question handler never reads it (FR-AS-011).
    skillZipPath: env.SKILL_ZIP_PATH || "library-files/copilot-check.zip",
  };
}

export interface AgentConfig {
  gateway?: GatewayConfig;
  model: string;
  contextBuilderUrl: string;
  contextBuilderToken: string;
}
