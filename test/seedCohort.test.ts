import { describe, expect, it } from "vitest";
import { loadItems } from "../src/checklist.js";
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
  it("gives 6 item rows to a technical member and 4 to a non-technical one", () => {
    const store = openStore(":memory:");
    seedCohort(store, config, now);
    expect(store.all("SELECT * FROM checklist_item WHERE member_id = 'SEED-T01'")).toHaveLength(6);
    expect(store.all("SELECT * FROM checklist_item WHERE member_id = 'SEED-N01'")).toHaveLength(4);
  });
  it("is safe to rerun and never touches a live member", () => {
    const store = openStore(":memory:");
    store.run("INSERT INTO member (member_id, role) VALUES ('ULIVE', 'technical')");
    seedCohort(store, config, now);
    seedCohort(store, config, now);
    expect(store.all("SELECT * FROM member WHERE seeded = 1")).toHaveLength(20);
    expect(store.all("SELECT * FROM member WHERE member_id = 'ULIVE'")).toHaveLength(1);
  });
  it("seeded ids are not Slack-shaped", () => {
    const store = openStore(":memory:");
    seedCohort(store, config, now);
    expect(store.all<{ member_id: string }>("SELECT member_id FROM member").every((m) => m.member_id.startsWith("SEED-"))).toBe(true);
  });
});
