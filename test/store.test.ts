import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openStore } from "../src/store.js";

describe("store", () => {
  it("creates the tables and views, and keeps rows across a reopen", () => {
    const path = join(mkdtempSync(join(tmpdir(), "store-")), "nested", "copilot.db");
    const first = openStore(path);
    first.run("INSERT INTO member (member_id, role) VALUES (?, ?)", "U1", "technical");
    first.run("INSERT INTO checklist_item (member_id, item_id) VALUES (?, ?)", "U1", "I1");
    first.close();

    const second = openStore(path);
    expect(second.get("SELECT role FROM member WHERE member_id = ?", "U1")).toMatchObject({ role: "technical" });
    expect(second.all("SELECT item_id FROM checklist_item")).toHaveLength(1);
    const names = second.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type IN ('table','view')").map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(["member", "checklist_item", "processed_event", "report_nonce", "v_waiting"]));
    second.close();
  });
  it("rolls a transaction back on error", () => {
    const store = openStore(":memory:");
    expect(() =>
      store.transaction(() => {
        store.run("INSERT INTO member (member_id) VALUES ('U1')");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(store.all("SELECT * FROM member")).toHaveLength(0);
  });
  it("member has the columns the designs name", () => {
    const store = openStore(":memory:");
    const cols = store.all<{ name: string }>("PRAGMA table_info(member)").map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["seeded", "completed_at", "checklist_ts", "role_chosen_at", "started_by", "dm_channel_id", "welcome_ts"]));
  });
});
