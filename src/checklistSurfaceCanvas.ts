import { channelPost } from "./channel.js";
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

/** Switches the member to the message surface and logs once. Later calls never reach the canvas, so no second line. */
function degrade(deps: Deps, memberId: string, code: string): void {
  deps.store.run("UPDATE member SET canvas_surface = 'message' WHERE member_id = ?", memberId);
  deps.log("canvas_degraded", { member: memberId, outcome: code });
}

export interface CanvasSurfaceOptions {
  /** Wait before the one retry after `canvas_editing_locked`. */
  lockDelayMs?: number;
}

/**
 * The checklist as the channel canvas (FR-CH-010, DD-CH-004). Tick state comes from the store's rows only; the canvas is
 * written, never read. Any canvas error other than a gone channel moves the member to the message surface.
 */
export function makeCanvasSurface(options: CanvasSurfaceOptions = {}): ChecklistSurface {
  const lockDelayMs = options.lockDelayMs ?? 500;

  const edit = async (deps: Deps, canvasId: string, change: Record<string, unknown>): Promise<void> => {
    const call = () => deps.slack.canvases.edit({ canvas_id: canvasId, changes: [change] });
    try {
      await call();
    } catch (error) {
      if (codeOf(error) !== "canvas_editing_locked") throw error;
      await new Promise((resolve) => setTimeout(resolve, lockDelayMs));
      await call();
    }
  };
  const rewrite = (deps: Deps, canvasId: string, markdown: string) =>
    edit(deps, canvasId, { operation: "replace", document_content: { type: "markdown", markdown } });

  /** Runs canvas work. A gone channel is logged and swallowed, any other error degrades. True when the work completed. */
  const guarded = async (deps: Deps, memberId: string, work: () => Promise<void>): Promise<boolean> => {
    try {
      await work();
      return true;
    } catch (error) {
      const code = codeOf(error);
      if (GONE_CODES.includes(code)) deps.log("canvas_channel_gone", { member: memberId, outcome: code });
      else degrade(deps, memberId, code);
      return false;
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
        if (member.canvas_surface === "message") return messageSurface.create(deps, memberId, rows);
        const { role, channel_id: channel } = member;
        const markdown = bodyFor(deps, role, rows);
        let ok: boolean;

        if (member.checklist_canvas_id) {
          // A reset member choosing a role again: the canvas stays and its body is rewritten.
          const canvasId = member.checklist_canvas_id;
          ok = await guarded(deps, memberId, () => rewrite(deps, canvasId, markdown));
          if (ok) deps.store.run("UPDATE member SET canvas_surface = 'canvas' WHERE member_id = ?", memberId);
        } else {
          let canvasId: string | undefined;
          ok = await guarded(deps, memberId, async () => {
            canvasId = (await deps.slack.conversations.canvases.create({ channel_id: channel, document_content: { type: "markdown", markdown } })).canvas_id;
            if (!canvasId) throw new Error("no_canvas_id");
          });
          if (ok && canvasId) {
            deps.store.run("UPDATE member SET checklist_canvas_id = ?, canvas_surface = 'canvas' WHERE member_id = ?", canvasId, memberId);
            await channelPost(deps, memberId, { channel, text: POINTER_TEXT });
          }
        }
        if (!ok && isDegraded(deps, memberId)) return messageSurface.create(deps, memberId, rows);
        return ok ? "canvas" : "message";
      }),

    update: (deps, memberId, rows) =>
      serialised(memberId, async () => {
        const member = target(deps, memberId);
        // The message surface takes over: a member who degraded before any message exists gets the pinned message now.
        const toMessage = () => (target(deps, memberId)?.checklist_ts ? messageSurface.update(deps, memberId, rows) : messageSurface.create(deps, memberId, rows));
        if (member?.canvas_surface === "message") {
          await toMessage();
          return;
        }
        if (!member?.role || !member.channel_id || !member.checklist_canvas_id) {
          deps.log("checklist_no_canvas", { member: memberId, outcome: "skipped" });
          return;
        }
        const { role, checklist_canvas_id: canvasId } = member;
        const ok = await guarded(deps, memberId, async () => {
          for (const item of itemsForRole(deps.items, role)) {
            if (!rows.some((r) => r.item_id === item.id && r.status === "ticked")) continue;
            const label = itemLabel(deps, role, item);
            const found = await deps.slack.canvases.sections.lookup({ canvas_id: canvasId, criteria: { contains_text: label } });
            const sectionId = found.sections?.[0]?.id;
            if (!sectionId) {
              // The line is not in the canvas (a human edited it): rewrite the whole canvas from the store and stop.
              await rewrite(deps, canvasId, bodyFor(deps, role, rows));
              return;
            }
            await edit(deps, canvasId, { operation: "replace", section_id: sectionId, document_content: { type: "markdown", markdown: `- [x] ${label}` } });
          }
        });
        if (!ok && isDegraded(deps, memberId)) await toMessage();
      }),

    reset: (deps, memberId) =>
      serialised(memberId, async () => {
        const member = target(deps, memberId);
        if (member?.canvas_surface === "message") return messageSurface.reset(deps, memberId);
        if (!member?.channel_id || !member.checklist_canvas_id) {
          deps.log("checklist_no_canvas", { member: memberId, outcome: "skipped" });
          return;
        }
        const canvasId = member.checklist_canvas_id;
        const ok = await guarded(deps, memberId, () => rewrite(deps, canvasId, RESET_TEXT));
        if (!ok && isDegraded(deps, memberId)) await messageSurface.reset(deps, memberId);
      }),
  };
}

export const canvasSurface: ChecklistSurface = makeCanvasSurface();
