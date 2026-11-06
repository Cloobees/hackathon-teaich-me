import { config as loadDotenv } from "dotenv";
import { loadGatewayConfig, type GatewayConfig } from "./gateway.js";

// `.env` wins over variables already exported in the shell, so a stale SLACK_APP_TOKEN there cannot connect the bot to another app.
loadDotenv({ override: true, quiet: true });

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

export const DEFAULT_BOT_MENTION = "@onboarding-copilot";

export interface CopilotConfig {
  botToken: string;
  appToken: string;
  operatorIds: string[];
  dbPath: string;
  libraryDir: string;
  dashboardPort: number;
  glossaryUrl?: string;
  skillZipPath: string;
  /** Folder of the images an instruction can show (`{image:name.png}` in an item file). */
  assetsDir: string;
  botMention: string;
  /** Slack `app_id` of the Claude app (`A...`), for workspaces where the connector footer carries no `<@...>` mention. */
  claudeAppId?: string;
  /** Where the checklist is drawn (CHECKLIST_SURFACE): `message` unless the value is exactly `canvas` or `both` (the pinned message and the canvas together). */
  checklistSurface: "canvas" | "message" | "both";
}

/** Settings for the Onboarding Copilot. Throws `missing <NAME>` for the first required variable that is absent. */
const parseSurface = (value: string | undefined): "canvas" | "message" | "both" => {
  const v = value?.trim().toLowerCase();
  return v === "canvas" || v === "both" ? v : "message";
};

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
    // The copilot-check zip sits in library-files/, beside library/ so the question handler never reads it (FR-AS-011).
    skillZipPath: env.SKILL_ZIP_PATH || "library-files/copilot-check.zip",
    assetsDir: env.ASSETS_DIR || "assets",
    // Member-visible text for the /invite step. /invite resolves an @handle, not a display name with a space, so this is
    // the bot user's display_name from the manifest (onboarding-copilot).
    botMention: env.BOT_MENTION || DEFAULT_BOT_MENTION,
    claudeAppId: env.CLAUDE_APP_ID?.trim() || undefined,
    checklistSurface: parseSurface(env.CHECKLIST_SURFACE),
  };
}

export interface AgentConfig {
  gateway?: GatewayConfig;
  model: string;
  contextBuilderUrl: string;
  contextBuilderToken: string;
}
