import { App } from "@slack/bolt";
import { handleHomeOpened } from "./checklistMessage.js";
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
import { findClaudeAppId, handleAttest, handleChannelMessage, handleChannelReport, withClaudeMark } from "./verify.js";

// The Onboarding Copilot entry point: Bolt in Socket Mode, the store, and the dashboard on 127.0.0.1.
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
  skillZipPath: config.skillZipPath,
  botMention: config.botMention,
  now: () => new Date().toISOString(),
  log,
  operators: config.operatorIds,
  glossaryUrl: config.glossaryUrl,
  harnessRepo: config.harnessRepo,
});

let claudeAppId: string | undefined;
let botUserId: string | undefined;

app.command("/onboard-ch", async ({ command, ack, respond, client }) => {
  await ack();
  log("command", { command: "/onboard-ch", member: command.user_id });
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

// The glossary button opens a URL; Slack still sends the click, so it is acknowledged and nothing else.
// Without this, Slack leaves the Home tab blank until a view is published.
app.event("app_home_opened", async ({ event, client }) => {
  if (event.tab !== "home") return;
  await handleHomeOpened(depsFor(client), event.user);
});

app.action("open_glossary", async ({ ack }) => {
  await ack();
});

app.action(/^attest_I\d$/, async ({ ack, body, action, client }) => {
  await ack();
  await handleAttest(depsFor(client), (body as { user: { id: string } }).user.id, (action as { value: string }).value);
});

app.message(async ({ message, client }) => {
  const m = message as { user?: string; text?: string; ts: string; channel: string; channel_type?: string; bot_id?: string; subtype?: string; app_id?: string };
  if (m.bot_id || m.subtype || !m.user || !m.text) return;
  const text = withClaudeMark(m.text, m.app_id, claudeAppId);
  const deps = depsFor(client);
  if (m.channel_type === "im") {
    await handleQuestion(deps, claude, { memberId: m.user, channel: m.channel, text: m.text });
    return;
  }
  if (text.includes("COPILOT-REPORT")) {
    // A report block counts only in a member's stored channel; in any other channel it is ignored.
    await handleChannelReport(deps, { channel: m.channel, user: m.user, text, ts: m.ts, claudeAppId });
    return;
  }
  await handleChannelMessage(deps, { memberId: m.user, text, ts: m.ts, claudeAppId });
});

await app.start();
botUserId = (await app.client.auth.test()).user_id;
claudeAppId = (await findClaudeAppId({ slack: app.client as unknown as SlackClient, log })) ?? config.claudeAppId;
log("start_up", { socket_mode: true, claude_app_found: Boolean(claudeAppId), dashboard_port: config.dashboardPort });

const dashboard = createDashboardServer(store, items);
await listenOnLocalhost(dashboard, config.dashboardPort);
log("dashboard", { url: `http://127.0.0.1:${config.dashboardPort}/` });
