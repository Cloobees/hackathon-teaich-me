import { getRows } from "./checklist.js";
import { applyTick, REPORT_ITEMS } from "./checklistMessage.js";
import type { Deps } from "./deps.js";
import { itemLabel } from "./instruction.js";
import { issueNonce, promptFor, validateReport, type ReportItem } from "./report.js";
import type { Role, Store } from "./store.js";

interface MemberRow {
  role: Role | null;
  role_chosen_at: string | null;
  dm_channel_id: string | null;
}
const memberRow = (store: Store, memberId: string) =>
  store.get<MemberRow>("SELECT role, role_chosen_at, dm_channel_id FROM member WHERE member_id = ?", memberId);

/** The reply that stops a check while item 1 is unticked (DD-VF-008), or undefined when the check may start. "I did it" is never gated. */
export function gateChecks(deps: Deps, memberId: string, role: Role): string | undefined {
  if (getRows(deps.store, memberId).find((row) => row.item_id === "I1")?.status === "ticked") return undefined;
  const first = deps.items.items.find((item) => item.id === "I1");
  return `Item ${first ? itemLabel(deps, role, first) : "1"} comes first, so I cannot run this check yet. Do that step, then ask again. "I did it" still works on this step.`;
}

/** "Get report prompt" button: gated on I1, then a new nonce on every click, bound to the member and item. */
export async function issueReportPrompt(deps: Deps, memberId: string, itemId: string): Promise<void> {
  const member = memberRow(deps.store, memberId);
  const item = deps.items.items.find((i) => i.id === itemId);
  if (!member?.role || !member.dm_channel_id || !item || !REPORT_ITEMS.includes(itemId)) return;
  const dm = (text: string) => deps.slack.chat.postMessage({ channel: member.dm_channel_id as string, text });
  const refusal = gateChecks(deps, memberId, member.role);
  if (refusal) {
    await dm(refusal);
    deps.log("report_prompt", { member: memberId, item: itemId, outcome: "gated" });
    return;
  }
  if (!deps.checkChannelId && !deps.reportPasteFallback) {
    await dm(`The check is not set up yet, so I cannot send a prompt. Use "I did it" on *${itemLabel(deps, member.role, item)}* instead.`);
    deps.log("report_prompt", { member: memberId, item: itemId, outcome: "no_check_channel" });
    return;
  }
  const nonce = issueNonce(deps.store, memberId, itemId, deps.now);
  const label = itemLabel(deps, member.role, item);
  const fence = (channelId?: string) => `\`\`\`\n${promptFor(itemId as ReportItem, nonce, channelId)}\n\`\`\``;
  // Paste fallback (FR-VF-015): for a member whose Claude cannot post through a Slack connector. Off by default.
  await dm(
    deps.reportPasteFallback
      ? `Paste this into your own Claude for *${label}*:\n${fence()}\nThen paste the block it gives you back into this DM with me and I read it here.`
      : `Give this to your own Claude for *${label}*:\n${fence(deps.checkChannelId)}\nYour Claude posts the block in the check channel and I read it there.`,
  );
  deps.log("report_prompt", { member: memberId, item: itemId, outcome: "issued" });
}

/**
 * A DM that holds a report block, read only with the paste fallback on (FR-VF-015). With it off this returns false and
 * posts nothing, so a pasted block ticks nothing. Returns false for any other text so the question listener can take it.
 * A valid block ticks `validated` with the nonce as evidence; an invalid one gets one reply naming the rule.
 */
export async function handleReportDm(deps: Deps, input: { memberId: string; channel: string; text: string }): Promise<boolean> {
  if (!deps.reportPasteFallback || !input.text.includes("COPILOT-REPORT")) return false;
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

/**
 * A check-channel message that holds a report block, written by the member's own Claude through its Slack connector.
 * The author is the member (FR-VF-017), so another member's nonce fails `nonce-member`. A valid block ticks `validated`
 * and posts nothing in the channel; a failure is one DM to the author. The caller has already matched the channel.
 */
export async function handleChannelReport(deps: Deps, input: { memberId: string; text: string }): Promise<void> {
  const member = memberRow(deps.store, input.memberId);
  if (!member?.role || !member.dm_channel_id) {
    deps.log("report", { member: input.memberId, outcome: "no_dm" });
    return;
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
    await deps.slack.chat.postMessage({ channel: member.dm_channel_id, text: result.message });
    return;
  }
  deps.log("report", { member: input.memberId, item: result.item, outcome: "valid" });
  await applyTick(deps, input.memberId, result.item, "validated", result.nonce);
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
