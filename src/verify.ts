import { channelPost } from "./channel.js";
import { applyTick } from "./checklistMessage.js";
import type { Deps } from "./deps.js";
import { validateReport } from "./report.js";
import type { Role, Store } from "./store.js";

interface MemberRow {
  role: Role | null;
  role_chosen_at: string | null;
}
const memberRow = (store: Store, memberId: string) => store.get<MemberRow>("SELECT role, role_chosen_at FROM member WHERE member_id = ?", memberId);

/** Posts in the member's channel; a lost channel is handled by `channelPost`, any other failure is logged, never thrown. */
async function postInChannel(deps: Deps, memberId: string, channel: string, text: string): Promise<void> {
  try {
    await channelPost(deps, memberId, { channel, text });
  } catch (error) {
    deps.log("report_post_failed", { member: memberId, error: (error as Error).message });
  }
}

/**
 * A message in a channel the app hears that holds a report block. The channel is matched to the member whose stored
 * `channel_id` it is (FR-CH-015): no such member, and the message is ignored with no tick and no post (FR-CH-016).
 * A post by anyone else gets one notice in the channel naming the owner as the only valid author and ticks nothing.
 * A valid block by the owner ticks `validated` with the message ts as evidence; a failure is one message in the channel.
 */
export async function handleChannelReport(deps: Deps, input: { channel: string; user: string; text: string; ts?: string; claudeAppId?: string }): Promise<void> {
  if (!input.text.includes("COPILOT-REPORT")) return;
  const owner = deps.store.get<{ member_id: string }>("SELECT member_id FROM member WHERE channel_id = ?", input.channel);
  if (!owner) return;
  if (input.user !== owner.member_id) {
    deps.log("report", { member: input.user, outcome: "author" });
    await postInChannel(
      deps,
      owner.member_id,
      input.channel,
      `That report was not posted by <@${owner.member_id}>, the only person who can post a report in this channel, so I did not read it.`,
    );
    return;
  }
  const member = memberRow(deps.store, owner.member_id);
  if (!member?.role) {
    deps.log("report", { member: owner.member_id, outcome: "no_role" });
    return;
  }
  let email: string | undefined;
  try {
    email = (await deps.slack.users.info({ user: owner.member_id })).user?.profile?.email;
  } catch (error) {
    deps.log("users_info_failed", { member: owner.member_id, error: (error as Error).message });
  }
  const result = validateReport(input.text, {
    inMemberChannel: true,
    authorIsMember: true,
    memberEmail: email,
    roleChosenAt: member.role_chosen_at,
    claudeAppId: input.claudeAppId,
    harnessRepo: deps.harnessRepo,
  });
  if (!result.ok) {
    deps.log("report", { member: owner.member_id, outcome: result.rule });
    await postInChannel(deps, owner.member_id, input.channel, result.message);
    return;
  }
  deps.log("report", { member: owner.member_id, item: result.item, outcome: "valid" });
  await applyTick(deps, owner.member_id, result.item, "validated", input.ts ?? null);
}

/** A confirmed "I did it" click. A cancelled confirm never reaches the app. */
export const handleAttest = (deps: Deps, memberId: string, itemId: string) => applyTick(deps, memberId, itemId, "self-attested", null);

/** Finds the Claude app's user id once, from users.list. Undefined when absent or the call fails (I1 stays self-attest). */
export async function findClaudeAppId(deps: Pick<Deps, "slack" | "log">): Promise<string | undefined> {
  try {
    let cursor: string | undefined;
    do {
      const page = await deps.slack.users.list({ cursor });
      const hit = page.members?.find((m) => m.is_bot && !m.deleted && /claude/i.test(`${m.name ?? ""} ${m.real_name ?? ""}`));
      if (hit?.id) return hit.id;
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);
  } catch (error) {
    deps.log("claude_app_lookup_failed", { error: (error as Error).message });
  }
  return undefined;
}

/**
 * Some workspaces show the connector footer as plain `*Sent using* Claude` and no `<@...>` mention; Slack still sets the
 * event's `app_id`. When that is the configured Claude app id, the footer is rewritten to the mention form the report
 * and I1 rules read. A member cannot forge `app_id`, so this is no weaker than the mention.
 */
export function withClaudeMark(text: string, eventAppId: string | undefined, claudeAppId: string | undefined): string {
  if (!claudeAppId || eventAppId !== claudeAppId) return text;
  return text.replace(/\s*\*Sent using\*\s*Claude\s*$/, ` *Sent using* <@${claudeAppId}>`);
}

/** A channel message that mentions the Claude app ticks I1 `observed`, with the message ts as evidence (route assumed, SP-1). */
export async function handleChannelMessage(
  deps: Deps,
  input: { memberId: string; text: string; ts: string; claudeAppId?: string },
): Promise<void> {
  if (!input.claudeAppId || !input.text.includes(`<@${input.claudeAppId}>`)) return;
  await applyTick(deps, input.memberId, "I1", "observed", input.ts);
}
