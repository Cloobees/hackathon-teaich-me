import { channelLink } from "./channel.js";
import { createRows, getRows, nextPending, tick, type ChecklistRow, type ItemDef, type TickResult } from "./checklist.js";
import { selectSurface } from "./checklistSurface.js";
import type { Deps } from "./deps.js";
import { glossaryBlock } from "./glossary.js";
import { instructionButtons, itemLabel, sendInstruction } from "./instruction.js";
import type { Block } from "./slack.js";
import type { Method, Role } from "./store.js";

export { instructionButtons };

export const glossaryLine = (deps: Deps) => (deps.glossaryUrl ? `The glossary canvas: ${deps.glossaryUrl}` : "The glossary explains the Claude terms; ask me what a term means.");

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

/**
 * The Home tab (FR-CH-020, DD-CH-009): one view with a link to the member's channel, or a pointer to `/onboard-ch`
 * for a member with no channel. It holds no checklist. A failing publish is logged and does not throw.
 */
export async function handleHomeOpened(deps: Deps, memberId: string): Promise<void> {
  const member = deps.store.get<{ channel_id: string | null }>("SELECT channel_id FROM member WHERE member_id = ?", memberId);
  const text = member?.channel_id
    ? `Your onboarding channel: ${channelLink(member.channel_id)}. Open it to continue.`
    : "Type `/onboard-ch` to start your onboarding.";
  const blocks: Block[] = [
    { type: "header", text: { type: "plain_text", text: "Onboarding Copilot" } },
    { type: "section", text: { type: "mrkdwn", text } },
  ];
  try {
    await deps.slack.views.publish({ user_id: memberId, view: { type: "home", blocks } });
  } catch (error) {
    deps.log("home_publish_failed", { member: memberId, error: (error as Error).message });
  }
}

/** Inserts the rows for the role, has the selected surface draw the checklist, then sends the first instruction in the member's channel. */
export async function createChecklist(deps: Deps, memberId: string, role: Role): Promise<void> {
  createRows(deps.store, deps.items, memberId, role);
  const member = deps.store.get<{ channel_id: string | null }>("SELECT channel_id FROM member WHERE member_id = ?", memberId);
  if (!member?.channel_id) {
    deps.log("checklist_no_channel", { member: memberId, outcome: "skipped" });
    return;
  }
  await selectSurface(deps, memberId).create(deps, memberId, getRows(deps.store, memberId));
  await sendInstruction(deps, memberId, member.channel_id, role);
  deps.log("checklist_created", { member: memberId, role, outcome: "posted" });
}

/**
 * Every route ticks through here: tick, then the surface rewrites the checklist from the store's rows,
 * post a refusal in the channel, then send the completion message once or the next instruction.
 */
export async function applyTick(deps: Deps, memberId: string, itemId: string, method: Method, evidenceRef: string | null): Promise<TickResult> {
  const result = tick(deps.store, deps.items, memberId, itemId, method, evidenceRef, deps.now);
  const member = deps.store.get<{ role: Role | null; channel_id: string | null }>("SELECT role, channel_id FROM member WHERE member_id = ?", memberId);
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
    await selectSurface(deps, memberId).update(deps, memberId, getRows(deps.store, memberId));
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
