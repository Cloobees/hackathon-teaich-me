import { applyTick } from "./checklistMessage.js";
import type { Deps } from "./deps.js";
import { validateReport } from "./report.js";
import type { Role, Store } from "./store.js";

interface MemberRow {
  role: Role | null;
  role_chosen_at: string | null;
  dm_channel_id: string | null;
}
const memberRow = (store: Store, memberId: string) =>
  store.get<MemberRow>("SELECT role, role_chosen_at, dm_channel_id FROM member WHERE member_id = ?", memberId);

/**
 * A message in a channel the app hears that holds a report block. The channel is matched to the member whose bound
 * `report_channel_id` it is (FR-VF-012): no such member, and the message is ignored with no tick and no DM.
 * A post by anyone else gets one DM to the poster naming the author rule (FR-VF-017) and ticks nothing. A valid block by
 * the member ticks `validated` with the message ts as evidence and posts nothing in the channel; a failure is one DM to the member.
 */
export async function handleChannelReport(deps: Deps, input: { channel: string; user: string; text: string; ts?: string; claudeAppId?: string }): Promise<void> {
  if (!input.text.includes("COPILOT-REPORT")) return;
  const owner = deps.store.get<{ member_id: string }>("SELECT member_id FROM member WHERE report_channel_id = ?", input.channel);
  if (!owner) return;
  if (input.user !== owner.member_id) {
    const refusal = validateReport(input.text, { inMemberChannel: true, authorIsMember: false, roleChosenAt: null });
    if (refusal.ok) return;
    deps.log("report", { member: input.user, outcome: refusal.rule });
    try {
      const dm = memberRow(deps.store, input.user)?.dm_channel_id ?? (await deps.slack.conversations.open({ users: input.user })).channel?.id;
      if (dm) await deps.slack.chat.postMessage({ channel: dm, text: refusal.message });
    } catch (error) {
      deps.log("report_dm_failed", { member: input.user, error: (error as Error).message });
    }
    return;
  }
  const member = memberRow(deps.store, owner.member_id);
  if (!member?.role || !member.dm_channel_id) {
    deps.log("report", { member: owner.member_id, outcome: "no_dm" });
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
    await deps.slack.chat.postMessage({ channel: member.dm_channel_id, text: result.message });
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
