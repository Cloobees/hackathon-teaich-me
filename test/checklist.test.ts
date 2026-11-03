import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRows, getRows, itemsForRole, loadItems, position, resetAll, resetMember, tick } from "../src/checklist.js";
import { openStore, type Store } from "../src/store.js";

const config = loadItems();
const now = () => "2026-10-26T10:05:00.000Z";

function member(store: Store, id: string, role: "technical" | "non-technical") {
  store.run("INSERT INTO member (member_id, role) VALUES (?, ?)", id, role);
  createRows(store, config, id, role);
}

describe("createRows (Scenario 1)", () => {
  it("makes 5 rows for non-technical and 7 for technical, all pending", () => {
    const store = openStore(":memory:");
    member(store, "N1", "non-technical");
    member(store, "T1", "technical");
    expect(getRows(store, "N1")).toHaveLength(5);
    expect(getRows(store, "T1")).toHaveLength(7);
    for (const row of getRows(store, "T1")) expect(row).toMatchObject({ status: "pending", method: null, ticked_at: null, evidence_ref: null });
  });
});

describe("position (Scenario 12)", () => {
  it("numbers an item by its place in the role's own checklist", () => {
    expect(position(config, "non-technical", "I7")).toBe(5);
    expect(position(config, "technical", "I7")).toBe(7);
    for (const role of ["technical", "non-technical"] as const) {
      ["I1", "I2", "I3", "I4"].forEach((id, index) => expect(position(config, role, id)).toBe(index + 1));
    }
  });
  it("is undefined for an item the role does not have", () => {
    expect(position(config, "non-technical", "I5")).toBeUndefined();
  });
  it("I7 is last for both roles and its name carries the configured help channel", () => {
    expect(config.helpChannel).toBe("int-sf-ai");
    for (const role of ["technical", "non-technical"] as const) {
      const last = itemsForRole(config, role).at(-1);
      expect(last).toMatchObject({ id: "I7", order: 7, name: "Join the int-sf-ai channel" });
    }
  });
});

