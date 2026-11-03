import { describe, expect, it } from "vitest";
import { getMetrics } from "../src/aggregate.js";
import { createRows, loadItems, resetAll, resetMember, tick } from "../src/checklist.js";
import { seedCohort } from "../src/seedCohort.js";
import { openStore } from "../src/store.js";

const config = loadItems();
const now = () => "2026-10-26T10:00:00.000Z";

function setup() {
  const store = openStore(":memory:");
  seedCohort(store, config, now);
  store.run("INSERT INTO member (member_id, role, role_chosen_at) VALUES ('ULIVE', 'technical', ?)", now());
  createRows(store, config, "ULIVE", "technical").slice(0, 2).forEach((item) => tick(store, config, "ULIVE", item.id, "self-attested", null, now));
  const seededRows = () => store.all("SELECT * FROM checklist_item WHERE member_id IN (SELECT member_id FROM member WHERE seeded = 1) ORDER BY member_id, item_id");
  const seededCount = () => store.all("SELECT * FROM member WHERE seeded = 1").length;
  return { store, seededRows, seededCount };
}

describe("reset leaves seeded rows alone (Scenario 9)", () => {
  it("resetAll and resetMember on a seeded id keep the seeded members, their items and the seeded figures", () => {
    const { store, seededRows, seededCount } = setup();
    const rowsBefore = seededRows();
    const seededFigures = (m: ReturnType<typeof getMetrics>) =>
      [m.groups.all, m.groups.technical, m.groups["non-technical"]].map((g) => [g.started.seeded, g.completed.seeded, g.inProgress.seeded]);
    const figuresBefore = seededFigures(getMetrics(store, config));
    expect(seededCount()).toBe(20);
    expect(rowsBefore.length).toBeGreaterThan(0);

    expect(resetAll(store)).toBe(1);
    expect(resetMember(store, "SEED-T01")).toBe(false);

    expect(seededCount()).toBe(20);
    expect(seededRows()).toEqual(rowsBefore);
    expect(seededFigures(getMetrics(store, config))).toEqual(figuresBefore);
  });

  it("clears the live member's role and ticks", () => {
    const { store } = setup();
    resetAll(store);
    expect(store.get("SELECT role FROM member WHERE member_id = 'ULIVE'")).toEqual({ role: null });
    expect(store.all("SELECT * FROM checklist_item WHERE member_id = 'ULIVE'")).toHaveLength(0);
  });
});
