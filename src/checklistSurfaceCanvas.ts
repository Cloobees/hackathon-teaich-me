import { isolated, markChannelLost, safePost } from "./channel.js";
import { itemsForRole, type ChecklistRow } from "./checklist.js";
import { glossaryLine } from "./checklistMessage.js";
import type { ChecklistSurface } from "./checklistSurface.js";
import { messageSurface } from "./checklistSurfaceMessage.js";
import type { Deps } from "./deps.js";
import { itemLabel } from "./instruction.js";
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
  checklist_canvas_id: string | null;
  canvas_surface: string | null;
  checklist_ts: string | null;
}
const target = (deps: Deps, memberId: string) =>
  deps.store.get<Target>("SELECT role, channel_id, checklist_canvas_id, canvas_surface, checklist_ts FROM member WHERE member_id = ?", memberId);

const CANVAS_TITLE = "Onboarding checklist";
const RESET_TEXT = "Checklist reset. A new one follows when you choose your role.";
const POINTER_TEXT = "Your onboarding checklist is the canvas in this channel's Canvas tab. I tick items off there as you complete them.";

/** The whole canvas as markdown: the glossary line first, then one task line per item, ticked from the store's rows. */
function bodyFor(deps: Deps, role: Role, rows: ChecklistRow[]): string {
  const lines = itemsForRole(deps.items, role).map((item) => {
    const ticked = rows.some((r) => r.item_id === item.id && r.status === "ticked");
    return `- [${ticked ? "x" : " "}] ${itemLabel(deps, role, item)}`;
  });
  return [glossaryLine(deps), ...lines].join("\n");
}

/** One call at a time per member: a second tick waits for the first, so two edits never overlap on the canvas. */
const chains = new Map<string, Promise<unknown>>();
function serialised<T>(memberId: string, run: () => Promise<T>): Promise<T> {
  const previous = chains.get(memberId) ?? Promise.resolve();
  const next = previous.then(run, run);
  const tail = next.catch(() => undefined);
  chains.set(memberId, tail);
  void tail.then(() => {
    if (chains.get(memberId) === tail) chains.delete(memberId);
  });
  return next;
}

/** Slack's own detail for an error (needed and provided scopes, messages), short and free of secrets. */
const detailOf = (error: unknown): string | undefined => {
  const data = (error as { data?: { needed?: unknown; provided?: unknown; response_metadata?: { messages?: unknown } } } | null)?.data;
  if (!data) return undefined;
  const parts = [data.needed && `needed=${String(data.needed)}`, data.provided && `provided=${String(data.provided)}`, data.response_metadata?.messages && `messages=${JSON.stringify(data.response_metadata.messages)}`];
  return parts.filter(Boolean).join(" ").slice(0, 300) || undefined;
};

/** Errors that mean "no channel canvas here" (plan tier, a canvas already there, tab creation refused): a standalone canvas shared to the channel works instead. */
const NO_CHANNEL_CANVAS = [
  "team_tier_cannot_create_channel_canvases",
  "free_team_canvas_tab_already_exists",
  "channel_canvas_already_exists",
  "channel_canvas_creation_failed",
  "canvas_tab_creation_failed",
  "canvas_creation_failed",
];

/** Switches the member to the message surface and logs once. Later calls never reach the canvas, so no second line. */
function degrade(deps: Deps, memberId: string, code: string, detail?: string): void {
  deps.store.run("UPDATE member SET canvas_surface = 'message' WHERE member_id = ?", memberId);
  deps.log("canvas_degraded", { member: memberId, outcome: code, detail });
}

/** Retries after the first `canvas_editing_locked`; the wait before retry n is `lockDelayMs * 2^n`. */
const LOCK_RETRIES = 3;

/** An edit that stayed locked through every retry. Never degrades: the item waits in the pending set for the next update. */
class CanvasLocked extends Error {
  constructor() {
    super("canvas_editing_locked");
  }
}

export interface CanvasSurfaceOptions {
  /**
   * The pinned message is kept by the caller (`both` mode): no pointer post, the stored surface becomes `both` on success,
   * and a canvas failure only drops the canvas (the member's surface becomes `message`), never builds a second message.
   */
  alongsideMessage?: boolean;
  /** First wait after `canvas_editing_locked`; it doubles for each of the 3 retries. */
  lockDelayMs?: number;
}

/**
 * The checklist as the channel canvas (FR-CH-010, DD-CH-004). Tick state comes from the store's rows only; the canvas is
 * written, never read. Any canvas error other than a gone channel moves the member to the message surface.
 */
