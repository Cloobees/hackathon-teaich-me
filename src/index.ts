import { App } from "@slack/bolt";
import { runTurn, type TurnInput } from "./agent.js";
import { loadAgentConfig, loadSlackConfig } from "./config.js";
import { runEchoTurn } from "./echo.js";
import { uploadTestPrompt } from "./prompts/uploadTest.js";

// ECHO_MODE=1 tests the Slack wiring and progress hook without Anthropic/Context Builder credentials.
const echoMode = process.env.ECHO_MODE === "1";
const agentConfig = echoMode ? undefined : loadAgentConfig();
const slack = loadSlackConfig();

const app = new App({ token: slack.botToken, appToken: slack.appToken, socketMode: true });

type Msg = { channel: string; ts: string; thread_ts?: string; text?: string; user?: string; bot_id?: string; subtype?: string };

async function handle(msg: Msg, client: App["client"]) {
  if (msg.bot_id || msg.subtype || !msg.text) return;
  const threadTs = msg.thread_ts ?? msg.ts;
  // Strip the @mention so the agent sees just the question.
  const text = msg.text.replace(/<@[A-Z0-9]+>/g, "").trim();
  if (!text) return;

  try {
    const turn = { threadKey: `${msg.channel}:${threadTs}`, text, slack: { client, channel: msg.channel, threadTs } };
    const reply = agentConfig ? await runTurn(agentConfig, turn) : await runEchoTurn(turn);
    await client.chat.postMessage({ channel: msg.channel, thread_ts: threadTs, text: reply || "I have no answer for that." });
  } catch (error) {
    console.error("[bot] turn failed:", error);
    await client.chat.postMessage({ channel: msg.channel, thread_ts: threadTs, text: "Sorry, something went wrong." });
  }
}

const UPLOAD_ACTION_ID = "upload_test_file";

// Shown every time the user opens the app's Messages tab.
app.event("app_home_opened", async ({ event, client }) => {
  if (event.tab !== "messages") return;
  await client.chat.postMessage({
    channel: event.channel,
    text: "Welcome to TeAIch Me! Click the button to upload a test file to your personal workspace.",
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: "*Welcome to TeAIch Me!* 👋\nI'll upload a small test file to your personal Context Builder workspace." } },
      {
        type: "actions",
        elements: [{ type: "button", style: "primary", action_id: UPLOAD_ACTION_ID, text: { type: "plain_text", text: "Upload a test file to my workspace" } }],
      },
    ],
  });
});

app.action(UPLOAD_ACTION_ID, async ({ ack, body, client }) => {
  await ack();
  const channel = body.channel?.id;
  const buttonTs = (body as { message?: { ts?: string } }).message?.ts;
  if (!channel || !buttonTs) return;

  try {
    const turn: TurnInput = {
      threadKey: `${channel}:${buttonTs}`,
      text: uploadTestPrompt(body.user.id),
      slack: { client, channel, threadTs: buttonTs },
      action: "upload-test-file",
    };
    const reply = agentConfig ? await runTurn(agentConfig, turn) : await runEchoTurn(turn);
    await client.chat.postMessage({ channel, thread_ts: buttonTs, text: reply || "Done, but I have nothing to report." });
  } catch (error) {
    console.error("[bot] upload action failed:", error);
    await client.chat.postMessage({ channel, thread_ts: buttonTs, text: "Sorry, the upload failed." });
  }
});

app.event("app_mention", async ({ event, client }) => handle(event as Msg, client));
app.message(async ({ message, client }) => {
  // DMs only; channel mentions are handled by app_mention above.
  if ((message as { channel_type?: string }).channel_type === "im") await handle(message as Msg, client);
});

await app.start();
console.log(`⚡ TeAIch Me bot is running (Socket Mode${echoMode ? ", echo mode" : ""})`);
