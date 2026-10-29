import { App } from "@slack/bolt";
import { loadItems } from "./checklist.js";
import { selectClaudeClient } from "./claudeClient.js";
import { loadCopilotConfig } from "./config.js";
import type { Deps } from "./deps.js";
import { createDashboardServer, listenOnLocalhost } from "./dashboardServer.js";
import { log } from "./log.js";
import { handleQuestion } from "./questions.js";
import type { SlackClient } from "./slack.js";
import { handleOnboard, handleRole, handleTeamJoin } from "./start.js";
import { openStore, type Role } from "./store.js";
import { findClaudeAppId, handleAttest, handleChannelMessage, handleReportDm, issueReportPrompt } from "./verify.js";

// The Toolchain Copilot entry point: Bolt in Socket Mode, the store, and the dashboard on 127.0.0.1.
// Written against the designs; not yet run against a live Slack workspace (BP-001).
const config = loadCopilotConfig();
const store = openStore(config.dbPath);
const items = loadItems();
const claude = selectClaudeClient();

const app = new App({ token: config.botToken, appToken: config.appToken, socketMode: true });

const depsFor = (client: unknown): Deps => ({
  store,
  slack: client as SlackClient,
  items,
  libraryDir: config.libraryDir,
  now: () => new Date().toISOString(),
  log,
  operators: config.operatorIds,
  glossaryUrl: config.glossaryUrl,
});

let claudeAppId: string | undefined;

app.command("/onboard", async ({ command, ack, respond, client }) => {
  await ack();
  log("command", { command: "/onboard", member: command.user_id });
  const text = await handleOnboard(depsFor(client), { callerId: command.user_id, text: command.text, triggerId: command.trigger_id });
  await respond({ response_type: "ephemeral", text });
});

app.event("team_join", async ({ event, body, client }) => {
  const user = (event as { user: { id: string; is_bot?: boolean } }).user;
  log("team_join", { member: user.id });
  await handleTeamJoin(depsFor(client), { memberId: user.id, isBot: user.is_bot, eventId: (body as { event_id?: string }).event_id });
});

app.action(/^role_(technical|non-technical)$/, async ({ ack, body, action, client }) => {
  await ack();
  const b = body as { user: { id: string }; channel?: { id: string }; message?: { ts: string } };
  if (!b.channel || !b.message) return;
  const role = (action as { value: string }).value as Role;
  await handleRole(depsFor(client), { memberId: b.user.id, role, channel: b.channel.id, messageTs: b.message.ts });
});

app.action(/^attest_I\d$/, async ({ ack, body, action, client }) => {
  await ack();
  await handleAttest(depsFor(client), (body as { user: { id: string } }).user.id, (action as { value: string }).value);
});

app.action(/^report_prompt_I\d$/, async ({ ack, body, action, client }) => {
  await ack();
  await issueReportPrompt(depsFor(client), (body as { user: { id: string } }).user.id, (action as { value: string }).value);
});

app.message(async ({ message, client }) => {
  const m = message as { user?: string; text?: string; ts: string; channel: string; channel_type?: string; bot_id?: string; subtype?: string };
  if (m.bot_id || m.subtype || !m.user || !m.text) return;
  const deps = depsFor(client);
  if (m.channel_type === "im") {
    // Report blocks go to verification; everything else is a question.
    if (await handleReportDm(deps, { memberId: m.user, channel: m.channel, text: m.text })) return;
    await handleQuestion(deps, claude, { memberId: m.user, channel: m.channel, text: m.text });
    return;
  }
  await handleChannelMessage(deps, { memberId: m.user, text: m.text, ts: m.ts, claudeAppId });
});

await app.start();
claudeAppId = await findClaudeAppId({ slack: app.client as unknown as SlackClient, log });
log("start_up", { socket_mode: true, claude_app_found: Boolean(claudeAppId), dashboard_port: config.dashboardPort });

const dashboard = createDashboardServer(store, items);
await listenOnLocalhost(dashboard, config.dashboardPort);
log("dashboard", { url: `http://127.0.0.1:${config.dashboardPort}/` });
