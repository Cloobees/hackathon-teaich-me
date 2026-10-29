import { createRows, getRows, nextPending, tick, type ChecklistRow, type ItemDef, type TickResult } from "./checklist.js";
import type { Deps } from "./deps.js";
import { instructionFor } from "./library.js";
import type { Block } from "./slack.js";
import type { Method, Role } from "./store.js";

/** Items whose member can fetch a report prompt (verification design, DD-VF-005). */
export const REPORT_ITEMS = ["I2", "I4", "I6"];
const MAX_INSTRUCTION = 2500;

const confirmDialog = (item: ItemDef) => ({
  title: { type: "plain_text", text: "Mark as done?" },
  text: { type: "mrkdwn", text: `Confirm you have done *${item.name}*. The copilot cannot check this.` },
  confirm: { type: "plain_text", text: "Yes, I did it" },
  deny: { type: "plain_text", text: "Cancel" },
});

function instructionText(deps: Deps, item: ItemDef, role: Role): string {
  try {
    const text = instructionFor(deps.libraryDir, item.id, role)?.body;
    if (text) return text.length > MAX_INSTRUCTION ? `${text.slice(0, MAX_INSTRUCTION)}...` : text;
  } catch (error) {
    deps.log("library_error", { item: item.id, error: (error as Error).message });
  }
  return "No instruction is in the library for this step yet.";
}

/** The checklist message: every item with its status, the first pending item highlighted, a help line. */
export function renderChecklist(deps: Deps, role: Role, items: ItemDef[], rows: ChecklistRow[]): { text: string; blocks: Block[] } {
  const next = nextPending(items, rows);
  const done = rows.filter((r) => r.status === "ticked").length;
  const blocks: Block[] = [
    { type: "header", text: { type: "plain_text", text: "Your onboarding checklist" } },
    { type: "section", text: { type: "mrkdwn", text: `Role: *${role}*. ${done} of ${items.length} done.` } },
  ];
  for (const item of items) {
    const row = rows.find((r) => r.item_id === item.id);
    if (row?.status === "ticked") {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: `:white_check_mark: ~${item.id} ${item.name}~ (${row.method})` } });
      continue;
    }
    const mark = item.id === next?.id ? ":arrow_forward: *Next:* " : ":white_circle: ";
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `${mark}*${item.id} ${item.name}*\n${instructionText(deps, item, role)}` } });
    const buttons: Block[] = [
      { type: "button", action_id: `attest_${item.id}`, value: item.id, text: { type: "plain_text", text: "I did it" }, confirm: confirmDialog(item) },
    ];
    if (REPORT_ITEMS.includes(item.id)) {
      buttons.push({ type: "button", action_id: `report_prompt_${item.id}`, value: item.id, text: { type: "plain_text", text: "Get report prompt" } });
    }
    blocks.push({ type: "actions", elements: buttons });
  }
  if (deps.items.help) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: deps.items.help }] });
  return { text: `Your onboarding checklist: ${done} of ${items.length} done`, blocks };
}

/** Inserts the rows for the role, posts the one checklist message and stores its timestamp. */
export async function createChecklist(deps: Deps, memberId: string, role: Role): Promise<void> {
  const items = createRows(deps.store, deps.items, memberId, role);
  const member = deps.store.get<{ dm_channel_id: string | null }>("SELECT dm_channel_id FROM member WHERE member_id = ?", memberId);
  if (!member?.dm_channel_id) {
    deps.log("checklist_no_dm", { member: memberId, outcome: "skipped" });
    return;
  }
  const { text, blocks } = renderChecklist(deps, role, items, getRows(deps.store, memberId));
  const posted = await deps.slack.chat.postMessage({ channel: member.dm_channel_id, text, blocks });
  if (posted.ts) deps.store.run("UPDATE member SET checklist_ts = ? WHERE member_id = ?", posted.ts, memberId);
  deps.log("checklist_created", { member: memberId, role, outcome: "posted" });
}

const glossaryLine = (deps: Deps) => (deps.glossaryUrl ? `The glossary canvas: ${deps.glossaryUrl}` : "The glossary explains the Claude terms; ask me what a term means.");

/**
 * Every route ticks through here: tick, then edit the checklist message in place (text and blocks together),
 * DM a refusal, or send the completion message once.
 */
export async function applyTick(deps: Deps, memberId: string, itemId: string, method: Method, evidenceRef: string | null): Promise<TickResult> {
  const result = tick(deps.store, deps.items, memberId, itemId, method, evidenceRef, deps.now);
  const member = deps.store.get<{ role: Role | null; dm_channel_id: string | null; checklist_ts: string | null }>(
    "SELECT role, dm_channel_id, checklist_ts FROM member WHERE member_id = ?",
    memberId,
  );
  deps.log("tick", { member: memberId, item: itemId, method, outcome: result.status });
  if (!member?.role || !member.dm_channel_id) return result;

  if (result.status === "refused") {
    const needed = deps.items.items.find((i) => i.id === result.needs);
    await deps.slack.chat.postMessage({
      channel: member.dm_channel_id,
      text: `Do ${result.needs} (${needed?.name ?? "the earlier step"}) first, then come back to ${itemId}.`,
    });
  }
  if (result.status === "ticked") {
    if (member.checklist_ts) {
      const items = deps.items.items.filter((i) => i.roles === "all" || i.roles === member.role);
      const { text, blocks } = renderChecklist(deps, member.role, items, getRows(deps.store, memberId));
      await deps.slack.chat.update({ channel: member.dm_channel_id, ts: member.checklist_ts, text, blocks });
    }
    if (result.completed) {
      await deps.slack.chat.postMessage({
        channel: member.dm_channel_id,
        text: `You have finished onboarding. ${glossaryLine(deps)} ${deps.items.help}`.trim(),
      });
    }
  }
  return result;
}
