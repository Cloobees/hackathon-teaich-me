import { applyTick, REPORT_ITEMS } from "./checklistMessage.js";
import type { Deps } from "./deps.js";
import { issueNonce, promptFor, validateReport, type ReportItem } from "./report.js";
import type { Role, Store } from "./store.js";

interface MemberRow {
  role: Role | null;
  role_chosen_at: string | null;
  dm_channel_id: string | null;
}
const memberRow = (store: Store, memberId: string) =>
  store.get<MemberRow>("SELECT role, role_chosen_at, dm_channel_id FROM member WHERE member_id = ?", memberId);

/** "Get report prompt" button: a new nonce on every click, bound to the member and item. */
export async function issueReportPrompt(deps: Deps, memberId: string, itemId: string): Promise<void> {
  const member = memberRow(deps.store, memberId);
  if (!member?.role || !member.dm_channel_id || !REPORT_ITEMS.includes(itemId)) return;
  const nonce = issueNonce(deps.store, memberId, itemId, deps.now);
  await deps.slack.chat.postMessage({
    channel: member.dm_channel_id,
    text: `Paste this into your own Claude for ${itemId}:\n\`\`\`\n${promptFor(itemId as ReportItem, nonce)}\n\`\`\`\nThen paste the block it returns here.`,
  });
  deps.log("report_prompt", { member: memberId, item: itemId, outcome: "issued" });
}

/**
 * A DM that holds a report block. Returns false for any other text so the question listener can take it.
 * A valid block ticks `validated` with the nonce as evidence; an invalid one gets one reply naming the rule.
 */
export async function handleReportDm(deps: Deps, input: { memberId: string; channel: string; text: string }): Promise<boolean> {
  if (!input.text.includes("COPILOT-REPORT")) return false;
  const member = memberRow(deps.store, input.memberId);
  if (!member?.role) {
    await deps.slack.chat.postMessage({ channel: input.channel, text: "Choose your role first (run `/onboard`), then paste the block." });
    return true;
  }
  let email: string | undefined;
  try {
    email = (await deps.slack.users.info({ user: input.memberId })).user?.profile?.email;
  } catch (error) {
    deps.log("users_info_failed", { member: input.memberId, error: (error as Error).message });
  }
  const result = validateReport(deps.store, input.text, {
    memberId: input.memberId,
    memberEmail: email,
    roleChosenAt: member.role_chosen_at,
    now: deps.now,
  });
  if (!result.ok) {
    deps.log("report", { member: input.memberId, outcome: result.rule });
    await deps.slack.chat.postMessage({ channel: input.channel, text: result.message });
    return true;
  }
  deps.log("report", { member: input.memberId, item: result.item, outcome: "valid" });
  await applyTick(deps, input.memberId, result.item, "validated", result.nonce);
  return true;
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

/** A channel message that mentions the Claude app ticks I1 `observed`, with the message ts as evidence (route assumed, SP-1). */
export async function handleChannelMessage(
  deps: Deps,
  input: { memberId: string; text: string; ts: string; claudeAppId?: string },
): Promise<void> {
  if (!input.claudeAppId || !input.text.includes(`<@${input.claudeAppId}>`)) return;
  await applyTick(deps, input.memberId, "I1", "observed", input.ts);
}
