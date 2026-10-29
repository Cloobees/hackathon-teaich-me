import { describe, expect, it } from "vitest";
import { getMetrics } from "../src/aggregate.js";
import { createRows, loadItems, tick } from "../src/checklist.js";
import { seedCohort } from "../src/seedCohort.js";
import { openStore, type Role, type Store } from "../src/store.js";

const config = loadItems();
const now = () => "2026-10-26T10:00:00.000Z";

/** A member with the first `ticked` items done, in order. Completes the member when all are ticked. */
function addMember(store: Store, id: string, role: Role, ticked: number, seeded = 0) {
  store.run("INSERT INTO member (member_id, role, role_chosen_at, seeded) VALUES (?, ?, ?, ?)", id, role, now(), seeded);
  const items = createRows(store, config, id, role);
  items.slice(0, ticked).forEach((item) => tick(store, config, id, item.id, "self-attested", null, now));
}

describe("getMetrics (Scenario 1)", () => {
  it("matches the worked example: 5 started, 3 completed, 60%, 2 in progress", () => {
    const store = openStore(":memory:");
    addMember(store, "T1", "technical", 6);
    addMember(store, "T2", "technical", 6);
    addMember(store, "T3", "technical", 2);
    addMember(store, "N1", "non-technical", 4);
    addMember(store, "N2", "non-technical", 1);
    const m = getMetrics(store, config);

    expect(m.groups.all).toMatchObject({ started: { total: 5 }, completed: { total: 3 }, completionRate: 60, inProgress: { total: 2 } });
    expect(m.groups.technical).toMatchObject({ started: { total: 3 }, completed: { total: 2 }, inProgress: { total: 1 } });
    expect(m.groups["non-technical"]).toMatchObject({ started: { total: 2 }, completed: { total: 1 }, inProgress: { total: 1 } });
    expect(m.groups.all.started.total).toBe(m.groups.technical.started.total + m.groups["non-technical"].started.total);
  });

  it("counts item ticks per group, with n/a (null) where the item does not apply", () => {
    const store = openStore(":memory:");
    addMember(store, "T1", "technical", 6);
    addMember(store, "N1", "non-technical", 4);
    const i5 = getMetrics(store, config).items.find((i) => i.id === "I5");
    expect(i5?.ticks.technical?.total).toBe(1);
    expect(i5?.ticks["non-technical"]).toBeNull();
    expect(getMetrics(store, config).items.find((i) => i.id === "I1")?.ticks.all?.total).toBe(2);
  });

  it("counts ticks per method", () => {
    const store = openStore(":memory:");
    addMember(store, "T1", "technical", 1);
    tick(store, config, "T1", "I2", "validated", "n", now);
    const i2 = getMetrics(store, config).items.find((i) => i.id === "I2");
    expect(i2?.methods).toMatchObject({ validated: { total: 1 }, observed: { total: 0 }, "self-attested": { total: 0 } });
  });
});

describe("most-waiting item (Scenario 6)", () => {
  it("is the lowest-order pending item for the most in-progress members", () => {
    const store = openStore(":memory:");
    addMember(store, "A", "technical", 1); // waits on I2
    addMember(store, "B", "non-technical", 1); // waits on I2
    addMember(store, "C", "technical", 2); // waits on I3
    expect(getMetrics(store, config).groups.all.mostWaiting).toMatchObject({ item: "I2", members: 2 });
  });
  it("a tie goes to the lower item order", () => {
    const store = openStore(":memory:");
    addMember(store, "A", "technical", 1);
    addMember(store, "C", "technical", 2);
    expect(getMetrics(store, config).groups.all.mostWaiting).toMatchObject({ item: "I2", members: 1 });
  });
  it("is null with no one in progress", () => {
    const store = openStore(":memory:");
    addMember(store, "A", "non-technical", 4);
    expect(getMetrics(store, config).groups.all.mostWaiting).toBeNull();
  });
});

describe("empty and seeded stores", () => {
  it("an empty store gives a null rate and zeros (Scenario 5)", () => {
    const m = getMetrics(openStore(":memory:"), config);
    expect(m.groups.all).toMatchObject({ completionRate: null, started: { total: 0 }, completed: { total: 0 }, mostWaiting: null });
  });
  it("20 seeded and 1 live member give a seeded count of 20 (Scenario 3)", () => {
    const store = openStore(":memory:");
    seedCohort(store, config, now);
    addMember(store, "LIVE", "technical", 1);
    const m = getMetrics(store, config);
    expect(m.groups.all.started).toEqual({ total: 21, seeded: 20 });
    expect(m.groups.technical.started).toEqual({ total: 11, seeded: 10 });
  });
  it("no view exposes a member_id column", () => {
    const store = openStore(":memory:");
    for (const view of ["v_started_completed", "v_in_progress", "v_waiting", "v_item_ticks", "v_item_methods"]) {
      const cols = store.all<{ name: string }>(`PRAGMA table_info(${view})`).map((c) => c.name);
      expect(cols.length).toBeGreaterThan(0);
      expect(cols).not.toContain("member_id");
    }
  });
});
