import type { ChecklistRow } from "./checklist.js";
import { canvasSurface } from "./checklistSurfaceCanvas.js";
import { messageSurface } from "./checklistSurfaceMessage.js";
import type { Deps } from "./deps.js";

/** Where the member's checklist is drawn. The store is the only source of tick state; a surface only renders the rows it is given. */
export interface ChecklistSurface {
  /** Builds the checklist for a member whose role was just stored. Returns the surface actually used. */
  create(deps: Deps, memberId: string, items: ChecklistRow[]): Promise<"canvas" | "message">;
  /**
   * Redraws the checklist from the store's rows. Never reads tick state from Slack. `changed` are the item ids ticked in
   * this tick; the canvas rewrites only those (plus any left pending by a lock), all ticked items when it is omitted.
   * The message surface ignores it.
   */
  update(deps: Deps, memberId: string, items: ChecklistRow[], changed?: string[]): Promise<void>;
  /** Back to the empty state after a reset. */
  reset(deps: Deps, memberId: string): Promise<void>;
}

/**
 * The member's stored `canvas_surface` wins. When it is unset, `CHECKLIST_SURFACE` decides (default `message`), except that
 * a member who already has a message checklist (`checklist_ts` set) keeps it when the config is later switched to `canvas`.
 */
export function selectSurface(deps: Deps, memberId: string): ChecklistSurface {
  const member = deps.store.get<{ canvas_surface: string | null; checklist_ts: string | null }>(
    "SELECT canvas_surface, checklist_ts FROM member WHERE member_id = ?",
    memberId,
  );
  const stored = member?.canvas_surface;
  if (stored === "canvas") return canvasSurface;
  if (stored === "message") return messageSurface;
  return deps.checklistSurface === "canvas" && !member?.checklist_ts ? canvasSurface : messageSurface;
}
