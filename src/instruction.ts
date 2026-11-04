import { getRows, itemsForRole, nextPending, position, type ItemDef } from "./checklist.js";
import type { Deps } from "./deps.js";
import { channelName } from "./channelName.js";
import { instructionFor } from "./library.js";
import { sendSkillZip } from "./sendSkillZip.js";
import type { Block } from "./slack.js";
import { getReportChannel, setReportChannel, type Role } from "./store.js";

const MAX_INSTRUCTION = 2500;
// Slack rejects a section block over 3000 characters; stay clear of it (FR-CL-013).
const MAX_SECTION = 2900;
const FENCE = "```";

export const confirmDialog = (item: ItemDef) => ({
  title: { type: "plain_text", text: "Mark as done?" },
  text: { type: "mrkdwn", text: `Confirm you have done *${item.name}*. The copilot cannot check this.` },
  confirm: { type: "plain_text", text: "Yes, I did it" },
  deny: { type: "plain_text", text: "Cancel" },
});

/** Fills `{channelName}` and `{botMention}` wherever they appear (FR-CL-013, D12). */
const fill = (text: string, values: { channelName: string; botMention: string }) =>
  text.replaceAll("{channelName}", values.channelName).replaceAll("{botMention}", values.botMention);

/**
 * The member's report channel name: the stored one, or built from the Slack profile name and stored now. A profile
 * lookup is tried twice; when both fail it is logged and the name falls back to the user id (FR-VF-018). Never rebuilt once stored.
 */
async function memberChannelName(deps: Deps, memberId: string): Promise<string> {
  const stored = getReportChannel(deps.store, memberId)?.name;
  if (stored) return stored;
  let profileName: string | undefined;
  // One retry: a failed lookup would otherwise fix the user-id name for good, and the bind step matches on that name.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const user = (await deps.slack.users.info({ user: memberId })).user;
      profileName = user?.real_name || user?.profile?.real_name || user?.profile?.display_name || undefined;
      break;
    } catch (error) {
      if (attempt === 2) deps.log("users_info_failed", { member: memberId, error: (error as Error).message });
    }
  }
  const name = channelName(profileName, memberId);
  setReportChannel(deps.store, memberId, { name });
  return name;
}

/**
 * The item's instruction from its library file: the `action` value (one or more lines, kept as written), then the
 * `check` line or a confirm line (FR-CL-013). A file with no `action` falls back to its body, so a library without
 * the keys keeps working until the authors add them.
 */
export function instructionText(deps: Deps, item: ItemDef, role: Role, channel = ""): string {
  try {
    const file = instructionFor(deps.libraryDir, item.id, role);
    if (file?.action) {
      const check = file.check ? `*I check:* ${file.check}` : "*You confirm:* I cannot check this step, so click *I did it* when you have done it.";
      return fill(`*Do this:* ${file.action}\n${check}`, { channelName: channel, botMention: deps.botMention ?? "Onboarding Copilot" });
    }
    const text = file?.body;
    if (text) return text.length > MAX_INSTRUCTION ? `${text.slice(0, MAX_INSTRUCTION)}...` : text;
  } catch (error) {
    deps.log("library_error", { item: item.id, error: (error as Error).message });
  }
  return "No instruction is in the library for this step yet.";
}

/**
 * Splits mrkdwn into section texts of at most `max` characters, breaking at line boundaries (a longer line is cut
 * hard). A split inside a ``` fence closes the fence at the end of that text and reopens it at the start of the next.
 */
export function splitMrkdwn(text: string, max = MAX_SECTION): string[] {
  const budget = max - 2 * (FENCE.length + 1); // room for the reopening and the closing fence
  const cut = new RegExp(`[^]{1,${budget}}`, "g");
  const lines = text.split("\n").flatMap((line) => (line.length > budget ? (line.match(cut) as string[]) : [line]));
  const parts: string[] = [];
  let current: string[] = [];
  let carried = 0; // lines at the start of `current` that reopen a fence rather than hold text
  let inFence = false;
  for (const line of lines) {
    if (current.length > carried && current.join("\n").length + 1 + line.length > budget) {
      parts.push([...current, ...(inFence ? [FENCE] : [])].join("\n"));
      current = inFence ? [FENCE] : [];
      carried = current.length;
    }
    current.push(line);
    if ((line.split(FENCE).length - 1) % 2 === 1) inFence = !inFence;
  }
  parts.push(current.join("\n"));
  return parts;
}

/** The buttons of an item's instruction message: "I did it" and nothing else, for every item (FR-VF-001). */
export function instructionButtons(item: ItemDef): Block[] {
  return [{ type: "button", action_id: `attest_${item.id}`, value: item.id, text: { type: "plain_text", text: "I did it" }, confirm: confirmDialog(item) }];
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
  // The channel name is built and stored at the first I1 instruction, then reused (FR-VF-018).
  const instruction = `${heading}\n${instructionText(deps, next, role, await memberChannelName(deps, memberId))}`;

  const blocks: Block[] = [...(ack ? [mrkdwn(ack)] : []), ...splitMrkdwn(instruction).map(mrkdwn), { type: "actions", elements: instructionButtons(next) }];
  await deps.slack.chat.postMessage({ channel, text: [ack, instruction].filter(Boolean).join("\n"), blocks });
  deps.log("instruction_sent", { member: memberId, item: next.id, outcome: "posted" });
  // The skill step needs the zip in hand, so it follows the I4 instruction (FR-VF-013).
  if (next.id === "I4") await sendSkillZip(deps, memberId);
}
