import { describe, expect, it } from "vitest";
import { handleReset } from "../src/reset.js";
import { handleOnboard, RESET_OPERATOR_ONLY } from "../src/start.js";
import { getReportChannel, setReportChannel } from "../src/store.js";
import { makeDeps, onboard } from "./helpers.js";

type Deps = ReturnType<typeof makeDeps>;

/** Every row of the state tables (the retired nonce table included), so "unchanged" means byte-identical. */
const snapshot = (deps: Deps) =>
  JSON.stringify(["member", "checklist_item", "report_nonce"].map((t) => deps.store.all(`SELECT * FROM ${t} ORDER BY 1, 2`)));

/** A ticked test member (U2) with a stored report channel, and a seeded member (S1). */
async function seed(deps: Deps): Promise<void> {
  await onboard(deps, "U2", "technical");
  deps.store.run("UPDATE checklist_item SET status = 'done', method = 'self', ticked_at = ? WHERE member_id = 'U2' AND item_id = 'I1'", deps.now());
  deps.store.run("INSERT INTO report_nonce (nonce, member_id, item_id, issued_at) VALUES ('n1', 'U2', 'I2', ?)", deps.now());
  setReportChannel(deps.store, "U2", { name: "onboarding-copilot-sam", id: "G2" });
  deps.store.run("INSERT INTO member (member_id, role, seeded) VALUES ('S1', 'technical', 1)");
}

describe("reset by a non-operator (Scenario 10)", () => {
  it.each(["reset <@U2|sam>", "reset all"])("`/onboard %s` gets the operator message and changes nothing", async (text) => {
    const deps = makeDeps();
    await seed(deps);
    const before = snapshot(deps);
    expect(await handleReset(deps, { callerId: "U1", text })).toBe(RESET_OPERATOR_ONLY);
    expect(snapshot(deps)).toBe(before);
  });

  it("the same refusal comes through /onboard", async () => {
    const deps = makeDeps();
    await seed(deps);
    const before = snapshot(deps);
    expect(await handleOnboard(deps, { callerId: "U1", text: "reset all" })).toBe(RESET_OPERATOR_ONLY);
    expect(deps.fake.calls.filter((c) => c.method === "conversations.open" && c.args.users === "U1")).toHaveLength(0);
    expect(snapshot(deps)).toBe(before);
  });
});

