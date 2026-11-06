import { readFileSync } from "node:fs";
import { join } from "node:path";
import { safePost } from "./channel.js";
import { getRows, itemsForRole, nextPending, position, type ItemDef } from "./checklist.js";
import type { Deps } from "./deps.js";
import { instructionFor } from "./library.js";
import { sendSkillZip } from "./sendSkillZip.js";
import type { Block } from "./slack.js";
import { getMemberChannel, type Role } from "./store.js";

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
 * The item's instruction from its library file: the `action` value (one or more lines, kept as written), then the
 * `check` line or a confirm line (FR-CL-013). A file with no `action` falls back to its body, so a library without
 * the keys keeps working until the authors add them.
 */
export function instructionText(deps: Deps, item: ItemDef, role: Role, channelId = ""): string {
  try {
    const file = instructionFor(deps.libraryDir, item.id, role);
    if (file?.action) {
      const check = file.check ? `*I check:* ${file.check}` : "*You confirm:* I cannot check this step, so click *I did it* when you have done it.";
      return fill(`*Do this:*\n${file.action}\n${check}`, { channelName: channelId, botMention: deps.botMention ?? "@onboarding-copilot" });
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

// A line `{image:name.png}` in an item file's action marks where an image from assets/ goes. Slack cannot hold a custom
// image inside a line of text, so the instruction is posted in two parts: the text above the line with the image under it
// (one file post), then the text below the line with the button.
const IMAGE_LINE = /^[ \t]*\{image:\s*([\w.-]+)\s*\}[ \t]*\r?\n?/m;

/** Splits instruction text at its image line, or undefined when it has none. */
export function splitAtImage(text: string): { before: string; image: string; after: string } | undefined {
  const m = IMAGE_LINE.exec(text);
  return m ? { before: text.slice(0, m.index).trimEnd(), image: m[1] as string, after: text.slice(m.index + m[0].length) } : undefined;
}

/** The instruction text with its image line removed, for when the image cannot be sent. */
export const withoutImage = (text: string): string => text.replace(IMAGE_LINE, "");

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The ts of the newest message in the channel, or undefined when it cannot be read. */
async function latestTs(deps: Deps, channel: string): Promise<string | undefined> {
  try {
    return (await deps.slack.conversations.history({ channel, limit: 1 })).messages?.[0]?.ts;
  } catch {
    return undefined;
  }
}

/**
 * Slack posts a file's message a moment after the upload call returns, so a message sent straight away can land above it.
 * Waits until the channel shows the file (up to about 6 seconds), or for a fixed 2 seconds when the history cannot be read.
 * Never throws: after the wait the caller posts whatever happens.
 */
async function waitForFilePost(deps: Deps, channel: string, filename: string, after: string | undefined): Promise<void> {
  const sleep = deps.sleep ?? realSleep;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const { messages } = await deps.slack.conversations.history({ channel, limit: 5, ...(after ? { oldest: after } : {}) });
      if (messages?.some((m) => m.files?.some((f) => f.name === filename))) return;
    } catch (error) {
      deps.log("instruction_image_wait_failed", { error: (error as Error).message });
      await sleep(2000);
      return;
    }
    await sleep(500);
  }
  deps.log("instruction_image_wait_timeout", { image: filename });
}

/** The line that thanks the member for the steps a tick just completed, or "" when there are none (FR-CL-010). */
export function doneLine(deps: Deps, role: Role, ticked: string[]): string {
  const items = itemsForRole(deps.items, role);
  const done = ticked.flatMap((id) => items.find((i) => i.id === id) ?? []).map((item) => `*${itemLabel(deps, role, item)}*`);
  return done.length ? `:white_check_mark: Done: ${done.join(" and ")}.` : "";
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
 * The post goes through `safePost`: a Slack error is logged and never thrown, so the rest of the caller's flow still runs
 * (BP-098 review findings 1 and 3). A failed post sends no skill zip, since the member has not seen the step it belongs to.
 */
export async function sendInstruction(deps: Deps, memberId: string, channel: string, role: Role, ticked: string[] = []): Promise<void> {
  const items = itemsForRole(deps.items, role);
  const next = nextPending(items, getRows(deps.store, memberId));
  if (!next) return;

  const mrkdwn = (text: string): Block => ({ type: "section", text: { type: "mrkdwn", text } });
  const ack = doneLine(deps, role, ticked);
  const heading = `${ack ? ":arrow_forward: Next: " : ""}*${itemLabel(deps, role, next)}*`;
  // `{channelName}` carries the member's stored channel id, for every item including I1 (FR-CH-013).
  let instruction = `${heading}\n${instructionText(deps, next, role, getMemberChannel(deps.store, memberId)?.id ?? channel)}`;

  // With an image line, the text above it goes up with the image under it; the rest follows with the button.
  let lead = ack;
  const split = splitAtImage(instruction);
  if (split) {
    try {
      const after = await latestTs(deps, channel);
      await deps.slack.files.uploadV2({
        channel_id: channel,
        file: readFileSync(join(deps.assetsDir ?? "assets", split.image)),
        filename: split.image,
        initial_comment: [ack, split.before].filter(Boolean).join("\n"),
      });
      await waitForFilePost(deps, channel, split.image, after);
      instruction = split.after;
      lead = "";
    } catch (error) {
      deps.log("instruction_image_failed", { member: memberId, item: next.id, image: split.image, error: (error as Error).message });
      instruction = withoutImage(instruction);
    }
  }

  const blocks: Block[] = [...(lead ? [mrkdwn(lead)] : []), ...splitMrkdwn(instruction).map(mrkdwn), { type: "actions", elements: instructionButtons(next) }];
  const posted = await safePost(deps, memberId, { channel, text: [lead, instruction].filter(Boolean).join("\n"), blocks }, "instruction");
  if (!posted) return;
  deps.log("instruction_sent", { member: memberId, item: next.id, outcome: "posted" });
  // The skill step needs the zip in hand, so it follows the I4 instruction (FR-VF-013).
  if (next.id === "I4") await sendSkillZip(deps, memberId);
}
