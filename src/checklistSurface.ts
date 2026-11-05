import type { ChecklistRow } from "./checklist.js";
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

// The canvas implementation and the CHECKLIST_SURFACE flag arrive in BP-103; until then every member gets the message.
export function selectSurface(_deps: Deps, _memberId: string): ChecklistSurface {
  return messageSurface;
}
