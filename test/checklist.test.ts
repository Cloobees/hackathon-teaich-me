import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRows, getRows, loadItems, tick } from "../src/checklist.js";
import { openStore, type Store } from "../src/store.js";

const config = loadItems();
const now = () => "2026-10-26T10:05:00.000Z";

function member(store: Store, id: string, role: "technical" | "non-technical") {
  store.run("INSERT INTO member (member_id, role) VALUES (?, ?)", id, role);
  createRows(store, config, id, role);
}

describe("createRows (Scenario 1)", () => {
  it("makes 4 rows for non-technical and 6 for technical, all pending", () => {
    const store = openStore(":memory:");
    member(store, "N1", "non-technical");
    member(store, "T1", "technical");
    expect(getRows(store, "N1")).toHaveLength(4);
    expect(getRows(store, "T1")).toHaveLength(6);
    for (const row of getRows(store, "T1")) expect(row).toMatchObject({ status: "pending", method: null, ticked_at: null, evidence_ref: null });
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
    expect(store.get<{ completed_at: string | null }>("SELECT completed_at FROM member WHERE member_id = 'N1'")?.completed_at).toBeNull();
    expect(tick(store, config, "N1", "I4", "self-attested", null, now)).toMatchObject({ completed: true });
    expect(tick(store, config, "N1", "I4", "self-attested", null, now)).toEqual({ status: "unchanged" });
    expect(store.get<{ completed_at: string }>("SELECT completed_at FROM member WHERE member_id = 'N1'")?.completed_at).toBe(now());
  });
  it("a technical member completes at I6, not I4", () => {
    const store = openStore(":memory:");
    member(store, "T1", "technical");
    for (const id of ["I1", "I2", "I3", "I4", "I5"]) expect(tick(store, config, "T1", id, "self-attested", null, now)).toMatchObject({ completed: false });
    expect(tick(store, config, "T1", "I6", "self-attested", null, now)).toMatchObject({ completed: true });
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