export function makeCanvasSurface(options: CanvasSurfaceOptions = {}): ChecklistSurface {
  const lockDelayMs = options.lockDelayMs ?? 500;
  const alongside = options.alongsideMessage === true;
  const surfaceValue = alongside ? "both" : "canvas";
  /** Item ids per member whose canvas edit stayed locked; the next update writes them again. In memory: the store holds the tick, and a lookup miss redraws the whole canvas. */
  const pending = new Map<string, Set<string>>();
  const pendingOf = (memberId: string): Set<string> => {
    let set = pending.get(memberId);
    if (!set) pending.set(memberId, (set = new Set()));
    return set;
  };

  /** One canvas edit. A lock is retried up to 3 times with doubling waits, then throws `CanvasLocked`; any other error is the caller's. */
  const edit = async (deps: Deps, canvasId: string, change: Record<string, unknown>): Promise<void> => {
    for (let attempt = 0; ; attempt++) {
      try {
        await deps.slack.canvases.edit({ canvas_id: canvasId, changes: [change] });
        return;
      } catch (error) {
        if (codeOf(error) !== "canvas_editing_locked") throw error;
        if (attempt === LOCK_RETRIES) throw new CanvasLocked();
        await new Promise((resolve) => setTimeout(resolve, lockDelayMs * 2 ** attempt));
      }
    }
  };
  const rewrite = (deps: Deps, canvasId: string, markdown: string) =>
    edit(deps, canvasId, { operation: "replace", document_content: { type: "markdown", markdown } });

  /**
   * Runs canvas work. A gone channel is logged and swallowed, a lock that outlasted the retries is logged once and kept
   * (no degrade), any other error degrades. "done" when the work completed, "locked" when only the lock stopped it.
   */
  const guarded = async (deps: Deps, memberId: string, work: () => Promise<void>): Promise<"done" | "locked" | "failed"> => {
    try {
      await work();
      return "done";
    } catch (error) {
      if (error instanceof CanvasLocked) {
        deps.log("canvas_locked", { member: memberId, outcome: "canvas_editing_locked" });
        return "locked";
      }
      const code = codeOf(error);
      if (GONE_CODES.includes(code)) {
        const channel = target(deps, memberId)?.channel_id;
        if (!channel || markChannelLost(deps, memberId, channel, code) !== "marked") deps.log("canvas_channel_gone", { member: memberId, outcome: code });
      } else degrade(deps, memberId, code, detailOf(error));
      return "failed";
    }
  };

  const isDegraded = (deps: Deps, memberId: string) => target(deps, memberId)?.canvas_surface === "message";

  return {
    create: (deps, memberId, rows) =>
      serialised(memberId, async () => {
        const member = target(deps, memberId);
        if (!member?.channel_id || !member.role) {
          deps.log("checklist_no_channel", { member: memberId, outcome: "skipped" });
          return "message";
        }
        if (member.canvas_surface === "message") return alongside ? "message" : messageSurface.create(deps, memberId, rows);
        const { role, channel_id: channel } = member;
        const markdown = bodyFor(deps, role, rows);
        let ok: boolean;
        let standalone: string | undefined;
        pending.delete(memberId);

        if (member.checklist_canvas_id) {
          // A reset member choosing a role again: the canvas stays and its body is rewritten. A lock keeps the canvas; the next
          // tick's lookup misses on the reset text and rewrites the whole body.
          const canvasId = member.checklist_canvas_id;
          ok = (await guarded(deps, memberId, () => rewrite(deps, canvasId, markdown))) !== "failed";
          if (ok) deps.store.run("UPDATE member SET canvas_surface = ? WHERE member_id = ?", surfaceValue, memberId);
        } else {
          let canvasId: string | undefined;
          ok = (await guarded(deps, memberId, async () => {
            try {
              canvasId = (await deps.slack.conversations.canvases.create({ channel_id: channel, title: CANVAS_TITLE, document_content: { type: "markdown", markdown } })).canvas_id;
            } catch (error) {
              // No channel canvas on this plan or channel: make a standalone canvas, share it to the channel and link it there.
              if (!NO_CHANNEL_CANVAS.includes(codeOf(error)) || !deps.canvasUrl) throw error;
              deps.log("canvas_standalone", { member: memberId, outcome: codeOf(error), detail: detailOf(error) });
              canvasId = (await deps.slack.canvases.create({ title: CANVAS_TITLE, document_content: { type: "markdown", markdown } })).canvas_id;
              if (!canvasId) throw new Error("no_canvas_id");
              await deps.slack.canvases.access.set({ canvas_id: canvasId, access_level: "read", channel_ids: [channel] });
              standalone = deps.canvasUrl(canvasId);
            }
            if (!canvasId) throw new Error("no_canvas_id");
          })) === "done";
          if (ok && canvasId) {
            deps.store.run("UPDATE member SET checklist_canvas_id = ?, canvas_surface = ? WHERE member_id = ?", canvasId, surfaceValue, memberId);
            if (standalone) {
              const link = standalone;
              await safePost(deps, memberId, { channel, text: `Your onboarding checklist canvas: ${link}` }, "canvas_link");
              await isolated(deps, memberId, "bookmark_failed", "canvas_bookmark", () =>
                deps.slack.bookmarks.add({ channel_id: channel, title: CANVAS_TITLE, type: "link", link, emoji: ":white_check_mark:" }),
              );
            } else if (!alongside) await safePost(deps, memberId, { channel, text: POINTER_TEXT }, "canvas_pointer");
          }
        }
        if (!ok && isDegraded(deps, memberId) && !alongside) return messageSurface.create(deps, memberId, rows);
        return ok ? "canvas" : "message";
      }),

    update: (deps, memberId, rows, changed) =>
      serialised(memberId, async () => {
        const member = target(deps, memberId);
        // The message surface takes over: a member who degraded before any message exists gets the pinned message now.
        const toMessage = async () => {
          if (alongside) return; // the caller updates the pinned message itself
          await (target(deps, memberId)?.checklist_ts ? messageSurface.update(deps, memberId, rows) : messageSurface.create(deps, memberId, rows));
        };
        if (member?.canvas_surface === "message") {
          await toMessage();
          return;
        }
        if (!member?.role || !member.channel_id || !member.checklist_canvas_id) {
          deps.log("checklist_no_canvas", { member: memberId, outcome: "skipped" });
          return;
        }
        const { role, checklist_canvas_id: canvasId } = member;
        const waiting = pendingOf(memberId);
        const isTicked = (id: string) => rows.some((r) => r.item_id === id && r.status === "ticked");
        // This tick's items (every ticked item when the caller gave none) plus any a lock left pending, in checklist order.
        const wanted = new Set([...(changed ?? rows.filter((r) => r.status === "ticked").map((r) => r.item_id)), ...waiting]);
        const todo = itemsForRole(deps.items, role).filter((item) => wanted.has(item.id) && isTicked(item.id));
        const result = await guarded(deps, memberId, async () => {
          for (const [n, item] of todo.entries()) {
            try {
              const label = itemLabel(deps, role, item);
              const found = await deps.slack.canvases.sections.lookup({ canvas_id: canvasId, criteria: { contains_text: label } });
              const sectionId = found.sections?.[0]?.id;
              if (!sectionId) {
                // The line is not in the canvas (a human edited it): rewrite the whole canvas from the store and stop.
                await rewrite(deps, canvasId, bodyFor(deps, role, rows));
                waiting.clear();
                return;
              }
              await edit(deps, canvasId, { operation: "replace", section_id: sectionId, document_content: { type: "markdown", markdown: `- [x] ${label}` } });
              waiting.delete(item.id);
            } catch (error) {
              if (!(error instanceof CanvasLocked)) throw error;
              // Still locked after the retries: the member is editing the canvas. Keep this and the unwritten items for the next update.
              for (const left of todo.slice(n)) waiting.add(left.id);
              deps.log("canvas_locked", { member: memberId, outcome: "canvas_editing_locked" });
              return;
            }
          }
        });
        if (result === "failed") pending.delete(memberId);
        if (result === "failed" && isDegraded(deps, memberId)) await toMessage();
      }),

    reset: (deps, memberId) =>
      serialised(memberId, async () => {
        const member = target(deps, memberId);
        if (member?.canvas_surface === "message") return alongside ? undefined : messageSurface.reset(deps, memberId);
        if (!member?.channel_id || !member.checklist_canvas_id) {
          deps.log("checklist_no_canvas", { member: memberId, outcome: "skipped" });
          return;
        }
        const canvasId = member.checklist_canvas_id;
        pending.delete(memberId);
        const result = await guarded(deps, memberId, () => rewrite(deps, canvasId, RESET_TEXT));
        if (result === "failed" && isDegraded(deps, memberId) && !alongside) await messageSurface.reset(deps, memberId);
      }),
  };
}

export const canvasSurface: ChecklistSurface = makeCanvasSurface();
