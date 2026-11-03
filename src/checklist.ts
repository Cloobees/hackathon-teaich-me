import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { Method, Role, Store } from "./store.js";

export interface ItemDef {
  id: string;
  name: string;
  roles: "all" | Role;
  order: number;
  needs?: string;
}
export interface ItemsConfig {
  help: string;
  helpChannel: string;
  items: ItemDef[];
}
export interface ChecklistRow {
  item_id: string;
  status: "pending" | "ticked";
  method: Method | null;
  ticked_at: string | null;
  evidence_ref: string | null;
}

export type TickResult =
  | { status: "ticked"; ticked: string[]; completed: boolean }
  | { status: "unchanged" }
  | { status: "refused"; needs: string }
  | { status: "unknown" };

export function loadItems(path = new URL("./items.yaml", import.meta.url)): ItemsConfig {
  const parsed = parse(readFileSync(path, "utf8")) as ItemsConfig;
  const helpChannel = parsed.helpChannel ?? "";
  const fill = (text: string) => text.replaceAll("{helpChannel}", helpChannel);
  const items = parsed.items.map((item) => ({ ...item, name: fill(item.name) })).sort((a, b) => a.order - b.order);
  return { help: fill(parsed.help ?? ""), helpChannel, items };
}

export const itemsForRole = (config: ItemsConfig, role: Role): ItemDef[] =>
  config.items.filter((item) => item.roles === "all" || item.roles === role);

/** The 1-based place of an item in the role's own checklist, or undefined when the role does not have it (FR-CL-012). */
export const position = (config: ItemsConfig, role: Role, itemId: string): number | undefined => {
  const index = itemsForRole(config, role).findIndex((item) => item.id === itemId);
  return index < 0 ? undefined : index + 1;
};

/** Inserts one pending row per item the role needs. Does nothing for rows that exist. */
export function createRows(store: Store, config: ItemsConfig, memberId: string, role: Role): ItemDef[] {
  const items = itemsForRole(config, role);
  store.transaction(() => {
    for (const item of items) {
      store.run("INSERT OR IGNORE INTO checklist_item (member_id, item_id) VALUES (?, ?)", memberId, item.id);
    }
  });
  return items;
}

export const getRows = (store: Store, memberId: string): ChecklistRow[] =>
  store.all<ChecklistRow>(
    "SELECT item_id, status, method, ticked_at, evidence_ref FROM checklist_item WHERE member_id = ? ORDER BY item_id",
    memberId,
  );

/**
 * Puts a test member back to before the role question (FR-CL-014): no checklist rows, no report nonces, role,
 * checklist message and completion cleared. The DM channel stays, so a restart needs no `conversations.open`.
 * A seeded member is never touched. Returns whether the member was cleared.
 */
export function resetMember(store: Store, memberId: string): boolean {
  return store.transaction(() => {
    const cleared =
      store.run(
        "UPDATE member SET role = NULL, role_chosen_at = NULL, completed_at = NULL, checklist_ts = NULL, pin_refused = NULL WHERE member_id = ? AND seeded = 0",
        memberId,
      ) > 0;
    if (cleared) {
      store.run("DELETE FROM checklist_item WHERE member_id = ?", memberId);
      store.run("DELETE FROM report_nonce WHERE member_id = ?", memberId);
    }
    return cleared;
  });
}

/** Resets every unseeded member. Returns how many it cleared. */
export const resetAll = (store: Store): number =>
  store
    .all<{ member_id: string }>("SELECT member_id FROM member WHERE seeded = 0")
    .filter(({ member_id }) => resetMember(store, member_id)).length;

/** The lowest-order pending item, or undefined when none is pending. */
export const nextPending = (items: ItemDef[], rows: ChecklistRow[]): ItemDef | undefined =>
  items.find((item) => rows.some((row) => row.item_id === item.id && row.status === "pending"));

/**
 * The only writer of tick state (DD-CL-002). A validated tick of an item whose `needs` is pending ticks both
 * rows in one transaction with one evidence reference (FR-CL-009). Completion is set in the same transaction.
 */
export function tick(
  store: Store,
  config: ItemsConfig,
  memberId: string,
  itemId: string,
  method: Method,
  evidenceRef: string | null,
  now: () => string,
): TickResult {
  const def = config.items.find((item) => item.id === itemId);
  const rows = getRows(store, memberId);
  const row = rows.find((r) => r.item_id === itemId);
  if (!def || !row) return { status: "unknown" };
  if (row.status === "ticked") return { status: "unchanged" };

  const needsPending = def.needs && rows.some((r) => r.item_id === def.needs && r.status === "pending");
  if (needsPending && method !== "validated") return { status: "refused", needs: def.needs as string };

  const toTick = needsPending ? [def.needs as string, itemId] : [itemId];
  const ts = now();
  return store.transaction(() => {
    for (const id of toTick) {
      store.run(
        "UPDATE checklist_item SET status = 'ticked', method = ?, ticked_at = ?, evidence_ref = ? WHERE member_id = ? AND item_id = ? AND status = 'pending'",
        method,
        ts,
        evidenceRef,
        memberId,
        id,
      );
    }
    const pending = store.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM checklist_item WHERE member_id = ? AND status = 'pending'",
      memberId,
    );
    let completed = false;
    if (pending?.n === 0) {
      completed = store.run("UPDATE member SET completed_at = ? WHERE member_id = ? AND completed_at IS NULL", ts, memberId) > 0;
    }
    return { status: "ticked", ticked: toTick, completed } as const;
  });
}
