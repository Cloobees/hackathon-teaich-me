// Routes every message the app hears (FR-CH-017, FR-CH-019, DD-CH-005). `app.ts` only hands events to these two functions.
import type { ClaudeClient } from "./claudeClient.js";
import type { Deps } from "./deps.js";
import { getMemberChannel } from "./store.js";
import { handleQuestion } from "./questions.js";
import { handleChannelMessage, handleChannelReport } from "./verify.js";

/** The fields of a `message` or `app_mention` event the router reads. `message` is the nested payload of an edit or deletion. */
export interface ChannelMsg {
  channel: string;
  channel_type?: string;
  user?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  subtype?: string;
  bot_id?: string;
  app_id?: string;
  message?: unknown;
}

export interface RouteOptions {
  /** The Claude app's user id when known; the report and I1 routes and the Claude-mention filter read it. */
  claudeAppId?: string;
}

const NUDGE_WITH_CHANNEL = (channel: string) => `I answer in your onboarding channel: <#${channel}>.`;
const NUDGE_WITHOUT_CHANNEL = "Type `/onboard-ch` to start your onboarding.";
const LEADING_MENTION = /^\s*<@[A-Z0-9]+(\|[^>]*)?>/;

/** A human's own text: no subtype, no bot or app author, a user and non-empty text. Edits and deletions fail on `subtype` or on the missing top-level text. */
const isHumanText = (msg: ChannelMsg): msg is ChannelMsg & { user: string; text: string } =>
  !msg.subtype && !msg.bot_id && !msg.app_id && Boolean(msg.user) && typeof msg.text === "string" && msg.text.trim() !== "";

/** One short message in the DM, then nothing else (FR-CH-019). Points to the channel only while it is `active`; otherwise to `/onboard-ch`, which re-invites. */
async function nudge(deps: Deps, msg: ChannelMsg & { user: string }): Promise<void> {
  const stored = getMemberChannel(deps.store, msg.user);
  const text = stored?.id && stored.state === "active" ? NUDGE_WITH_CHANNEL(stored.id) : NUDGE_WITHOUT_CHANNEL;
  await deps.slack.chat.postMessage({ channel: msg.channel, text });
}

/** Answers `msg` from the library when it passes the Q&A filter; false means it was not a question. Once per `ts`. */
async function answerIfQuestion(deps: Deps, claude: ClaudeClient, msg: ChannelMsg, opts: RouteOptions): Promise<boolean> {
  if (!isHumanText(msg)) return false;
  if (msg.text.includes("COPILOT-REPORT")) return false;
  if (opts.claudeAppId && msg.text.includes(`<@${opts.claudeAppId}>`)) return false;
  const owner = deps.store.get<{ member_id: string; channel_state: string | null }>(
    "SELECT member_id, channel_state FROM member WHERE channel_id = ?",
    msg.channel,
  );
  if (!owner || owner.channel_state !== "active" || owner.member_id !== msg.user) return false;
  const question = msg.text.replace(LEADING_MENTION, "").trim();
  if (!question) return false;
  // A message event and an app_mention event for the same ts (or a Slack retry) give one answer.
  const fresh = deps.store.run("INSERT OR IGNORE INTO processed_event (event_id, received_at) VALUES (?, ?)", `qa:${msg.channel}:${msg.ts}`, deps.now());
  if (fresh === 0) return false;
  await handleQuestion(deps, claude, { memberId: owner.member_id, channel: msg.channel, text: question });
  return true;
}

/**
 * Routes a `message` event. `msg.text` is already marked by `withClaudeMark`. Never throws: a failure is logged.
 * DM: one nudge. Channel: report block, then the I1 mention check, then Q&A behind the filter; anything else is ignored.
 */
export async function routeChannelMessage(deps: Deps, claude: ClaudeClient, msg: ChannelMsg, opts: RouteOptions = {}): Promise<void> {
  try {
    if (msg.bot_id || !msg.user) return;
    // A DM with an attachment arrives as subtype `file_share`; it still counts as DM text and gets the nudge (FR-CH-019).
    const dmFile = msg.channel_type === "im" && msg.subtype === "file_share";
    if ((msg.subtype && !dmFile) || (!msg.text && !dmFile)) return;
    if (msg.channel_type === "im") {
      if (!msg.app_id) await nudge(deps, msg as ChannelMsg & { user: string });
      return;
    }
    if (!msg.text) return;
    if (msg.text.includes("COPILOT-REPORT")) {
      // A report block counts only in a member's stored channel; in any other channel it is ignored.
      await handleChannelReport(deps, { channel: msg.channel, user: msg.user, text: msg.text, ts: msg.ts, claudeAppId: opts.claudeAppId });
      return;
    }
    // I1 counts only where the poster's own stored channel is the channel it was posted in (Scenario 15).
    if (getMemberChannel(deps.store, msg.user)?.id === msg.channel) {
      await handleChannelMessage(deps, { memberId: msg.user, text: msg.text, ts: msg.ts, claudeAppId: opts.claudeAppId });
    }
    await answerIfQuestion(deps, claude, msg, opts);
  } catch (error) {
    deps.log("channel_message_failed", { channel: msg.channel, error: (error as Error).message });
  }
}

/** Routes an `app_mention` event: answered only when it passes the Q&A filter, once per `ts`. Never throws. */
export async function routeMentionEvent(deps: Deps, claude: ClaudeClient, msg: ChannelMsg, opts: RouteOptions = {}): Promise<void> {
  try {
    await answerIfQuestion(deps, claude, msg, opts);
  } catch (error) {
    deps.log("channel_message_failed", { channel: msg.channel, error: (error as Error).message });
  }
}
