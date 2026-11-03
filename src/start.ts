import { createChecklist } from "./checklistMessage.js";
import type { Deps } from "./deps.js";
import { firstMessageText, roleDefinitions } from "./library.js";
import { handleReset } from "./reset.js";
import type { Role } from "./store.js";

export type StartOutcome = "sent" | "bot" | "duplicate" | "dm_failed";

export interface StartInput {
  memberId: string;
  startedBy: "event" | "command";
  isBot?: boolean;
  /** Slack `event_id` (or a command's `trigger_id`); a repeat is dropped. */
  eventId?: string;
}

/** The one start handler for every route (DD-ST-001): bot and duplicate guards, open the DM, post the role question. */
export async function startOnboarding(deps: Deps, input: StartInput): Promise<StartOutcome> {
  const { memberId, startedBy } = input;
  if (input.isBot) return "bot";
  if (input.eventId) {
    const fresh = deps.store.run("INSERT OR IGNORE INTO processed_event (event_id, received_at) VALUES (?, ?)", input.eventId, deps.now());
    if (!fresh) return "duplicate";
  }

  let dm: string | undefined;
  try {
    dm = (await deps.slack.conversations.open({ users: memberId })).channel?.id;
    if (!dm) throw new Error("conversations.open returned no channel");
  } catch (error) {
    deps.log("start_failed", { member: memberId, error: (error as Error).message, outcome: "dm_failed" });
    return "dm_failed";
  }

  // Insert-if-absent: a second start never changes a stored role or the ticks (DD-ST-002).
  deps.store.run("INSERT OR IGNORE INTO member (member_id, started_by, dm_channel_id) VALUES (?, ?, ?)", memberId, startedBy, dm);

  const defs = roleDefinitions(deps.libraryDir);
  // The first message is read at each start, so an author's edit needs no deploy (FR-AS-008).
  const first = firstMessageText(deps.libraryDir, deps.glossaryUrl);
  const question = `Which describes you better?\n• ${defs.technical}\n• ${defs.nonTechnical}`;
  const posted = await deps.slack.chat.postMessage({
    channel: dm,
    text: [first, question].filter(Boolean).join("\n\n"),
    blocks: [
      ...(first ? [{ type: "section", text: { type: "mrkdwn", text: first } }] : []),
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
  if (posted.ts) deps.store.run("UPDATE member SET first_message_ts = ? WHERE member_id = ?", posted.ts, memberId);
  deps.log("start", { member: memberId, started_by: startedBy, outcome: "sent" });
  return "sent";
}

export const MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/;

export const OPERATOR_ONLY = "The `/onboard @member` form is for operators. Run `/onboard` on its own to start your own checklist.";
export const RESET_OPERATOR_ONLY = "Reset is for operators. Ask an operator to run it for you.";

/** `/onboard` and `/onboard @member`. Returns the private reply for the caller. */
export async function handleOnboard(deps: Deps, input: { callerId: string; text: string; triggerId?: string }): Promise<string> {
  if (input.text.trim().split(/\s+/)[0] === "reset") return handleReset(deps, input);
  const mention = MENTION.exec(input.text)?.[1];
  const target = mention ?? input.callerId;
  if (input.text.trim() && !mention) return "Usage: `/onboard` or `/onboard @member` (operators only).";
  if (target !== input.callerId && !deps.operators.includes(input.callerId)) {
    deps.log("onboard_refused", { member: input.callerId, outcome: "not_operator" });
    return OPERATOR_ONLY;
  }
  const outcome = await startOnboarding(deps, { memberId: target, startedBy: "command", eventId: input.triggerId });
  if (outcome === "dm_failed") return "I could not open a DM with that member.";
  return target === input.callerId ? "I have sent you a DM to start." : `I have sent <@${target}> a DM to start.`;
}

/** A role button click. The first click stores the role and creates the checklist; later clicks change nothing. */
export async function handleRole(deps: Deps, input: { memberId: string; role: Role; channel: string; messageTs: string }): Promise<void> {
  const { memberId, role, channel, messageTs } = input;
  deps.store.run("INSERT OR IGNORE INTO member (member_id, started_by, dm_channel_id) VALUES (?, 'command', ?)", memberId, channel);
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
