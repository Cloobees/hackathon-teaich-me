import { itemsForRole, type ItemsConfig } from "./checklist.js";
import type { Method, Role, Store } from "./store.js";

// Items ticked per member, in item order. Technical members have seven items, non-technical five.
// Five completed and five in progress per role, so the dashboard shows the most-waiting item (A-DB-003).
const PROGRESS: Record<Role, number[]> = {
  technical: [7, 7, 7, 7, 7, 5, 4, 3, 2, 1],
  "non-technical": [5, 5, 5, 5, 5, 3, 3, 2, 1, 0],
};
const METHODS: Record<string, Method[]> = {
  I1: ["self-attested", "observed"],
  I2: ["validated", "validated", "self-attested"],
  I3: ["self-attested", "validated"],
  I4: ["validated", "validated", "self-attested"],
  I5: ["self-attested"],
  I6: ["validated", "self-attested"],
  I7: ["self-attested"],
};
const DAY_MS = 86_400_000;

/**
 * Writes 20 members, 10 per role, all flagged `seeded`. The only writer of seeded rows. Reruns replace the
 * seeded rows and never touch a live member. Ids are not Slack ids.
 */
export function seedCohort(store: Store, config: ItemsConfig, now: () => string): number {
  const base = Date.parse(now());
  store.transaction(() => {
    store.run("DELETE FROM checklist_item WHERE member_id IN (SELECT member_id FROM member WHERE seeded = 1)");
    store.run("DELETE FROM member WHERE seeded = 1");
    for (const role of Object.keys(PROGRESS) as Role[]) {
      const items = itemsForRole(config, role);
      PROGRESS[role].forEach((ticked, index) => {
        const id = `SEED-${role === "technical" ? "T" : "N"}${String(index + 1).padStart(2, "0")}`;
        const started = new Date(base - (index + 2) * DAY_MS).toISOString();
        const done = ticked >= items.length;
        store.run(
          "INSERT INTO member (member_id, role, role_chosen_at, started_by, completed_at, seeded) VALUES (?, ?, ?, 'command', ?, 1)",
          id,
          role,
          started,
          done ? new Date(Date.parse(started) + DAY_MS).toISOString() : null,
        );
        items.forEach((item, position) => {
          const isTicked = position < ticked;
          const options = METHODS[item.id] ?? ["self-attested"];
          const method = options[index % options.length] as Method;
          store.run(
            "INSERT INTO checklist_item (member_id, item_id, status, method, ticked_at, evidence_ref) VALUES (?, ?, ?, ?, ?, ?)",
            id,
            item.id,
            isTicked ? "ticked" : "pending",
            isTicked ? method : null,
            isTicked ? new Date(Date.parse(started) + (position + 1) * 3_600_000).toISOString() : null,
            isTicked && method !== "self-attested" ? `seed-${id}-${item.id}` : null,
          );
        });
      });
    }
  });
  return Object.values(PROGRESS).reduce((n, list) => n + list.length, 0);
}
