import { itemsForRole, type ChecklistRow } from "./checklist.js";
import { renderChecklist } from "./checklistMessage.js";
import type { ChecklistSurface } from "./checklistSurface.js";
import type { Deps } from "./deps.js";
import type { Block } from "./slack.js";
import type { Role } from "./store.js";

const GONE_CODES = ["is_archived", "channel_not_found", "not_in_channel"];

/** The Slack error code: `data.error` on a platform error, else the message. */
const codeOf = (error: unknown): string => {
  const data = (error as { data?: { error?: unknown } } | null)?.data;
  if (typeof data?.error === "string") return data.error;
  return error instanceof Error ? error.message : "unknown";
};

interface Target {
  role: Role | null;
  channel_id: string | null;
  checklist_ts: string | null;
}
const target = (deps: Deps, memberId: string) =>
  deps.store.get<Target>("SELECT role, channel_id, checklist_ts FROM member WHERE member_id = ?", memberId);

/**
 * Runs one Slack call. A gone-channel error is logged and swallowed (BP-104 marks the channel lost);
 * any other error is the caller's.
 */
async function guarded(deps: Deps, memberId: string, event: string, call: () => Promise<unknown>): Promise<void> {
  try {
    await call();
  } catch (error) {
    const code = codeOf(error);
    if (!GONE_CODES.includes(code)) throw error;
    deps.log(event, { member: memberId, outcome: code });
  }
}

const RESET_TEXT = "Checklist reset. A new one follows when you choose your role.";
const resetBlocks: Block[] = [{ type: "section", text: { type: "mrkdwn", text: RESET_TEXT } }];

/** The checklist as one pinned message in the member's channel, edited in place. */
export const messageSurface: ChecklistSurface = {
  async create(deps, memberId, rows) {
    const member = target(deps, memberId);
    if (!member?.channel_id || !member.role) {
      deps.log("checklist_no_channel", { member: memberId, outcome: "skipped" });
      return "message";
    }
    const channel = member.channel_id;
    const { text, blocks } = renderChecklist(deps, member.role, itemsForRole(deps.items, member.role), rows);
    let ts: string | undefined;
    await guarded(deps, memberId, "checklist_post_failed", async () => {
      ts = (await deps.slack.chat.postMessage({ channel, text, blocks })).ts;
    });
    if (!ts) return "message";
    deps.store.run("UPDATE member SET checklist_ts = ? WHERE member_id = ?", ts, memberId);
    try {
      await deps.slack.pins.add({ channel, timestamp: ts });
    } catch (error) {
      deps.log("pin_failed", { member: memberId, outcome: codeOf(error) });
    }
    return "message";
  },

  async update(deps, memberId, rows) {
    const member = target(deps, memberId);
    if (!member?.role || !member.channel_id || !member.checklist_ts) {
      deps.log("checklist_no_message", { member: memberId, outcome: "skipped" });
      return;
    }
    const { channel_id: channel, checklist_ts: ts } = member;
    const { text, blocks } = renderChecklist(deps, member.role, itemsForRole(deps.items, member.role), rows);
    // text and blocks together: text alone would wipe the blocks.
    await guarded(deps, memberId, "checklist_update_failed", () => deps.slack.chat.update({ channel, ts, text, blocks }));
  },

  async reset(deps, memberId) {
    const member = target(deps, memberId);
    if (!member?.channel_id || !member.checklist_ts) {
      deps.log("checklist_no_message", { member: memberId, outcome: "skipped" });
      return;
    }
    const { channel_id: channel, checklist_ts: ts } = member;
    await guarded(deps, memberId, "checklist_update_failed", () =>
      deps.slack.chat.update({ channel, ts, text: RESET_TEXT, blocks: resetBlocks }),
    );
  },
};
