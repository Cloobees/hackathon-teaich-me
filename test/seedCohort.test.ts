import { describe, expect, it } from "vitest";
import { itemsForRole, loadItems } from "../src/checklist.js";
import { seedCohort } from "../src/seedCohort.js";
import { openStore } from "../src/store.js";

const config = loadItems();
const now = () => "2026-10-26T10:00:00.000Z";

describe("seedCohort", () => {
  it("writes 20 members, all seeded, 10 per role, with completed and in-progress members in each", () => {
    const store = openStore(":memory:");
    expect(seedCohort(store, config, now)).toBe(20);
    expect(store.all("SELECT * FROM member")).toHaveLength(20);
    expect(store.all("SELECT * FROM member WHERE seeded = 0")).toHaveLength(0);
    for (const role of ["technical", "non-technical"]) {
      expect(store.all("SELECT * FROM member WHERE role = ?", role)).toHaveLength(10);
      expect(store.all("SELECT * FROM member WHERE role = ? AND completed_at IS NOT NULL", role).length).toBeGreaterThan(0);
      expect(store.all("SELECT * FROM member WHERE role = ? AND completed_at IS NULL", role).length).toBeGreaterThan(0);
    }
  });
  it("gives 6 item rows to a technical member and 5 to a non-technical one", () => {
    const store = openStore(":memory:");
    seedCohort(store, config, now);
    expect(store.all("SELECT * FROM checklist_item WHERE member_id = 'SEED-T01'")).toHaveLength(6);
    expect(store.all("SELECT * FROM checklist_item WHERE member_id = 'SEED-N01'")).toHaveLength(5);
  });
  it("ticks I6 as self-attested for every complete member, leaves it pending for the rest, and never seeds an observed I6", () => {
    const store = openStore(":memory:");
    seedCohort(store, config, now);
    for (const role of ["technical", "non-technical"] as const) {
      const complete = store.all<{ member_id: string }>("SELECT member_id FROM member WHERE role = ? AND completed_at IS NOT NULL", role);
      const inProgress = store.all<{ member_id: string }>("SELECT member_id FROM member WHERE role = ? AND completed_at IS NULL", role);
      expect(complete.length).toBe(5);
      for (const { member_id } of complete) {
        expect(store.get("SELECT status, method FROM checklist_item WHERE member_id = ? AND item_id = 'I6'", member_id)).toEqual({ status: "ticked", method: "self-attested" });
        expect(store.all("SELECT * FROM checklist_item WHERE member_id = ? AND status = 'ticked'", member_id)).toHaveLength(itemsForRole(config, role).length);
      }
      for (const { member_id } of inProgress) {
        expect(store.get("SELECT status, method FROM checklist_item WHERE member_id = ? AND item_id = 'I6'", member_id)).toEqual({ status: "pending", method: null });
      }
    }
    expect(store.all("SELECT * FROM checklist_item WHERE item_id = 'I6' AND method = 'observed'")).toHaveLength(0);
  });
  it("is safe to rerun and never touches a live member", () => {
    const store = openStore(":memory:");
    store.run("INSERT INTO member (member_id, role) VALUES ('ULIVE', 'technical')");
    seedCohort(store, config, now);
    seedCohort(store, config, now);
    expect(store.all("SELECT * FROM member WHERE seeded = 1")).toHaveLength(20);
    expect(store.all("SELECT * FROM member WHERE member_id = 'ULIVE'")).toHaveLength(1);
  });
  it("leaves every channel column null for every seeded member (FR-CH-025, Scenario 27)", () => {
    const store = openStore(":memory:");
    seedCohort(store, config, now);
    expect(store.all("SELECT * FROM member WHERE seeded = 1")).toHaveLength(20);
    expect(
      store.all(
        "SELECT member_id FROM member WHERE channel_id IS NOT NULL OR channel_name IS NOT NULL OR channel_state IS NOT NULL OR checklist_canvas_id IS NOT NULL OR canvas_surface IS NOT NULL",
      ),
    ).toHaveLength(0);
  });
  it("seeded ids are not Slack-shaped", () => {
    const store = openStore(":memory:");
    seedCohort(store, config, now);
    expect(store.all<{ member_id: string }>("SELECT member_id FROM member").every((m) => m.member_id.startsWith("SEED-"))).toBe(true);
  });
});
