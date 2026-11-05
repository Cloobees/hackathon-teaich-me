import { errorCode } from "./channel.js";
import { resetMember } from "./checklist.js";
import { selectSurface } from "./checklistSurface.js";
import type { Deps } from "./deps.js";
import { MENTION, RESET_OPERATOR_ONLY } from "./start.js";

export const RESET_USAGE = "Usage: `/onboard-ch reset @member` or `/onboard-ch reset all` (operators only).";

/** Marks the member's channel `lost` so the next start replaces it; the channel itself, and its messages, are left alone. */
function detachChannel(deps: Deps, memberId: string): void {
  const done = deps.store.run("UPDATE member SET channel_state = 'lost' WHERE member_id = ? AND channel_id IS NOT NULL AND channel_state <> 'lost'", memberId);
  if (done > 0) deps.log("channel_detached", { member: memberId, outcome: "reset" });
}

/**
 * Resets one member (FR-CH-021): when a non-seeded member has a checklist, the surface goes back to its empty state first
 * (an error there is logged and never stops the reset), then the role, ticks, completion time and checklist message
 * reference are cleared. The old channel is left in place but detached (state `lost`), so the next start creates a new
 * channel instead of reusing it (FR-CH-021). Returns whether the member was cleared; never throws.
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
    if (cleared) detachChannel(deps, memberId);
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
      ? `Reset <@${mention}>. Their role, checklist and ticks are cleared; the old channel and its messages stay. \`/onboard-ch\` starts them again in a new channel.`
      : `There is nothing to reset for <@${mention}>.`;
  }
  // One member at a time, so a failure for one never stops the rest.
  let count = 0;
  for (const { member_id } of deps.store.all<{ member_id: string }>("SELECT member_id FROM member WHERE seeded = 0")) {
    if (await resetOne(deps, member_id)) count++;
  }
  deps.log("reset", { member: input.callerId, target: "all", count, outcome: count ? "reset" : "nothing_to_reset" });
  return count
    ? `Reset ${count} test member${count === 1 ? "" : "s"}. Seeded cohort numbers are unchanged; the old channels and their messages stay.`
    : "There is nothing to reset: no test members have onboarding state.";
}
