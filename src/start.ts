import { channelLink, ensureMemberChannel, memberChannel } from "./channel.js";
import { createChecklist } from "./checklistMessage.js";
import type { Deps } from "./deps.js";
import { glossaryBlock } from "./glossary.js";
import { firstMessageText, roleDefinitions } from "./library.js";
import { handleReset } from "./reset.js";
import type { Block } from "./slack.js";
import type { Role } from "./store.js";

export type StartOutcome = "sent" | "bot" | "duplicate" | "channel_failed" | "invite_failed" | "existing";

export interface StartInput {
  memberId: string;
  startedBy: "event" | "command";
  isBot?: boolean;
  /** Slack `event_id` (or a command's `trigger_id`); a repeat is dropped. */
  eventId?: string;
}

/**
 * The one start handler for every route (DD-ST-001): bot and duplicate guards, create or reuse the member's channel,
 * post the welcome and the role question in it (FR-CH-003), then send the one link DM (FR-CH-005).
 */
export async function startOnboarding(deps: Deps, input: StartInput): Promise<StartOutcome> {
  const { memberId, startedBy } = input;
  if (input.isBot) return "bot";
  if (input.eventId) {
    const fresh = deps.store.run("INSERT OR IGNORE INTO processed_event (event_id, received_at) VALUES (?, ?)", input.eventId, deps.now());
    if (!fresh) return "duplicate";
  }

  const ensured = await ensureMemberChannel(deps, { memberId, startedBy });
  if (ensured.outcome === "create_failed") {
    deps.log("start_failed", { member: memberId, outcome: "channel_failed" });
    return "channel_failed";
  }
  if (ensured.outcome === "invite_failed") {
    deps.log("start_failed", { member: memberId, outcome: "invite_failed" });
    return "invite_failed";
  }
  const channel = ensured.channelId as string;

  // A repeat start with a stored role posts nothing; after a reset cleared the role the welcome and question go out again (FR-CH-004).
  if (ensured.outcome === "existing" && deps.store.get<{ role: Role | null }>("SELECT role FROM member WHERE member_id = ?", memberId)?.role) {
    deps.log("start", { member: memberId, started_by: startedBy, outcome: "existing" });
    return "existing";
  }

  const defs = roleDefinitions(deps.libraryDir);
  // The welcome is its own message with no button, posted before the role message (FR-ST-008, DD-ST-010).
  // It is read at each start, so an author's edit needs no deploy (FR-AS-008). With nothing to say it is skipped.
  const welcome = firstMessageText(deps.libraryDir, deps.glossaryUrl);
  // The blocks carry the glossary as a button; the text (with the plain link) is the notification fallback.
  const body = firstMessageText(deps.libraryDir);
  const welcomeBlocks: Block[] = [
    ...(body ? [{ type: "section", text: { type: "mrkdwn", text: body } }] : []),
    ...(deps.glossaryUrl ? [glossaryBlock(deps.glossaryUrl)] : []),
  ];
  if (welcome) {
    await deps.slack.chat.postMessage({
      channel,
      text: welcome,
      blocks: welcomeBlocks,
    });
  }
  const question = `Which describes you better?\n• ${defs.technical}\n• ${defs.nonTechnical}`;
  await deps.slack.chat.postMessage({
    channel,
    text: question,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: question } },
      {
        type: "actions",
        elements: [
          { type: "button", action_id: "role_technical", value: "technical", style: "primary", text: { type: "plain_text", text: "Technical" } },
          { type: "button", action_id: "role_non-technical", value: "non-technical", text: { type: "plain_text", text: "Non-technical" } },
        ],
      },
    ],
  });

  if (ensured.outcome === "created" || ensured.outcome === "reinvited") await sendLinkDm(deps, memberId, channel, ensured.teamId);
  deps.log("start", { member: memberId, started_by: startedBy, outcome: "sent" });
  return "sent";
}