describe("reset by an operator", () => {
  it.each(["reset", "reset foo"])("`/onboard %s` returns the two forms and changes nothing", async (text) => {
    const deps = makeDeps();
    await seed(deps);
    const before = snapshot(deps);
    const reply = await handleReset(deps, { callerId: "UOP1", text });
    expect(reply).toContain("/onboard reset @member");
    expect(reply).toContain("/onboard reset all");
    expect(snapshot(deps)).toBe(before);
  });

  it("`/onboard reset @member` clears a ticked member, keeps the DM channel and report channel, and tells nobody else (Scenario 8)", async () => {
    const deps = makeDeps();
    await seed(deps);
    deps.store.run("UPDATE member SET completed_at = ? WHERE member_id = 'U2'", deps.now());
    const row = () => deps.store.get<Record<string, unknown>>("SELECT * FROM member WHERE member_id = 'U2'");
    expect(row()).toMatchObject({ role: "technical", checklist_ts: expect.any(String), dm_channel_id: "D-U2" });
    const seededBefore = JSON.stringify(deps.store.all("SELECT * FROM member WHERE member_id = 'S1'"));
    const calls = deps.fake.calls.length;

    const reply = await handleReset(deps, { callerId: "UOP1", text: "reset <@U2|sam>" });

    expect(reply).toContain("<@U2>");
    expect(reply).toMatch(/reset/i);
    expect(reply).not.toMatch(/I[1-9]/);
    expect(row()).toMatchObject({ role: null, completed_at: null, checklist_ts: null, dm_channel_id: "D-U2" });
    expect(deps.store.all("SELECT 1 FROM checklist_item WHERE member_id = 'U2'")).toHaveLength(0);
    expect(deps.store.all("SELECT 1 FROM report_nonce WHERE member_id = 'U2'")).toHaveLength(1);
    expect(getReportChannel(deps.store, "U2")).toEqual({ name: "onboarding-copilot-sam", id: "G2" });
    expect(JSON.stringify(deps.store.all("SELECT * FROM member WHERE member_id = 'S1'"))).toBe(seededBefore);
    expect(deps.fake.calls).toHaveLength(calls);
  });

  it("a reset member who starts again gets the first message and the role question", async () => {
    const deps = makeDeps();
    await seed(deps);
    await handleReset(deps, { callerId: "UOP1", text: "reset <@U2|sam>" });
    const posts = deps.fake.of("chat.postMessage").length;
    await handleOnboard(deps, { callerId: "U2", text: "" });
    expect(deps.fake.of("chat.postMessage")).toHaveLength(posts + 2);
    const message = deps.fake.last("chat.postMessage");
    expect(message.channel).toBe(deps.store.get<{ channel_id: string }>("SELECT channel_id FROM member WHERE member_id = 'U2'")?.channel_id);
    expect(JSON.stringify(message.blocks)).toContain("role_technical");
    expect(JSON.stringify(message.blocks)).toContain("role_non-technical");
    expect(deps.store.get<{ role: string | null }>("SELECT role FROM member WHERE member_id = 'U2'")?.role).toBeNull();
  });

  it("`/onboard reset all` clears every test member and leaves the 20 seeded members alone (Scenario 9)", async () => {
    const deps = makeDeps();
    await onboard(deps, "U2", "technical");
    await onboard(deps, "U3", "non-technical");
    await onboard(deps, "U4", "technical");
    setReportChannel(deps.store, "U3", { name: "onboarding-copilot-u3", id: "G3" });
    for (let i = 1; i <= 20; i++) deps.store.run("INSERT INTO member (member_id, role, seeded) VALUES (?, 'technical', 1)", `S${i}`);
    const seededCount = () => deps.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM member WHERE seeded = 1")?.n;
    const seededRows = () => JSON.stringify(deps.store.all("SELECT * FROM member WHERE seeded = 1 ORDER BY member_id"));
    const seededBefore = seededRows();
    const calls = deps.fake.calls.length;
    expect(seededCount()).toBe(20);

    const reply = await handleReset(deps, { callerId: "UOP1", text: "reset all" });

    expect(reply).toContain("3");
    expect(seededCount()).toBe(20);
    expect(seededRows()).toBe(seededBefore);
    expect(deps.store.all("SELECT 1 FROM member WHERE seeded = 0 AND (role IS NOT NULL OR checklist_ts IS NOT NULL OR completed_at IS NOT NULL)")).toHaveLength(0);
    expect(deps.store.all("SELECT 1 FROM checklist_item WHERE member_id IN ('U2', 'U3', 'U4')")).toHaveLength(0);
    expect(getReportChannel(deps.store, "U3")).toEqual({ name: "onboarding-copilot-u3", id: "G3" });
    expect(deps.fake.calls).toHaveLength(calls);
  });

  it.each(["reset <@U9|nobody>", "reset <@U5>"])("`/onboard %s` (no row, or a seeded row) says there is nothing to reset and changes nothing", async (text) => {
    const deps = makeDeps();
    await seed(deps);
    deps.store.run("INSERT INTO member (member_id, role, seeded) VALUES ('U5', 'technical', 1)");
    const before = snapshot(deps);
    const calls = deps.fake.calls.length;
    const reply = await handleReset(deps, { callerId: "UOP1", text });
    expect(reply).toContain("nothing to reset");
    expect(snapshot(deps)).toBe(before);
    expect(deps.fake.calls).toHaveLength(calls);
  });
});

describe("/onboard routing", () => {
  it("`/onboard` and `/onboard @member` still start onboarding", async () => {
    const deps = makeDeps();
    expect(await handleOnboard(deps, { callerId: "U1", text: "" })).toContain("onboarding channel");
    expect(await handleOnboard(deps, { callerId: "UOP1", text: "<@U3|sam>" })).toContain("<@U3>");
    expect(deps.store.get("SELECT 1 FROM member WHERE member_id = 'U3'")).toBeTruthy();
  });
});
