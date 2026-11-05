import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { getMemberChannel, openStore, setMemberChannel } from "../src/store.js";

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
  it("adds the report channel columns to a file made without them and keeps its rows (FR-VF-018)", () => {
    const path = join(mkdtempSync(join(tmpdir(), "store-")), "old.db");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE member (
      member_id TEXT PRIMARY KEY, role TEXT, role_chosen_at TEXT, started_by TEXT, dm_channel_id TEXT,
      first_message_ts TEXT, checklist_ts TEXT, completed_at TEXT, seeded INTEGER NOT NULL DEFAULT 0, pin_refused INTEGER
    )`);
    old.exec("INSERT INTO member (member_id, role, dm_channel_id) VALUES ('U1', 'technical', 'D1')");
    old.close();

    const store = openStore(path);
    const cols = store.all<{ name: string }>("PRAGMA table_info(member)").map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["report_channel_name", "report_channel_id"]));
    expect(store.get("SELECT role, dm_channel_id FROM member WHERE member_id = 'U1'")).toMatchObject({ role: "technical", dm_channel_id: "D1" });
    expect(store.get("SELECT report_channel_name, report_channel_id FROM member WHERE member_id = 'U1'")).toEqual({ report_channel_name: null, report_channel_id: null });
    store.close();
    expect(() => openStore(path).close()).not.toThrow();
  });
  it("opens a database that has no report_channel_id column without copying or throwing, and keeps its channel (BP-099)", () => {
    const path = join(mkdtempSync(join(tmpdir(), "store-")), "new.db");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE member (
      member_id TEXT PRIMARY KEY, role TEXT, role_chosen_at TEXT, started_by TEXT, dm_channel_id TEXT,
      first_message_ts TEXT, checklist_ts TEXT, completed_at TEXT, seeded INTEGER NOT NULL DEFAULT 0, pin_refused INTEGER,
      channel_id TEXT, channel_name TEXT, channel_state TEXT, checklist_canvas_id TEXT, canvas_surface TEXT
    )`);
    old.exec("INSERT INTO member (member_id, role, channel_id, channel_name, channel_state) VALUES ('U1', 'technical', 'C-7', 'onboarding-copilot-ann', 'lost')");
    old.close();

    expect(() => openStore(path).close()).not.toThrow();
    const store = openStore(path);
    expect(getMemberChannel(store, "U1")).toEqual({ id: "C-7", name: "onboarding-copilot-ann", state: "lost" });
    store.close();
  });
  it("member has the channel columns (FR-CH-025)", () => {
    const store = openStore(":memory:");
    const cols = store.all<{ name: string }>("PRAGMA table_info(member)").map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["channel_id", "channel_name", "channel_state", "checklist_canvas_id", "canvas_surface"]));
  });
  it("copies the report channel into the channel columns of an old-schema file, keeps old columns, and is idempotent (Scenario 27)", () => {
    const path = join(mkdtempSync(join(tmpdir(), "store-")), "old.db");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE member (
      member_id TEXT PRIMARY KEY, role TEXT, role_chosen_at TEXT, started_by TEXT, dm_channel_id TEXT,
      first_message_ts TEXT, checklist_ts TEXT, completed_at TEXT, seeded INTEGER NOT NULL DEFAULT 0, pin_refused INTEGER,
      report_channel_name TEXT, report_channel_id TEXT
    )`);
    old.exec("INSERT INTO member (member_id, role, dm_channel_id, report_channel_name, report_channel_id) VALUES ('U1', 'technical', 'D1', 'onboarding-copilot-ann', 'G1')");
    old.exec("INSERT INTO member (member_id, role, report_channel_name) VALUES ('U2', 'technical', 'onboarding-copilot-bob')");
    old.exec("INSERT INTO member (member_id, role) VALUES ('U3', 'non-technical')");
    old.close();

    const store = openStore(path);
    expect(getMemberChannel(store, "U1")).toEqual({ id: "G1", name: "onboarding-copilot-ann", state: "active" });
    expect(getMemberChannel(store, "U2")).toEqual({ id: null, name: null, state: null });
    expect(getMemberChannel(store, "U3")).toEqual({ id: null, name: null, state: null });
    expect(store.get("SELECT report_channel_name, report_channel_id FROM member WHERE member_id = 'U1'")).toEqual({ report_channel_name: "onboarding-copilot-ann", report_channel_id: "G1" });
    expect(store.get("SELECT role, dm_channel_id FROM member WHERE member_id = 'U1'")).toMatchObject({ role: "technical", dm_channel_id: "D1" });
    setMemberChannel(store, "U1", { id: "C-9", name: "onboarding-copilot-ann-2", state: "lost" });
    store.close();

    const again = openStore(path);
    expect(getMemberChannel(again, "U1")).toEqual({ id: "C-9", name: "onboarding-copilot-ann-2", state: "lost" });
    expect(again.all("SELECT member_id FROM member")).toHaveLength(3);
    again.close();
  });
  it("loads a seeded row with null channel columns", () => {
    const store = openStore(":memory:");
    store.run("INSERT INTO member (member_id, role, seeded, completed_at) VALUES ('S1', 'technical', 1, '2026-10-20T10:00:00.000Z')");
    expect(getMemberChannel(store, "S1")).toEqual({ id: null, name: null, state: null });
    expect(store.get("SELECT checklist_canvas_id, canvas_surface FROM member WHERE member_id = 'S1'")).toEqual({ checklist_canvas_id: null, canvas_surface: null });
    expect(store.all("SELECT * FROM v_started_completed")).toHaveLength(1);
  });
  it("stores and reads the member channel, and returns undefined for an unknown member", () => {
    const store = openStore(":memory:");
    store.run("INSERT INTO member (member_id) VALUES ('U1')");
    expect(getMemberChannel(store, "U1")).toEqual({ id: null, name: null, state: null });
    setMemberChannel(store, "U1", { id: "C-1", name: "onboarding-copilot-ann", state: "active" });
    expect(getMemberChannel(store, "U1")).toEqual({ id: "C-1", name: "onboarding-copilot-ann", state: "active" });
    setMemberChannel(store, "U1", { id: "C-1", name: "onboarding-copilot-ann", state: "member_left" });
    expect(getMemberChannel(store, "U1")?.state).toBe("member_left");
    expect(getMemberChannel(store, "UNKNOWN")).toBeUndefined();
  });
});