/** The one DM of the start flow: a link to the channel. A failure is logged and changes nothing else (FR-CH-005, FR-CH-026). */
async function sendLinkDm(deps: Deps, memberId: string, channel: string, teamId?: string): Promise<void> {
  try {
    const dm = (await deps.slack.conversations.open({ users: memberId })).channel?.id;
    if (!dm) throw new Error("conversations.open returned no channel");
    deps.store.run("UPDATE member SET dm_channel_id = ? WHERE member_id = ?", dm, memberId);
    await deps.slack.chat.postMessage({ channel: dm, text: `Your onboarding channel is ready: ${channelLink(channel, teamId)}. Open it to start.` });
  } catch (error) {
    deps.log("link_dm_failed", { member: memberId, error: (error as Error).message });
  }
}

export const MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/;

export const OPERATOR_ONLY = "The `/onboard-ch @member` form is for operators. Run `/onboard-ch` on its own to start your own checklist.";
export const RESET_OPERATOR_ONLY = "Reset is for operators. Ask an operator to run it for you.";

/** `/onboard-ch` and `/onboard-ch @member`. Returns the private reply for the caller. */
export async function handleOnboard(deps: Deps, input: { callerId: string; text: string; triggerId?: string }): Promise<string> {
  if (input.text.trim().split(/\s+/)[0] === "reset") return handleReset(deps, input);
  const mention = MENTION.exec(input.text)?.[1];
  const target = mention ?? input.callerId;
  if (input.text.trim() && !mention) return "Usage: `/onboard-ch` or `/onboard-ch @member` (operators only).";
  if (target !== input.callerId && !deps.operators.includes(input.callerId)) {
    deps.log("onboard_refused", { member: input.callerId, outcome: "not_operator" });
    return OPERATOR_ONLY;
  }
  const outcome = await startOnboarding(deps, { memberId: target, startedBy: "command", eventId: input.triggerId });
  if (outcome === "channel_failed") return "I could not create the onboarding channel. An operator can check the app log.";
  if (outcome === "invite_failed") return "I created the channel but could not invite the member.";
  const channel = memberChannel(deps.store, target)?.id;
  if (outcome === "existing") return `You already have an onboarding channel: <#${channel}>.`;
  return target === input.callerId ? `I have created your onboarding channel: <#${channel}>. Open it to start.` : `I have created <@${target}>'s onboarding channel.`;
}

/** A role button click. The first click stores the role and creates the checklist; later clicks change nothing. */
export async function handleRole(deps: Deps, input: { memberId: string; role: Role; channel: string; messageTs: string }): Promise<void> {
  const { memberId, role, channel, messageTs } = input;
  // Only a click in the member's own channel counts; the row exists from the start (FR-CH-012).
  const owned = deps.store.get<{ channel_id: string | null }>("SELECT channel_id FROM member WHERE member_id = ?", memberId)?.channel_id;
  if (!owned || owned !== channel) {
    deps.log("role_ignored", { member: memberId, channel, outcome: "not_member_channel" });
    return;
  }
  const stored = deps.store.run("UPDATE member SET role = ?, role_chosen_at = ? WHERE member_id = ? AND role IS NULL", role, deps.now(), memberId) > 0;
  const current = deps.store.get<{ role: Role }>("SELECT role FROM member WHERE member_id = ?", memberId)?.role ?? role;

  const text = `You are set up as *${current}*.`;
  await deps.slack.chat.update({
    channel,
    ts: messageTs,
    text,
    blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
  });
  deps.log("role", { member: memberId, role: current, outcome: stored ? "stored" : "unchanged" });
  if (stored) await createChecklist(deps, memberId, current);
}

/** `team_join`: a human joining the workspace starts onboarding; a bot does not. */
export const handleTeamJoin = (deps: Deps, input: { memberId: string; isBot?: boolean; eventId?: string }) =>
  startOnboarding(deps, { ...input, startedBy: "event" });