describe("reset (FR-CL-014, Scenario 14)", () => {
  /** A member with a role, a DM, a posted checklist, a ticked item, a nonce, completion and a refused pin. */
  function started(store: Store, id: string, seeded = 0) {
    store.run(
      "INSERT INTO member (member_id, role, role_chosen_at, dm_channel_id, checklist_ts, completed_at, pin_refused, seeded) VALUES (?, 'technical', 't', ?, '100.1', 't', 1, ?)",
      id,
      `D-${id}`,
      seeded,
    );
    createRows(store, config, id, "technical");
    tick(store, config, id, "I1", "observed", "e", now);
    store.run("INSERT INTO report_nonce (nonce, member_id, item_id, issued_at) VALUES (?, ?, 'I2', 't')", `n-${id}`, id);
  }
  const memberRow = (store: Store, id: string) =>
    store.get<Record<string, unknown>>("SELECT role, role_chosen_at, dm_channel_id, checklist_ts, completed_at, pin_refused FROM member WHERE member_id = ?", id);
  const rowCount = (store: Store, table: string, id: string) =>
    store.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE member_id = ?`, id)?.n;

  it("resetMember clears the member's rows and state but keeps the DM channel", () => {
    const store = openStore(":memory:");
    started(store, "T1");
    started(store, "T2");
    resetMember(store, "T1");
    expect(rowCount(store, "checklist_item", "T1")).toBe(0);
    expect(rowCount(store, "report_nonce", "T1")).toBe(0);
    expect(memberRow(store, "T1")).toEqual({ role: null, role_chosen_at: null, dm_channel_id: "D-T1", checklist_ts: null, completed_at: null, pin_refused: null });
    expect(rowCount(store, "checklist_item", "T2")).toBe(7);
    expect(rowCount(store, "report_nonce", "T2")).toBe(1);
  });
  it("resetMember does nothing to a seeded member", () => {
    const store = openStore(":memory:");
    started(store, "S1", 1);
    resetMember(store, "S1");
    expect(rowCount(store, "checklist_item", "S1")).toBe(7);
    expect(rowCount(store, "report_nonce", "S1")).toBe(1);
    expect(memberRow(store, "S1")).toMatchObject({ role: "technical", checklist_ts: "100.1", completed_at: "t", pin_refused: 1 });
  });
  it("resetAll clears every unseeded member, leaves seeded ones, and returns the count", () => {
    const store = openStore(":memory:");
    started(store, "T1");
    started(store, "T2");
    started(store, "S1", 1);
    expect(resetAll(store)).toBe(2);
    for (const id of ["T1", "T2"]) {
      expect(rowCount(store, "checklist_item", id)).toBe(0);
      expect(rowCount(store, "report_nonce", id)).toBe(0);
      expect(memberRow(store, id)).toMatchObject({ role: null, completed_at: null, pin_refused: null });
    }
    expect(rowCount(store, "checklist_item", "S1")).toBe(7);
  });
  it("after a reset a role can be stored again", () => {
    const store = openStore(":memory:");
    started(store, "T1");
    resetMember(store, "T1");
    expect(store.run("UPDATE member SET role = ? WHERE member_id = 'T1' AND role IS NULL", "non-technical")).toBe(1);
    expect(memberRow(store, "T1")).toMatchObject({ role: "non-technical" });
  });
});

describe("tick", () => {
  it("records method, time and evidence (Scenario 2)", () => {
    const store = openStore(":memory:");
    member(store, "T1", "technical");
    expect(tick(store, config, "T1", "I1", "observed", "100.5", now)).toMatchObject({ status: "ticked", ticked: ["I1"], completed: false });
    expect(getRows(store, "T1")[0]).toMatchObject({ item_id: "I1", status: "ticked", method: "observed", ticked_at: now(), evidence_ref: "100.5" });
  });
  it("keeps the first tick when a second arrives (Scenario 3)", () => {
    const store = openStore(":memory:");
    member(store, "T1", "technical");
    tick(store, config, "T1", "I1", "observed", "a", now);
    expect(tick(store, config, "T1", "I1", "self-attested", null, () => "later")).toEqual({ status: "unchanged" });
    expect(getRows(store, "T1")[0]).toMatchObject({ method: "observed", ticked_at: now() });
  });
  it("refuses I4 by self-attest while I3 is pending (Scenario 4)", () => {
    const store = openStore(":memory:");
    member(store, "T1", "technical");
    expect(tick(store, config, "T1", "I4", "self-attested", null, now)).toEqual({ status: "refused", needs: "I3" });
    expect(getRows(store, "T1").find((r) => r.item_id === "I4")?.status).toBe("pending");
  });
  it("accepts any other item out of order", () => {
    const store = openStore(":memory:");
    member(store, "T1", "technical");
    expect(tick(store, config, "T1", "I6", "self-attested", null, now).status).toBe("ticked");
  });
  it("a validated I4 ticks I3 too with one evidence_ref (Scenario 5)", () => {
    const store = openStore(":memory:");
    member(store, "T1", "technical");
    expect(tick(store, config, "T1", "I4", "validated", "nonce1", now)).toMatchObject({ status: "ticked", ticked: ["I3", "I4"] });
    for (const id of ["I3", "I4"]) {
      expect(getRows(store, "T1").find((r) => r.item_id === id)).toMatchObject({ status: "ticked", method: "validated", evidence_ref: "nonce1" });
    }
  });
  it("rolls both rows back when the second write fails (Scenario 5)", () => {
    const store = openStore(":memory:");
    member(store, "T1", "technical");
    let updates = 0;
    const flaky: Store = {
      ...store,
      run: (sql, ...params) => {
        if (sql.startsWith("UPDATE checklist_item") && ++updates === 2) throw new Error("disk full");
        return store.run(sql, ...params);
      },
    };
    expect(() => tick(flaky, config, "T1", "I4", "validated", "n", now)).toThrow("disk full");
    expect(getRows(store, "T1").filter((r) => r.status === "ticked")).toHaveLength(0);
  });
  it("sets completed_at once, at the last item the role needs (Scenario 6)", () => {
    const store = openStore(":memory:");
    member(store, "N1", "non-technical");
    for (const id of ["I1", "I2", "I3"]) tick(store, config, "N1", id, "self-attested", null, now);
    expect(tick(store, config, "N1", "I4", "self-attested", null, now)).toMatchObject({ completed: false });
    expect(store.get<{ completed_at: string | null }>("SELECT completed_at FROM member WHERE member_id = 'N1'")?.completed_at).toBeNull();
    expect(tick(store, config, "N1", "I7", "self-attested", null, now)).toMatchObject({ completed: true });
    expect(tick(store, config, "N1", "I7", "self-attested", null, now)).toEqual({ status: "unchanged" });
    expect(store.get<{ completed_at: string }>("SELECT completed_at FROM member WHERE member_id = 'N1'")?.completed_at).toBe(now());
  });
  it("a technical member completes at I7, not I6", () => {
    const store = openStore(":memory:");
    member(store, "T1", "technical");
    for (const id of ["I1", "I2", "I3", "I4", "I5", "I6"]) expect(tick(store, config, "T1", id, "self-attested", null, now)).toMatchObject({ completed: false });
    expect(tick(store, config, "T1", "I7", "self-attested", null, now)).toMatchObject({ completed: true });
  });
  it("returns unknown for an item the member does not have", () => {
    const store = openStore(":memory:");
    member(store, "N1", "non-technical");
    expect(tick(store, config, "N1", "I6", "self-attested", null, now)).toEqual({ status: "unknown" });
    expect(tick(store, config, "nobody", "I1", "self-attested", null, now)).toEqual({ status: "unknown" });
  });
  it("state survives a restart (Scenario 7)", () => {
    const path = join(mkdtempSync(join(tmpdir(), "cl-")), "c.db");
    const first = openStore(path);
    member(first, "T1", "technical");
    tick(first, config, "T1", "I1", "observed", "x", now);
    tick(first, config, "T1", "I2", "validated", "y", now);
    first.close();
    const second = openStore(path);
    expect(getRows(second, "T1").filter((r) => r.status === "ticked").map((r) => r.item_id)).toEqual(["I1", "I2"]);
    expect(tick(second, config, "T1", "I3", "self-attested", null, now).status).toBe("ticked");
    second.close();
  });
});
