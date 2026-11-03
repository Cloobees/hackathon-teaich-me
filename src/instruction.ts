import { getRows, itemsForRole, nextPending, position, type ItemDef } from "./checklist.js";
import type { Deps } from "./deps.js";
import { instructionFor } from "./library.js";
import { sendSkillZip } from "./sendSkillZip.js";
import type { Block } from "./slack.js";
import type { Role } from "./store.js";

/** Items whose member can fetch a report prompt (verification design, DD-VF-005). */
export const REPORT_ITEMS = ["I2", "I4", "I6"];
const MAX_INSTRUCTION = 2500;

export const confirmDialog = (item: ItemDef) => ({
  title: { type: "plain_text", text: "Mark as done?" },
  text: { type: "mrkdwn", text: `Confirm you have done *${item.name}*. The copilot cannot check this.` },
  confirm: { type: "plain_text", text: "Yes, I did it" },
  deny: { type: "plain_text", text: "Cancel" },
});

/**
 * The item's instruction from its library file: the `action` line, then the `check` line or a confirm line (FR-CL-013).
 * A file with no `action` falls back to its body, so a library without the keys keeps working until the authors add them.
 */
export function instructionText(deps: Deps, item: ItemDef, role: Role): string {
  try {
    const file = instructionFor(deps.libraryDir, item.id, role);
    if (file?.action) {
      const check = file.check ? `*I check:* ${file.check}` : "*You confirm:* I cannot check this step, so click *I did it* when you have done it.";
      return `*Do this:* ${file.action}
${check}`;
    }
    const text = file?.body;
    if (text) return text.length > MAX_INSTRUCTION ? `${text.slice(0, MAX_INSTRUCTION)}...` : text;
  } catch (error) {
    deps.log("library_error", { item: item.id, error: (error as Error).message });
  }
  return "No instruction is in the library for this step yet.";
}

/** The buttons of an item's instruction message: "I did it" for every item, a check button for the items in REPORT_ITEMS (FR-VF-001, FR-VF-004). */
export function instructionButtons(item: ItemDef): Block[] {
  const buttons: Block[] = [
    { type: "button", action_id: `attest_${item.id}`, value: item.id, text: { type: "plain_text", text: "I did it" }, confirm: confirmDialog(item) },
  ];
  if (REPORT_ITEMS.includes(item.id)) {
    buttons.push({ type: "button", action_id: `report_prompt_${item.id}`, value: item.id, text: { type: "plain_text", text: "Get report prompt" } });
  }
  return buttons;
}

/** An item as a member reads it: its position in their checklist and its title, never the id (FR-CL-012). */
export const itemLabel = (deps: Deps, role: Role, item: ItemDef): string => `${position(deps.items, role, item.id)}. ${item.name}`;

/**
 * Posts one instruction message: the first pending item's instruction and its buttons, led by an acknowledgement
 * of the items just ticked when there are any (FR-CL-010, FR-CL-011). Posts nothing when no item is pending.
 */
export async function sendInstruction(deps: Deps, memberId: string, channel: string, role: Role, ticked: string[] = []): Promise<void> {
  const items = itemsForRole(deps.items, role);
  const next = nextPending(items, getRows(deps.store, memberId));
  if (!next) return;

  const done = ticked.flatMap((id) => items.find((i) => i.id === id) ?? []).map((item) => `*${itemLabel(deps, role, item)}*`);
  const mrkdwn = (text: string): Block => ({ type: "section", text: { type: "mrkdwn", text } });
  const ack = done.length ? `:white_check_mark: Done: ${done.join(" and ")}.` : "";
  const heading = `${done.length ? "Next: " : ""}*${itemLabel(deps, role, next)}*`;
  const instruction = `${heading}\n${instructionText(deps, next, role)}`;

  const blocks: Block[] = [...(ack ? [mrkdwn(ack)] : []), mrkdwn(instruction), { type: "actions", elements: instructionButtons(next) }];
  await deps.slack.chat.postMessage({ channel, text: [ack, instruction].filter(Boolean).join("\n"), blocks });
  deps.log("instruction_sent", { member: memberId, item: next.id, outcome: "posted" });
  // The skill step needs the zip in hand, so it follows the I4 instruction (FR-VF-013).
  if (next.id === "I4") await sendSkillZip(deps, memberId);
}
