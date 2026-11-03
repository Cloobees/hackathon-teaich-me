import { describe, expect, it } from "vitest";
import { getMetrics } from "../src/aggregate.js";
import { createRows, loadItems, resetAll, resetMember, tick } from "../src/checklist.js";
import { seedCohort } from "../src/seedCohort.js";
import { openStore } from "../src/store.js";

const config = loadItems();
const now = () => "2026-10-26T10:00:00.000Z";
const LIVE = ["ULIVE1", "ULIVE2", "ULIVE3"];
const VIEWS = ["v_started_completed", "v_in_progress", "v_waiting", "v_item_ticks", "v_item_methods"];

/** 20 seeded members plus 3 live members with a role; the first two hold ticks. */
function setup() {
  const store = openStore(":memory:");
  seedCohort(store, config, now);
  LIVE.forEach((id, index) => {
    store.run("INSERT INTO member (member_id, role, role_chosen_at) VALUES (?, 'technical', ?)", id, now());
    createRows(store, config, id, "technical")
      .slice(0, index === 2 ? 0 : 2)
      .forEach((item) => tick(store, config, id, item.id, "self-attested", null, now));
  });
  return store;
}

describe("dashboard figures after a reset (Scenario 9)", () => {
  it("reset all leaves Started at 20 seeded and the seeded completed and in progress counts as they were", () => {
    const store = setup();
    const before = getMetrics(store, config).groups.all;
    expect(before.started).toEqual({ total: 23, seeded: 20 });

    resetAll(store);
    const after = getMetrics(store, config).groups.all;
    expect(after.started).toEqual({ total: 20, seeded: 20 });
    expect(after.completed.seeded).toBe(before.completed.seeded);
    expect(after.inProgress.seeded).toBe(before.inProgress.seeded);
    expect(after.completed.total).toBe(after.completed.seeded);
    expect(after.inProgress.total).toBe(after.inProgress.seeded);
  });

  it("reset of one live member on a fresh store takes Started from 23 to 22 with 20 seeded", () => {
    const store = setup();
    const before = getMetrics(store, config).groups.all;
    expect(resetMember(store, "ULIVE1")).toBe(true);
    const after = getMetrics(store, config).groups.all;
    expect(after.started).toEqual({ total: 22, seeded: 20 });
    expect(after.completed.seeded).toBe(before.completed.seeded);
    expect(after.inProgress.seeded).toBe(before.inProgress.seeded);
  });

  it("no v_* view row has a live member after the reset", () => {
    const store = setup();
    resetAll(store);
    const live = store.all("SELECT member_id FROM member WHERE seeded = 0 AND role IS NOT NULL");
    expect(live).toHaveLength(0);
    for (const view of VIEWS) {
      expect(store.all<{ seeded: number }>(`SELECT seeded FROM ${view}`).every((row) => row.seeded === 1), view).toBe(true);
    }
  });

  it("resetting a seeded member id changes no figure", () => {
    const store = setup();
    const before = JSON.stringify(getMetrics(store, config));
    expect(resetMember(store, "SEED-T01")).toBe(false);
    expect(JSON.stringify(getMetrics(store, config))).toBe(before);
    expect(getMetrics(store, config).groups.all.started).toEqual({ total: 23, seeded: 20 });
  });
});
