import type { ItemsConfig } from "./checklist.js";
import type { Store } from "./store.js";

// Counts only. Every query reads a v_* view, and no view has a member_id column (DD-DB-001, FR-DB-004).
const ROLES = ["technical", "non-technical"] as const;
type Group = "all" | (typeof ROLES)[number];
const GROUPS: Group[] = ["all", ...ROLES];

/** A figure and how many of the counted members are seeded. */
export interface Count {
  total: number;
  seeded: number;
}
export interface GroupMetrics {
  started: Count;
  completed: Count;
  /** Percent, or null when nobody has started (shown as `n/a`). */
  completionRate: number | null;
  inProgress: Count;
  /** Lowest-order pending item for the most in-progress members; null when none is in progress. */
  mostWaiting: { item: string; name: string; members: number } | null;
}
export interface ItemMetrics {
  id: string;
  name: string;
  /** Tick count per group; null where the item does not apply to the role. */
  ticks: Record<Group, Count | null>;
  methods: Record<"observed" | "validated" | "self-attested", Count>;
}
export interface Metrics {
  groups: Record<Group, GroupMetrics>;
  items: ItemMetrics[];
}

const empty = (): Count => ({ total: 0, seeded: 0 });
const add = (c: Count, n: number, seeded: number) => {
  c.total += n;
  if (seeded) c.seeded += n;
};
const inGroup = (group: Group, role: string) => group === "all" || group === role;

export function getMetrics(store: Store, config: ItemsConfig): Metrics {
  const sc = store.all<{ role: string; seeded: number; started: number; completed: number }>("SELECT role, seeded, started, completed FROM v_started_completed");
  const ip = store.all<{ role: string; seeded: number; in_progress: number }>("SELECT role, seeded, in_progress FROM v_in_progress");
  const waiting = store.all<{ role: string; item_id: string; members: number }>("SELECT role, item_id, SUM(members) AS members FROM v_waiting GROUP BY role, item_id");
  const ticks = store.all<{ role: string; seeded: number; item_id: string; ticks: number }>("SELECT role, seeded, item_id, ticks FROM v_item_ticks");
  const methods = store.all<{ role: string; seeded: number; item_id: string; method: keyof ItemMetrics["methods"]; ticks: number }>("SELECT role, seeded, item_id, method, ticks FROM v_item_methods");

  const groups = {} as Record<Group, GroupMetrics>;
  for (const g of GROUPS) {
    const m: GroupMetrics = { started: empty(), completed: empty(), completionRate: null, inProgress: empty(), mostWaiting: null };
    for (const r of sc.filter((r) => inGroup(g, r.role))) {
      add(m.started, r.started, r.seeded);
      add(m.completed, r.completed, r.seeded);
    }
    for (const r of ip.filter((r) => inGroup(g, r.role))) add(m.inProgress, r.in_progress, r.seeded);
    m.completionRate = m.started.total ? Math.round((m.completed.total / m.started.total) * 1000) / 10 : null;

    const byItem = new Map<string, number>();
    for (const r of waiting.filter((r) => inGroup(g, r.role))) byItem.set(r.item_id, (byItem.get(r.item_id) ?? 0) + r.members);
    // Highest count wins; a tie goes to the lower item order.
    const best = [...byItem.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (best) m.mostWaiting = { item: best[0], name: config.items.find((i) => i.id === best[0])?.name ?? best[0], members: best[1] };
    groups[g] = m;
  }

  const items = config.items.map((def): ItemMetrics => {
    const t = {} as Record<Group, Count | null>;
    for (const g of GROUPS) {
      const applies = g === "all" || def.roles === "all" || def.roles === g;
      const c = empty();
      for (const r of ticks.filter((r) => r.item_id === def.id && inGroup(g, r.role))) add(c, r.ticks, r.seeded);
      t[g] = applies ? c : null;
    }
    const mm = { observed: empty(), validated: empty(), "self-attested": empty() };
    for (const r of methods.filter((r) => r.item_id === def.id)) add(mm[r.method], r.ticks, r.seeded);
    return { id: def.id, name: def.name, ticks: t, methods: mm };
  });
  return { groups, items };
}
