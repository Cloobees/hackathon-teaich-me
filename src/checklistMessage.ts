import { createRows, getRows, itemsForRole, nextPending, tick, type ChecklistRow, type ItemDef, type TickResult } from "./checklist.js";
import type { Deps } from "./deps.js";
import { glossaryBlock } from "./glossary.js";
import { instructionButtons, itemLabel, sendInstruction } from "./instruction.js";
import type { Block } from "./slack.js";
import type { Method, Role } from "./store.js";

export { instructionButtons };

const glossaryLine = (deps: Deps) => (deps.glossaryUrl ? `The glossary canvas: ${deps.glossaryUrl}` : "The glossary explains the Claude terms; ask me what a term means.");

/** The checklist message: the glossary link, every item with its status, the first pending item highlighted, a help line. No instruction text. */
export function renderChecklist(deps: Deps, role: Role, items: ItemDef[], rows: ChecklistRow[]): { text: string; blocks: Block[] } {
  const next = nextPending(items, rows);
  const done = rows.filter((r) => r.status === "ticked").length;
  const blocks: Block[] = [];
  if (deps.glossaryUrl) blocks.push(glossaryBlock(deps.glossaryUrl));
  blocks.push(
    { type: "header", text: { type: "plain_text", text: "Your onboarding checklist" } },
    { type: "section", text: { type: "mrkdwn", text: `Role: *${role}*. ${done} of ${items.length} done.` } },
  );
  for (const item of items) {
    const row = rows.find((r) => r.item_id === item.id);
    const label = itemLabel(deps, role, item);
    const line =
      row?.status === "ticked"
        ? `:white_check_mark: ~${label}~ (${row.method})`
        : `${item.id === next?.id ? ":arrow_forward: *Next:* " : ":white_circle: "}*${label}*`;
    blocks.push({ type: "section", text: { type: "mrkdwn", text: line } });
  }
  if (deps.items.help) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: deps.items.help }] });
  return { text: `Your onboarding checklist: ${done} of ${items.length} done`, blocks };
}

/** The Home tab carries the checklist blocks where a bot DM will not pin them (A-CL-009). */
const publishHome = (deps: Deps, memberId: string, blocks: Block[]) =>
  deps.slack.views.publish({ user_id: memberId, view: { type: "home", blocks } });

/** The Home tab: the member's checklist, or a pointer to `/onboard` for someone who has not started. */
export async function handleHomeOpened(deps: Deps, memberId: string): Promise<void> {
  const member = deps.store.get<{ role: Role | null }>("SELECT role FROM member WHERE member_id = ?", memberId);
  const blocks: Block[] = member?.role
    ? renderChecklist(deps, member.role, itemsForRole(deps.items, member.role), getRows(deps.store, memberId)).blocks
    : [
        { type: "header", text: { type: "plain_text", text: "Onboarding Copilot" } },
        { type: "section", text: { type: "mrkdwn", text: "You have not started yet. Type `/onboard` in the *Messages* tab." } },
        ...(deps.glossaryUrl ? [glossaryBlock(deps.glossaryUrl)] : []),
      ];
  await publishHome(deps, memberId, blocks);
}

/** Inserts the rows for the role, posts the one checklist message, stores its timestamp and pins it; a refused pin falls back to the Home tab. */
export async function createChecklist(deps: Deps, memberId: string, role: Role): Promise<void> {
  const items = createRows(deps.store, deps.items, memberId, role);
  const member = deps.store.get<{ channel_id: string | null }>("SELECT channel_id FROM member WHERE member_id = ?", memberId);
  if (!member?.channel_id) {
    deps.log("checklist_no_channel", { member: memberId, outcome: "skipped" });
    return;
  }
  const { text, blocks } = renderChecklist(deps, role, items, getRows(deps.store, memberId));
  const posted = await deps.slack.chat.postMessage({ channel: member.channel_id, text, blocks });
  if (posted.ts) {
    deps.store.run("UPDATE member SET checklist_ts = ? WHERE member_id = ?", posted.ts, memberId);
    try {
      await deps.slack.pins.add({ channel: member.channel_id, timestamp: posted.ts });
    } catch (error) {
      deps.store.run("UPDATE member SET pin_refused = 1 WHERE member_id = ?", memberId);
      deps.log("checklist_pin_refused", { member: memberId, outcome: error instanceof Error ? error.message : "refused" });
      await publishHome(deps, memberId, blocks);
    }
  }
  await sendInstruction(deps, memberId, member.channel_id, role);
  deps.log("checklist_created", { member: memberId, role, outcome: "posted" });
}

/**
 * Every route ticks through here: tick, then edit the checklist message in place (text and blocks together),
 * post a refusal in the channel, then send the completion message once or the next instruction.
 */
export async function applyTick(deps: Deps, memberId: string, itemId: string, method: Method, evidenceRef: string | null): Promise<TickResult> {
  const result = tick(deps.store, deps.items, memberId, itemId, method, evidenceRef, deps.now);
  const member = deps.store.get<{ role: Role | null; channel_id: string | null; checklist_ts: string | null; pin_refused: number | null }>(
    "SELECT role, channel_id, checklist_ts, pin_refused FROM member WHERE member_id = ?",
    memberId,
  );
  deps.log("tick", { member: memberId, item: itemId, method, outcome: result.status });
  if (!member?.role || !member.channel_id) return result;

  if (result.status === "refused") {
    const needed = deps.items.items.find((i) => i.id === result.needs);
    const attempted = deps.items.items.find((i) => i.id === itemId);
    const label = (item: ItemDef | undefined, fallback: string) => (item ? itemLabel(deps, member.role as Role, item) : fallback);
    await deps.slack.chat.postMessage({
      channel: member.channel_id,
      text: `Do *${label(needed, "the earlier step")}* first, then come back to *${label(attempted, "this step")}*.`,
    });
  }
  if (result.status === "ticked") {
    if (member.checklist_ts) {
      const items = deps.items.items.filter((i) => i.roles === "all" || i.roles === member.role);
      const { text, blocks } = renderChecklist(deps, member.role, items, getRows(deps.store, memberId));
      await deps.slack.chat.update({ channel: member.channel_id, ts: member.checklist_ts, text, blocks });
      if (member.pin_refused) await publishHome(deps, memberId, blocks);
    }
    if (result.completed) {
      await deps.slack.chat.postMessage({
        channel: member.channel_id,
        text: `You have finished onboarding. ${glossaryLine(deps)} ${deps.items.help}`.trim(),
      });
    } else {
      await sendInstruction(deps, memberId, member.channel_id, member.role, result.ticked);
    }
  }
  return result;
}
