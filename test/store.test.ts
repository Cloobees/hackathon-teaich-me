import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
    expect(cols).toEqual(expect.arrayContaining(["seeded", "completed_at", "checklist_ts", "role_chosen_at", "started_by", "dm_channel_id", "first_message_ts", "pin_refused"]));
    expect(cols).not.toContain("welcome_ts");
  });
  it("adds pin_refused to a file created with the old member table and keeps its rows (FR-CL-014)", () => {
    const path = join(mkdtempSync(join(tmpdir(), "store-")), "old.db");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE member (
      member_id TEXT PRIMARY KEY, role TEXT, role_chosen_at TEXT, started_by TEXT, dm_channel_id TEXT,
      welcome_ts TEXT, checklist_ts TEXT, completed_at TEXT, seeded INTEGER NOT NULL DEFAULT 0
    )`);
    old.exec("INSERT INTO member (member_id, role, dm_channel_id) VALUES ('U1', 'technical', 'D1')");
    old.close();

    const store = openStore(path);
    expect(store.all<{ name: string }>("PRAGMA table_info(member)").map((c) => c.name)).toContain("pin_refused");
    expect(store.get("SELECT role, dm_channel_id, pin_refused FROM member WHERE member_id = 'U1'")).toMatchObject({ role: "technical", dm_channel_id: "D1", pin_refused: null });
    store.close();
    expect(() => openStore(path).close()).not.toThrow();
  });
  it("renames welcome_ts to first_message_ts in a file created with the old schema and keeps its row (FR-ST-008)", () => {
    const path = join(mkdtempSync(join(tmpdir(), "store-")), "old.db");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE member (
      member_id TEXT PRIMARY KEY, role TEXT, role_chosen_at TEXT, started_by TEXT, dm_channel_id TEXT,
      welcome_ts TEXT, checklist_ts TEXT, completed_at TEXT, seeded INTEGER NOT NULL DEFAULT 0, pin_refused INTEGER
    )`);
    old.exec("INSERT INTO member (member_id, role, welcome_ts) VALUES ('U1', 'technical', '100.001')");
    old.close();

    const store = openStore(path);
    const cols = store.all<{ name: string }>("PRAGMA table_info(member)").map((c) => c.name);
    expect(cols).toContain("first_message_ts");
    expect(cols).not.toContain("welcome_ts");
    expect(store.get("SELECT role, first_message_ts FROM member WHERE member_id = 'U1'")).toMatchObject({ role: "technical", first_message_ts: "100.001" });
    store.close();
    expect(() => openStore(path).close()).not.toThrow();
  });
});
