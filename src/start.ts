import { channelLink, ensureMemberChannel, isolated, memberChannel, safePost } from "./channel.js";
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
  return (await runStart(deps, input)).outcome;
}

interface StartResult {
  outcome: StartOutcome;
  /** True when the start made the channel (new, or the member re-entered it); false when it reused an active one. */
  channelCreated: boolean;
}

async function runStart(deps: Deps, input: StartInput): Promise<StartResult> {
  const { memberId, startedBy } = input;
  if (input.isBot) return { outcome: "bot", channelCreated: false };
  if (input.eventId) {
    const fresh = deps.store.run("INSERT OR IGNORE INTO processed_event (event_id, received_at) VALUES (?, ?)", input.eventId, deps.now());
    if (!fresh) return { outcome: "duplicate", channelCreated: false };
  }

  const ensured = await ensureMemberChannel(deps, { memberId, startedBy });
  if (ensured.outcome === "create_failed" || ensured.outcome === "invite_failed") {
    const outcome = ensured.outcome === "create_failed" ? "channel_failed" : "invite_failed";
    deps.log("start_failed", { member: memberId, outcome });
    // A failed start must not burn the event_id: a Slack retry has to run again.
    if (input.eventId) deps.store.run("DELETE FROM processed_event WHERE event_id = ?", input.eventId);
    return { outcome, channelCreated: false };
  }
  const channel = ensured.channelId as string;
  const channelCreated = ensured.outcome === "created" || ensured.outcome === "reinvited";

  const role = deps.store.get<{ role: Role | null }>("SELECT role FROM member WHERE member_id = ?", memberId)?.role;
  if (role) {
    // A replacement channel (the old one was lost) for a member whose role is fixed: the welcome, then the checklist drawn
    // again from the store with its ticks and the next unticked item's instruction. The role question is not asked again (FR-CH-024).
    if (ensured.outcome === "created") {
      await postWelcome(deps, memberId, channel);
      await createChecklist(deps, memberId, role);
      await sendLinkDm(deps, memberId, channel, ensured.teamId);
      deps.log("start", { member: memberId, started_by: startedBy, outcome: "replaced" });
      return { outcome: "sent", channelCreated: true };
    }
    // A member with a role but no checklist for this channel (the replacement's first invite failed, or the first post failed)
    // gets it drawn again from the store, once; one who has a checklist reference gets nothing extra (FR-CH-004, FR-CH-024).
    const refs = deps.store.get<{ checklist_ts: string | null; checklist_canvas_id: string | null }>(
      "SELECT checklist_ts, checklist_canvas_id FROM member WHERE member_id = ?",
      memberId,
    );
    if (!refs?.checklist_ts && !refs?.checklist_canvas_id) await createChecklist(deps, memberId, role);
    // With a role stored the welcome and the role question never go out again, whatever the outcome (FR-CH-004).
    // A member re-entering the channel still gets the one link DM; after a reset cleared the role both posts go out again.
    if (ensured.outcome === "reinvited") await sendLinkDm(deps, memberId, channel, ensured.teamId);
    deps.log("start", { member: memberId, started_by: startedBy, outcome: "existing" });
    return { outcome: "existing", channelCreated };
  }

  const defs = roleDefinitions(deps.libraryDir);
  await postWelcome(deps, memberId, channel);
  const question = `Which describes you better?\n• ${defs.technical}\n• ${defs.nonTechnical}`;
  const asked = await safePost(
    deps,
    memberId,
    {
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
    },
    "role_question",
  );

  if (channelCreated) await sendLinkDm(deps, memberId, channel, ensured.teamId);
  // A failed role question is logged by `safePost`; `/onboard-ch` again posts the welcome and the question again.
  deps.log("start", { member: memberId, started_by: startedBy, outcome: asked ? "sent" : "question_not_posted" });
  return { outcome: "sent", channelCreated };
}

/**
 * The welcome is its own message with no button, posted before the role message (FR-ST-008, DD-ST-010).
 * It is read at each start, so an author's edit needs no deploy (FR-AS-008). With nothing to say it is skipped.
 * A failed post is isolated so the role question still goes out.
 */
async function postWelcome(deps: Deps, memberId: string, channel: string): Promise<void> {
  const welcome = firstMessageText(deps.libraryDir, deps.glossaryUrl);
  // The blocks carry the glossary as a button; the text (with the plain link) is the notification fallback.
  const body = firstMessageText(deps.libraryDir);
  const welcomeBlocks: Block[] = [
    ...(body ? [{ type: "section", text: { type: "mrkdwn", text: body } }] : []),
    ...(deps.glossaryUrl ? [glossaryBlock(deps.glossaryUrl)] : []),
  ];
  if (welcome) await safePost(deps, memberId, { channel, text: welcome, blocks: welcomeBlocks }, "welcome");
}

/** The one DM of the start flow: a link to the channel. A failure is logged and changes nothing else (FR-CH-005, FR-CH-026). */
async function sendLinkDm(deps: Deps, memberId: string, channel: string, teamId?: string): Promise<void> {
  try {
    const dm = (await deps.slack.conversations.open({ users: memberId })).channel?.id;
    if (!dm) throw new Error("conversations.open returned no channel");
    await deps.slack.chat.postMessage({ channel: dm, text: `Your onboarding channel is ready: ${channelLink(channel, teamId)}. Open it to start.` });
    deps.store.run("UPDATE member SET dm_channel_id = ? WHERE member_id = ?", dm, memberId);
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
  const { outcome, channelCreated } = await runStart(deps, { memberId: target, startedBy: "command", eventId: input.triggerId });
  if (outcome === "channel_failed") return "I could not create the onboarding channel. An operator can check the app log.";
  if (outcome === "invite_failed") return "I created the channel but could not invite the member.";
  const channel = memberChannel(deps.store, target)?.id;
  const self = target === input.callerId;
  if (outcome === "existing") return self ? `You already have an onboarding channel: <#${channel}>.` : `<@${target}> already has an onboarding channel: <#${channel}>.`;
  if (!channelCreated) return self ? `I have restarted your onboarding in <#${channel}>.` : `I have restarted <@${target}>'s onboarding in <#${channel}>.`;
  return self ? `I have created your onboarding channel: <#${channel}>. Open it to start.` : `I have created <@${target}>'s onboarding channel.`;
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
  // The role is stored: a failed edit of the question must not stop the checklist from being created.
  await isolated(deps, memberId, "role_update_failed", "role_message", () =>
    deps.slack.chat.update({ channel, ts: messageTs, text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] }),
  );
  deps.log("role", { member: memberId, role: current, outcome: stored ? "stored" : "unchanged" });
  if (stored) await createChecklist(deps, memberId, current);
}

/** `team_join`: a human joining the workspace starts onboarding; a bot does not. */
export const handleTeamJoin = (deps: Deps, input: { memberId: string; isBot?: boolean; eventId?: string }) =>
  startOnboarding(deps, { ...input, startedBy: "event" });
