import { resetAll, resetMember } from "./checklist.js";
import type { Deps } from "./deps.js";
import { MENTION, RESET_OPERATOR_ONLY } from "./start.js";

export const RESET_USAGE = "Usage: `/onboard reset @member` or `/onboard reset all` (operators only).";

/**
 * `/onboard reset @member` and `/onboard reset all`. Returns the private reply for the caller; sends nothing to the member
 * (FR-ST-010, FR-ST-011). Earlier DM messages are left in place (A-ST-005).
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
    const cleared = resetMember(deps.store, mention);
    deps.log("reset", { member: input.callerId, target: mention, outcome: cleared ? "reset" : "nothing_to_reset" });
    return cleared
      ? `Reset <@${mention}>. Their role, checklist and ticks are cleared; earlier DM messages stay. \`/onboard\` starts them again.`
      : `There is nothing to reset for <@${mention}>.`;
  }
  const count = resetAll(deps.store);
  deps.log("reset", { member: input.callerId, target: "all", count, outcome: count ? "reset" : "nothing_to_reset" });
  return count
    ? `Reset ${count} test member${count === 1 ? "" : "s"}. Seeded cohort numbers are unchanged; earlier DM messages stay.`
    : "There is nothing to reset: no test members have onboarding state.";
}
