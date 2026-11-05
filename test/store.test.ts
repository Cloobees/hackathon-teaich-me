import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { getMemberChannel, openStore, setMemberChannel, type Store } from "../src/store.js";

// Deliberate OLD-schema fixtures: these build member tables as earlier versions of the app made them (BP-108).
const RETIRED = ["report_channel_id", "report_channel_name", "first_message_ts", "welcome_ts", "pin_refused"];
const BASE = "member_id TEXT PRIMARY KEY, role TEXT, role_chosen_at TEXT, started_by TEXT, dm_channel_id TEXT, checklist_ts TEXT, completed_at TEXT, seeded INTEGER NOT NULL DEFAULT 0";

const columnsOf = (store: Store) => store.all<{ name: string }>("PRAGMA table_info(member)").map((c) => c.name);
const retiredIn = (store: Store) => columnsOf(store).filter((c) => RETIRED.includes(c));
const snapshot = (store: Store) => ({
  columns: columnsOf(store),
  members: store.all("SELECT * FROM member ORDER BY member_id"),
  schema: store.all("SELECT type, name FROM sqlite_master ORDER BY type, name"),
});

/** Writes a database file whose member table has the given columns, then runs the statements; returns its path. */
function oldDb(memberColumns: string, statements: string[]): string {
  const path = join(mkdtempSync(join(tmpdir(), "store-")), "old.db");
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE member (${memberColumns})`);
  for (const statement of statements) old.exec(statement);
  old.close();
  return path;
}

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
  it("member has the columns the designs name and none of the retired ones (FR-CH-025)", () => {
    const store = openStore(":memory:");
    expect(columnsOf(store)).toEqual(expect.arrayContaining(["seeded", "completed_at", "checklist_ts", "role_chosen_at", "started_by", "dm_channel_id"]));
    expect(retiredIn(store)).toEqual([]);
  });
  it("member has the channel columns (FR-CH-025)", () => {
    const store = openStore(":memory:");
    expect(columnsOf(store)).toEqual(expect.arrayContaining(["channel_id", "channel_name", "channel_state", "checklist_canvas_id", "canvas_surface"]));
  });
  it("a fresh database has none of the retired columns, in memory or on disk (BP-108)", () => {
    const path = join(mkdtempSync(join(tmpdir(), "store-")), "fresh.db");
    for (const target of [":memory:", path]) {
      const store = openStore(target);
      expect(retiredIn(store)).toEqual([]);
      store.close();
    }
  });
  it("migrates the full original schema: copies the report channel, drops the retired columns, keeps role and ticks, and a reopen changes nothing (Scenario 27, BP-108)", () => {
    const path = oldDb(`${BASE}, first_message_ts TEXT, pin_refused INTEGER, report_channel_name TEXT, report_channel_id TEXT`, [
      "INSERT INTO member (member_id, role, dm_channel_id, first_message_ts, pin_refused, report_channel_name, report_channel_id) VALUES ('U1', 'technical', 'D1', '100.001', 1, 'onboarding-copilot-ann', 'G1')",
      "INSERT INTO member (member_id, role, report_channel_name) VALUES ('U2', 'technical', 'onboarding-copilot-bob')",
      "INSERT INTO member (member_id, role) VALUES ('U3', 'non-technical')",
      "CREATE TABLE checklist_item (member_id TEXT NOT NULL, item_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', method TEXT, ticked_at TEXT, evidence_ref TEXT, PRIMARY KEY (member_id, item_id))",
      "INSERT INTO checklist_item (member_id, item_id, status, method) VALUES ('U1', 'I1', 'ticked', 'observed')",
    ]);
    const store = openStore(path);
    expect(columnsOf(store)).toEqual(expect.arrayContaining(["channel_id", "channel_name", "channel_state", "checklist_canvas_id", "canvas_surface"]));
    expect(retiredIn(store)).toEqual([]);
    expect(getMemberChannel(store, "U1")).toEqual({ id: "G1", name: "onboarding-copilot-ann", state: "active" });
    expect(getMemberChannel(store, "U2")).toEqual({ id: null, name: null, state: null });
    expect(getMemberChannel(store, "U3")).toEqual({ id: null, name: null, state: null });
    expect(store.get("SELECT role, dm_channel_id FROM member WHERE member_id = 'U1'")).toEqual({ role: "technical", dm_channel_id: "D1" });
    expect(store.all("SELECT item_id, status, method FROM checklist_item")).toEqual([{ item_id: "I1", status: "ticked", method: "observed" }]);
    expect(store.all("SELECT * FROM v_item_methods")).toEqual([{ role: "technical", seeded: 0, item_id: "I1", method: "observed", ticks: 1 }]);
    setMemberChannel(store, "U1", { id: "C-9", name: "onboarding-copilot-ann-2", state: "lost" });
    const before = snapshot(store);
    store.close();

    const again = openStore(path);
    expect(snapshot(again)).toEqual(before);
    expect(getMemberChannel(again, "U1")).toEqual({ id: "C-9", name: "onboarding-copilot-ann-2", state: "lost" });
    again.close();
  });
  it("migrates a file that has welcome_ts instead of first_message_ts: the column is dropped and the row kept (FR-ST-008, BP-108)", () => {
    const path = oldDb(`${BASE}, welcome_ts TEXT, pin_refused INTEGER, report_channel_name TEXT, report_channel_id TEXT`, [
      "INSERT INTO member (member_id, role, welcome_ts, report_channel_name, report_channel_id) VALUES ('U1', 'technical', '100.001', 'onboarding-copilot-ann', 'G1')",
    ]);
    const store = openStore(path);
    expect(retiredIn(store)).toEqual([]);
    expect(store.get("SELECT role FROM member WHERE member_id = 'U1'")).toEqual({ role: "technical" });
    expect(getMemberChannel(store, "U1")).toEqual({ id: "G1", name: "onboarding-copilot-ann", state: "active" });
    store.close();
    expect(() => openStore(path).close()).not.toThrow();
  });
  it("migrates the oldest schema, with no pin_refused and no report columns, without adding any retired column (BP-108)", () => {
    const path = oldDb(`${BASE}, welcome_ts TEXT`, ["INSERT INTO member (member_id, role, dm_channel_id) VALUES ('U1', 'technical', 'D1')"]);
    const store = openStore(path);
    expect(retiredIn(store)).toEqual([]);
    expect(store.get("SELECT role, dm_channel_id FROM member WHERE member_id = 'U1'")).toEqual({ role: "technical", dm_channel_id: "D1" });
    store.close();
    expect(() => openStore(path).close()).not.toThrow();
  });
  it("never clobbers: an existing channel_id wins over report_channel_id, and a null report_channel_id copies nothing (BP-108)", () => {
    const path = oldDb(`${BASE}, first_message_ts TEXT, pin_refused INTEGER, report_channel_name TEXT, report_channel_id TEXT, channel_id TEXT, channel_name TEXT, channel_state TEXT`, [
      "INSERT INTO member (member_id, role, report_channel_name, report_channel_id, channel_id, channel_name, channel_state) VALUES ('U1', 'technical', 'old-name', 'G-old', 'C-7', 'new-name', 'lost')",
      "INSERT INTO member (member_id, role, report_channel_name, report_channel_id, channel_id, channel_name, channel_state) VALUES ('U2', 'technical', 'only-name', NULL, 'C-8', 'kept', 'member_left')",
      "INSERT INTO member (member_id, role, report_channel_name, report_channel_id) VALUES ('U3', 'technical', 'only-name', NULL)",
    ]);
    const store = openStore(path);
    expect(getMemberChannel(store, "U1")).toEqual({ id: "C-7", name: "new-name", state: "lost" });
    expect(getMemberChannel(store, "U2")).toEqual({ id: "C-8", name: "kept", state: "member_left" });
    expect(getMemberChannel(store, "U3")).toEqual({ id: null, name: null, state: null });
    expect(retiredIn(store)).toEqual([]);
    store.close();
  });
  it("finishes a half-migrated file that has the new columns and the old ones side by side, and an index on a retired column does not stop the drop (BP-108)", () => {
    const path = oldDb(
      `${BASE}, first_message_ts TEXT, pin_refused INTEGER, report_channel_name TEXT, report_channel_id TEXT, channel_id TEXT, channel_name TEXT, channel_state TEXT, checklist_canvas_id TEXT, canvas_surface TEXT`,
      [
        "INSERT INTO member (member_id, role, report_channel_name, report_channel_id) VALUES ('U1', 'technical', 'onboarding-copilot-ann', 'G1')",
        "CREATE INDEX member_report_channel ON member (report_channel_id)",
      ],
    );
    const store = openStore(path);
    expect(retiredIn(store)).toEqual([]);
    expect(getMemberChannel(store, "U1")).toEqual({ id: "G1", name: "onboarding-copilot-ann", state: "active" });
    store.close();
  });
  it("opening the same file twice in one process, with the first handle still open, changes nothing (BP-108)", () => {
    const path = oldDb(`${BASE}, first_message_ts TEXT, pin_refused INTEGER, report_channel_name TEXT, report_channel_id TEXT`, [
      "INSERT INTO member (member_id, role, report_channel_name, report_channel_id) VALUES ('U1', 'technical', 'n', 'G1')",
    ]);
    const one = openStore(path);
    const two = openStore(path);
    expect(snapshot(two)).toEqual(snapshot(one));
    expect(getMemberChannel(two, "U1")).toEqual({ id: "G1", name: "n", state: "active" });
    one.close();
    two.close();
  });
  it("a failure part-way through the migration rolls everything back and leaves the file as it was (BP-108 review)", () => {
    // A view that names report_channel_id makes DROP COLUMN fail after the copy step has already run.
    const path = oldDb(`${BASE}, first_message_ts TEXT, pin_refused INTEGER, report_channel_name TEXT, report_channel_id TEXT`, [
      "INSERT INTO member (member_id, role, report_channel_name, report_channel_id) VALUES ('U1', 'technical', 'n', 'G1')",
      "CREATE VIEW v_blocker AS SELECT member_id, report_channel_id FROM member",
    ]);
    const before = new DatabaseSync(path);
    const columnsBefore = (before.prepare("PRAGMA table_info(member)").all() as { name: string }[]).map((c) => c.name);
    before.close();
    expect(() => openStore(path)).toThrow();
    const after = new DatabaseSync(path);
    const columnsAfter = (after.prepare("PRAGMA table_info(member)").all() as { name: string }[]).map((c) => c.name);
    const row = after.prepare("SELECT member_id, role, report_channel_id FROM member").get() as Record<string, unknown>;
    after.close();
    expect(columnsAfter).toEqual(columnsBefore);
    expect(columnsAfter).not.toContain("channel_id");
    expect({ ...row }).toEqual({ member_id: "U1", role: "technical", report_channel_id: "G1" });
  });
  it("opens a database that has no report_channel_id column without copying or throwing, and keeps its channel (BP-099)", () => {
    const path = oldDb(`${BASE}, first_message_ts TEXT, pin_refused INTEGER, channel_id TEXT, channel_name TEXT, channel_state TEXT, checklist_canvas_id TEXT, canvas_surface TEXT`, [
      "INSERT INTO member (member_id, role, channel_id, channel_name, channel_state) VALUES ('U1', 'technical', 'C-7', 'onboarding-copilot-ann', 'lost')",
    ]);
    expect(() => openStore(path).close()).not.toThrow();
    const store = openStore(path);
    expect(getMemberChannel(store, "U1")).toEqual({ id: "C-7", name: "onboarding-copilot-ann", state: "lost" });
    expect(retiredIn(store)).toEqual([]);
    store.close();
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
