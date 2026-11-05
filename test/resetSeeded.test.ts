import { describe, expect, it } from "vitest";
import { getMetrics } from "../src/aggregate.js";
import { createRows, loadItems, resetAll, resetMember, tick } from "../src/checklist.js";
import { handleReset } from "../src/reset.js";
import { seedCohort } from "../src/seedCohort.js";
import { getMemberChannel, openStore, setMemberChannel } from "../src/store.js";
import { makeDeps } from "./helpers.js";

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

  it("clears the live member's role and ticks but keeps its stored channel", () => {
    const { store } = setup();
    setMemberChannel(store, "ULIVE", { id: "GLIVE", name: "onboarding-copilot-live", state: "active" });
    resetAll(store);
    expect(getMemberChannel(store, "ULIVE")).toEqual({ id: "GLIVE", name: "onboarding-copilot-live", state: "active" });
    expect(store.get("SELECT role FROM member WHERE member_id = 'ULIVE'")).toEqual({ role: null });
    expect(store.all("SELECT * FROM checklist_item WHERE member_id = 'ULIVE'")).toHaveLength(0);
  });
});

describe("the operator reset leaves seeded rows alone and keeps the canvas columns (FR-CH-021, FR-CH-022, Scenario 25)", () => {
  it("`reset all` never calls the surface for a seeded member, leaves its rows byte-identical and keeps a live member's canvas columns", async () => {
    const deps = makeDeps();
    seedCohort(deps.store, deps.items, deps.now);
    deps.store.run("UPDATE member SET channel_id = 'CSEED', channel_state = 'active', checklist_ts = '1.1', checklist_canvas_id = 'FSEED', canvas_surface = 'canvas' WHERE member_id = 'SEED-T01'");
    deps.store.run("INSERT INTO member (member_id, role, channel_id, channel_name, channel_state, checklist_ts, checklist_canvas_id, canvas_surface) VALUES ('ULIVE', 'technical', 'CLIVE', 'onboarding-copilot-live', 'active', '2.2', 'FLIVE', 'canvas')");
    createRows(deps.store, deps.items, "ULIVE", "technical");
    deps.fake.canvasBodies.FLIVE = "old body";
    const seeded = () => JSON.stringify(deps.store.all("SELECT * FROM member WHERE seeded = 1 ORDER BY member_id"));
    const seededItems = () => JSON.stringify(deps.store.all("SELECT * FROM checklist_item WHERE member_id LIKE 'SEED-%' ORDER BY member_id, item_id"));
    const [memberBefore, itemsBefore] = [seeded(), seededItems()];

    await expect(handleReset(deps, { callerId: "UOP1", text: "reset all" })).resolves.toContain("Reset 1 test member.");
    expect(deps.fake.calls.map((c) => c.method)).toEqual(["canvases.edit"]);
    expect(deps.fake.calls[0]?.args).toMatchObject({ canvas_id: "FLIVE" });
    expect(seeded()).toBe(memberBefore);
    expect(seededItems()).toBe(itemsBefore);
    expect(deps.store.get("SELECT role, checklist_ts, channel_id, channel_state, checklist_canvas_id, canvas_surface FROM member WHERE member_id = 'ULIVE'")).toEqual({
      role: null,
      checklist_ts: null,
      channel_id: "CLIVE",
      channel_state: "active",
      checklist_canvas_id: "FLIVE",
      canvas_surface: "canvas",
    });
  });

  it("`reset @seeded` says there is nothing to reset and calls nothing", async () => {
    const deps = makeDeps();
    seedCohort(deps.store, deps.items, deps.now);
    deps.store.run("INSERT INTO member (member_id, role, channel_id, channel_state, checklist_ts, seeded) VALUES ('USEED1', 'technical', 'CSEED1', 'active', '3.3', 1)");
    createRows(deps.store, deps.items, "USEED1", "technical");
    const before = JSON.stringify(deps.store.all("SELECT * FROM member WHERE seeded = 1 ORDER BY member_id"));
    await expect(handleReset(deps, { callerId: "UOP1", text: "reset <@USEED1>" })).resolves.toContain("nothing to reset");
    expect(deps.fake.calls).toHaveLength(0);
    expect(JSON.stringify(deps.store.all("SELECT * FROM member WHERE seeded = 1 ORDER BY member_id"))).toBe(before);
  });
});
