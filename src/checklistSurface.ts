import type { ChecklistRow } from "./checklist.js";
import { canvasSurface } from "./checklistSurfaceCanvas.js";
import { messageSurface } from "./checklistSurfaceMessage.js";
import type { Deps } from "./deps.js";

/** Where the member's checklist is drawn. The store is the only source of tick state; a surface only renders the rows it is given. */
export interface ChecklistSurface {
  /** Builds the checklist for a member whose role was just stored. Returns the surface actually used. */
  create(deps: Deps, memberId: string, items: ChecklistRow[]): Promise<"canvas" | "message">;
  /** Rewrites the checklist from the store's rows. Never reads tick state from Slack. */
  update(deps: Deps, memberId: string, items: ChecklistRow[]): Promise<void>;
  /** Back to the empty state after a reset. */
  reset(deps: Deps, memberId: string): Promise<void>;
}

/** The member's stored `canvas_surface` wins; when it is unset, `CHECKLIST_SURFACE` decides (default `message`). */
export function selectSurface(deps: Deps, memberId: string): ChecklistSurface {
  const stored = deps.store.get<{ canvas_surface: string | null }>("SELECT canvas_surface FROM member WHERE member_id = ?", memberId)?.canvas_surface;
  const choice = stored === "canvas" || stored === "message" ? stored : deps.checklistSurface;
  return choice === "canvas" ? canvasSurface : messageSurface;
}
