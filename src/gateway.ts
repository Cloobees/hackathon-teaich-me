import { DefaultAzureCredential } from "@azure/identity";

export interface GatewayConfig {
  baseUrl: string;
  tenantId: string;
}

const SCOPE = "https://cognitiveservices.azure.com/.default";

/** Gateway settings, or undefined when the bot should use ANTHROPIC_API_KEY directly. */
export function loadGatewayConfig(): GatewayConfig | undefined {
  const baseUrl = process.env.GATEWAY_BASE_URL;
  if (!baseUrl) return undefined;
  const tenantId = process.env.AZURE_TENANT_ID;
  if (!tenantId) throw new Error("GATEWAY_BASE_URL is set but AZURE_TENANT_ID is missing (see .env.example)");
  return { baseUrl: baseUrl.replace(/\/+$/, ""), tenantId };
}

// DefaultAzureCredential picks up the `az login` session locally (and a service principal /
// managed identity when hosted) and caches tokens, refreshing them when they near expiry.
let credential: DefaultAzureCredential | undefined;

export async function getGatewayToken(config: GatewayConfig): Promise<string> {
  credential ??= new DefaultAzureCredential({ tenantId: config.tenantId });
  return (await credential.getToken(SCOPE)).token;
}

/** Env vars that point the Agent SDK's Claude Code subprocess at the gateway. */
export async function gatewayEnv(config: GatewayConfig): Promise<Record<string, string>> {
  return {
    ANTHROPIC_BASE_URL: config.baseUrl,
    ANTHROPIC_AUTH_TOKEN: await getGatewayToken(config),
    // Claude Code uses a Haiku model for background work; the gateway only knows this ID.
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5",
    // Gateways often reject pre-release beta headers/fields.
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
  };
}
