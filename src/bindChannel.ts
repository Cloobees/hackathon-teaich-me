import type { Deps } from "./deps.js";
import { setReportChannel } from "./store.js";

// Binds a member's private report channel to the member (FR-VF-019, Scenario 14). The member's own Claude creates the
// channel under the name the app stored (FR-VF-018); when the member invites the app, the app stores the channel id and
// the actual name, and posts one confirmation. The join event is assumed, not proven (A-VF-012, SP-4): the first-message
// fallback binds the same way.

/** The one message the app posts in a bound channel. */
export const BIND_CONFIRMATION =
  "Onboarding Copilot is now watching this channel. When your Claude posts its reports here, I tick the matching steps on your checklist. Go back to Claude and carry on.";

export type BindOutcome = "bound" | "already_bound" | "not_own_join" | "not_author" | "lookup_failed" | "not_private" | "no_match";

export interface BindResult {
  outcome: BindOutcome;
  memberId?: string;
  channelId?: string;
  channelName?: string;
}

interface NamedMember {
  member_id: string;
  report_channel_name: string;
  report_channel_id: string | null;
}

const NAMED = "SELECT member_id, report_channel_name, report_channel_id FROM member WHERE report_channel_name IS NOT NULL";

/**
 * The member a channel belongs to, among members with no bound channel yet (two members can store the same name). The
 * stored name must equal the channel's name, or the name plus `-<digits>` (Slack adds a number to a taken name); exact
 * beats suffixed, and the longest stored name wins among suffixed. Of several candidates the inviter is chosen when
 * they are one, otherwise the first.
 */
function memberForName(rows: NamedMember[], actual: string, inviter?: string): NamedMember | undefined {
  const unbound = rows.filter((r) => !r.report_channel_id);
  const exact = unbound.filter((r) => r.report_channel_name === actual);
  let candidates = exact;
  if (!candidates.length) {
    const suffixed = unbound.filter(
      (r) => actual.startsWith(`${r.report_channel_name}-`) && /^\d+$/.test(actual.slice(r.report_channel_name.length + 1)),
    );
    const longest = Math.max(...suffixed.map((r) => r.report_channel_name.length));
    candidates = suffixed.filter((r) => r.report_channel_name.length === longest);
  }
  return candidates.find((r) => r.member_id === inviter) ?? candidates[0];
}

/** The channel's actual name when it is a private channel; otherwise the outcome that stops the bind. */
async function privateChannelName(deps: Deps, channelId: string): Promise<{ name: string } | { outcome: BindOutcome }> {
  try {
    const channel = (await deps.slack.conversations.info({ channel: channelId })).channel;
    if (!channel?.name) return { outcome: "lookup_failed" };
    if (!channel.is_private && !channel.is_group) return { outcome: "not_private" };
    return { name: channel.name };
  } catch (error) {
    deps.log("bind_channel", { channel: channelId, outcome: "lookup_failed", error: (error as Error).message });
    return { outcome: "lookup_failed" };
  }
}

async function bind(deps: Deps, member: NamedMember, channelId: string, channelName: string, confirm: boolean): Promise<BindResult> {
  const base = { memberId: member.member_id, channelId, channelName };
  setReportChannel(deps.store, member.member_id, { id: channelId, name: channelName });
  if (confirm) {
    try {
      await deps.slack.chat.postMessage({ channel: channelId, text: BIND_CONFIRMATION });
    } catch (error) {
      deps.log("bind_channel", { member: member.member_id, outcome: "confirmation_failed", error: (error as Error).message });
    }
  }
  deps.log("bind_channel", { member: member.member_id, outcome: "bound" });
  return { outcome: "bound", ...base };
}

/** `member_joined_channel`: binds when the joiner is the app itself and the channel is a member's private channel. Anything else is ignored silently. */
export async function handleMemberJoinedChannel(
  deps: Deps,
  input: { event: { user?: string; channel: string; inviter?: string }; botUserId?: string },
): Promise<BindResult> {
  if (!input.botUserId || input.event.user !== input.botUserId) return { outcome: "not_own_join" };
  const bound = deps.store.get<{ member_id: string }>("SELECT member_id FROM member WHERE report_channel_id = ?", input.event.channel);
  if (bound) return { outcome: "already_bound", memberId: bound.member_id, channelId: input.event.channel };
  const found = await privateChannelName(deps, input.event.channel);
  if (!("name" in found)) return { outcome: found.outcome };
  const member = memberForName(deps.store.all<NamedMember>(NAMED), found.name, input.event.inviter);
  if (!member) return { outcome: "no_match" };
  return bind(deps, member, input.event.channel, found.name, true);
}

/**
 * Fallback for a missing join event: the first message in a not-yet-bound channel, written by the member whose stored
 * name the channel carries, binds it and posts no confirmation (requirement note under Scenario 14). The cheap store checks come before the Slack call, so a message in any other channel costs no API call.
 */
export async function bindOnFirstMessage(deps: Deps, input: { memberId: string; channel: string }): Promise<BindResult> {
  const rows = deps.store.all<NamedMember>(NAMED);
  const author = rows.find((r) => r.member_id === input.memberId);
  if (!author) return { outcome: "not_author" };
  if (author.report_channel_id) return { outcome: "already_bound", memberId: author.member_id, channelId: author.report_channel_id };
  if (deps.store.get("SELECT 1 AS bound FROM member WHERE report_channel_id = ?", input.channel)) return { outcome: "already_bound" };
  const found = await privateChannelName(deps, input.channel);
  if (!("name" in found)) return { outcome: found.outcome };
  const member = memberForName(rows, found.name, input.memberId);
  if (!member) return { outcome: "no_match" };
  if (member.member_id !== input.memberId) return { outcome: "not_author" };
  return bind(deps, member, input.channel, found.name, false);
}
