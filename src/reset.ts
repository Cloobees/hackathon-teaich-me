import { errorCode, isolated } from "./channel.js";
import { resetMember } from "./checklist.js";
import { selectSurface } from "./checklistSurface.js";
import type { Deps } from "./deps.js";
import { MENTION, RESET_OPERATOR_ONLY } from "./start.js";

export const RESET_USAGE = "Usage: `/onboard-ch reset @member` or `/onboard-ch reset all` (operators only).";

const MAX_NAME = 80; // Slack's channel name limit

/**
 * Retires the member's channel (FR-CH-021): marks it `lost` so the next start makes a new one, renames it with an
 * `-archived-<time>` suffix so the clean name is free again, then archives it. Each Slack step is isolated: a failed
 * rename leaves the name taken (the next start falls back to a `-2` name) and a failed archive leaves the channel open.
 * A channel already `lost` was archived or is gone, so nothing is called for it. A bot cannot unarchive.
 */
async function retireChannel(deps: Deps, memberId: string): Promise<void> {
  const member = deps.store.get<{ channel_id: string | null; channel_name: string | null; channel_state: string | null }>(
    "SELECT channel_id, channel_name, channel_state FROM member WHERE member_id = ?",
    memberId,
  );
  if (!member?.channel_id || member.channel_state === "lost") return;
  const channel = member.channel_id;
  deps.store.run("UPDATE member SET channel_state = 'lost' WHERE member_id = ?", memberId);
  const suffix = `-archived-${deps.now().replace(/\D/g, "").slice(2, 14)}`;
  const name = `${(member.channel_name ?? "onboarding-copilot").slice(0, MAX_NAME - suffix.length).replace(/-+$/, "")}${suffix}`;
  const renamed = await isolated(deps, memberId, "channel_rename_failed", "rename", () => deps.slack.conversations.rename({ channel, name }));
  if (renamed !== undefined) deps.store.run("UPDATE member SET channel_name = ? WHERE member_id = ?", name, memberId);
  const archived = await isolated(deps, memberId, "channel_archive_failed", "archive", () => deps.slack.conversations.archive({ channel }));
  deps.log("channel_retired", { member: memberId, channel, renamed: renamed !== undefined, archived: archived !== undefined });
}

/**
 * Resets one member (FR-CH-021): when a non-seeded member has a checklist, the surface goes back to its empty state first
 * (an error there is logged and never stops the reset), then the role, ticks, completion time and checklist message
 * reference are cleared. The old channel is then renamed and archived (state `lost`), so the next start creates a new
 * channel with the clean name instead of reusing it (FR-CH-021). Returns whether the member was cleared; never throws.
 */
async function resetOne(deps: Deps, memberId: string): Promise<boolean> {
  try {
    const hasChecklist = deps.store.get(
      "SELECT 1 AS found FROM member m WHERE m.member_id = ? AND m.seeded = 0 AND EXISTS (SELECT 1 FROM checklist_item c WHERE c.member_id = m.member_id)",
      memberId,
    );
    if (hasChecklist) {
      try {
        await selectSurface(deps, memberId).reset(deps, memberId);
      } catch (error) {
        deps.log("reset_surface_failed", { member: memberId, error: errorCode(error) });
      }
    }
    const cleared = resetMember(deps.store, memberId);
    if (cleared) await retireChannel(deps, memberId);
    return cleared;
  } catch (error) {
    deps.log("reset_failed", { member: memberId, error: errorCode(error) });
    return false;
  }
}

/**
 * `/onboard-ch reset @member` and `/onboard-ch reset all`. Returns the private reply for the caller; sends nothing to the
 * member (FR-CH-021, FR-CH-022). Earlier messages in the channel are left in place (A-ST-005).
 */
export async function handleReset(deps: Deps, input: { callerId: string; text: string }): Promise<string> {
  if (!deps.operators.includes(input.callerId)) {
    deps.log("reset_refused", { member: input.callerId, outcome: "not_operator" });
    return RESET_OPERATOR_ONLY;
  }
  const rest = input.text.trim().replace(/^reset\b/, "").trim();
  const mention = MENTION.exec(rest)?.[1];
  if (!mention && rest !== "all") return RESET_USAGE;

  if (mention) {
    const cleared = await resetOne(deps, mention);
    deps.log("reset", { member: input.callerId, target: mention, outcome: cleared ? "reset" : "nothing_to_reset" });
    return cleared
      ? `Reset <@${mention}>. Their role, checklist and ticks are cleared; the old channel is renamed and archived. \`/onboard-ch\` starts them again in a new channel.`
      : `There is nothing to reset for <@${mention}>.`;
  }
  // One member at a time, so a failure for one never stops the rest.
  let count = 0;
  for (const { member_id } of deps.store.all<{ member_id: string }>("SELECT member_id FROM member WHERE seeded = 0")) {
    if (await resetOne(deps, member_id)) count++;
  }
  deps.log("reset", { member: input.callerId, target: "all", count, outcome: count ? "reset" : "nothing_to_reset" });
  return count
    ? `Reset ${count} test member${count === 1 ? "" : "s"}. Seeded cohort numbers are unchanged; the old channels are renamed and archived.`
    : "There is nothing to reset: no test members have onboarding state.";
}
