import { App } from "@slack/bolt";
import { handleHomeOpened } from "./checklistMessage.js";
import { loadItems } from "./checklist.js";
import { selectClaudeClient } from "./claudeClient.js";
import { loadCopilotConfig } from "./config.js";
import type { Deps } from "./deps.js";
import { createDashboardServer, listenOnLocalhost } from "./dashboardServer.js";
import { log } from "./log.js";
import { handleMemberJoined, handleMemberLeft } from "./channel.js";
import { missingScopes } from "./scopes.js";
import { routeChannelMessage, routeMentionEvent, type ChannelMsg } from "./channelMessage.js";
import type { SlackClient } from "./slack.js";
import { handleOnboard, handleRole, handleTeamJoin } from "./start.js";
import { openStore, type Role } from "./store.js";
import { findClaudeAppId, handleAttest, withClaudeMark } from "./verify.js";

// The Onboarding Copilot entry point: Bolt in Socket Mode, the store, and the dashboard on 127.0.0.1.
// Written against the designs; not yet run against a live Slack workspace (BP-001).
const config = loadCopilotConfig();
const store = openStore(config.dbPath);
const items = loadItems();
const claude = selectClaudeClient();

// SLACK_LOG_LEVEL=debug prints the Socket Mode connection and every envelope Slack sends (for a bot that looks silent).
const app = new App({ token: config.botToken, appToken: config.appToken, socketMode: true });

// One line per request Slack delivers (no message text), so a silent bot can be told apart from a command that never arrives.
app.use(async ({ body, next }) => {
  const b = body as { type?: string; command?: string; event?: { type?: string } };
  log("incoming", { type: b.type ?? (b.command ? "slash_command" : "unknown"), command: b.command, event: b.event?.type });
  await next();
});

const depsFor = (client: unknown): Deps => ({
  store,
  slack: client as SlackClient,
  items,
  libraryDir: config.libraryDir,
  skillZipPath: config.skillZipPath,
  assetsDir: config.assetsDir,
  botMention: config.botMention,
  now: () => new Date().toISOString(),
  log,
  operators: config.operatorIds,
  glossaryUrl: config.glossaryUrl,
  checklistSurface: config.checklistSurface,
  canvasUrl: (id) => (workspace ? `${workspace.url}/docs/${workspace.teamId}/${id}` : ""),
});

let claudeAppId: string | undefined;
let botUserId: string | undefined;
let workspace: { url: string; teamId: string } | undefined;

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

// The owner leaving or rejoining their channel (FR-CH-023). Both handlers ignore every other user and never throw.
app.event("member_left_channel", async ({ event, client }) => {
  await handleMemberLeft(depsFor(client), { channel: event.channel, user: event.user });
});

app.event("member_joined_channel", async ({ event, client }) => {
  await handleMemberJoined(depsFor(client), { channel: event.channel, user: event.user });
});

app.action("open_glossary", async ({ ack }) => {
  await ack();
});

app.action(/^attest_I\d$/, async ({ ack, body, action, client }) => {
  await ack();
  await handleAttest(depsFor(client), (body as { user: { id: string } }).user.id, (action as { value: string }).value);
});

// Routing (report, I1, Q&A behind the filter, DM nudge) lives in channelMessage.ts.
app.message(async ({ message, client }) => {
  const m = message as ChannelMsg;
  const msg = m.text ? { ...m, text: withClaudeMark(m.text, m.app_id, claudeAppId) } : m;
  await routeChannelMessage(depsFor(client), claude, msg, { claudeAppId });
});

app.event("app_mention", async ({ event, client }) => {
  await routeMentionEvent(depsFor(client), claude, event as unknown as ChannelMsg, { claudeAppId });
});

await app.start();
const auth = await app.client.auth.test();
botUserId = auth.user_id;
if (auth.url && auth.team_id) workspace = { url: auth.url.replace(/\/$/, ""), teamId: auth.team_id };
claudeAppId = (await findClaudeAppId({ slack: app.client as unknown as SlackClient, log })) ?? config.claudeAppId;
log("start_up", { socket_mode: true, claude_app_found: Boolean(claudeAppId), dashboard_port: config.dashboardPort });
// Two settings the variant needs and that fail quietly when blank: say so at start.
if (!claudeAppId) log("config_warning", { missing: "CLAUDE_APP_ID", effect: "I1 cannot tick from the member's Claude post; the Claude app was not found in users.list either" });
// Slack lists the token's granted scopes in every response's metadata.
for (const scope of missingScopes((auth as { response_metadata?: { scopes?: string[] } }).response_metadata?.scopes)) {
  log("config_warning", { missing: `scope ${scope}`, effect: "add it to the app's manifest in Slack (App Manifest), save, then reinstall the app; reinstalling alone does not add a scope" });
}
if (!config.glossaryUrl) log("config_warning", { missing: "GLOSSARY_CANVAS_URL", effect: "the welcome and the checklist show no glossary link or button" });

const dashboard = createDashboardServer(store, items);
await listenOnLocalhost(dashboard, config.dashboardPort);
log("dashboard", { url: `http://127.0.0.1:${config.dashboardPort}/` });
