import { describe, expect, it } from "vitest";
import { handleReset } from "../src/reset.js";
import { handleOnboard, RESET_OPERATOR_ONLY } from "../src/start.js";
import { getMemberChannel, setMemberChannel } from "../src/store.js";
import { makeDeps, onboard, slackError } from "./helpers.js";

type Deps = ReturnType<typeof makeDeps>;

/** Every row of the state tables (the retired nonce table included), so "unchanged" means byte-identical. */
const snapshot = (deps: Deps) =>
  JSON.stringify(["member", "checklist_item", "report_nonce"].map((t) => deps.store.all(`SELECT * FROM ${t} ORDER BY 1, 2`)));

/** A ticked test member (U2) with a stored report channel, and a seeded member (S1). */
async function seed(deps: Deps): Promise<void> {
  await onboard(deps, "U2", "technical");
  deps.store.run("UPDATE checklist_item SET status = 'done', method = 'self', ticked_at = ? WHERE member_id = 'U2' AND item_id = 'I1'", deps.now());
  deps.store.run("INSERT INTO report_nonce (nonce, member_id, item_id, issued_at) VALUES ('n1', 'U2', 'I2', ?)", deps.now());
  setMemberChannel(deps.store, "U2", { id: "G2", name: "onboarding-copilot-sam", state: "active" });
  deps.store.run("INSERT INTO member (member_id, role, seeded) VALUES ('S1', 'technical', 1)");
}

describe("reset by a non-operator (Scenario 10)", () => {
  it.each(["reset <@U2|sam>", "reset all"])("`/onboard-ch %s` gets the operator message and changes nothing", async (text) => {
    const deps = makeDeps();
    await seed(deps);
    const before = snapshot(deps);
    expect(await handleReset(deps, { callerId: "U1", text })).toBe(RESET_OPERATOR_ONLY);
    expect(snapshot(deps)).toBe(before);
  });

  it("the same refusal comes through /onboard-ch", async () => {
    const deps = makeDeps();
    await seed(deps);
    const before = snapshot(deps);
    expect(await handleOnboard(deps, { callerId: "U1", text: "reset all" })).toBe(RESET_OPERATOR_ONLY);
    expect(deps.fake.calls.filter((c) => c.method === "conversations.open" && c.args.users === "U1")).toHaveLength(0);
    expect(snapshot(deps)).toBe(before);
  });
});

describe("reset by an operator", () => {
  it.each(["reset", "reset foo"])("`/onboard-ch %s` returns the two forms and changes nothing", async (text) => {
    const deps = makeDeps();
    await seed(deps);
    const before = snapshot(deps);
    const reply = await handleReset(deps, { callerId: "UOP1", text });
    expect(reply).toContain("/onboard-ch reset @member");
    expect(reply).toContain("/onboard-ch reset all");
    expect(reply).not.toMatch(/[/]onboard( |`)/);
    expect(snapshot(deps)).toBe(before);
  });

  it("`/onboard-ch reset @member` clears a ticked member, keeps the DM channel and report channel, and tells nobody else (Scenario 8)", async () => {
    const deps = makeDeps();
    await seed(deps);
    deps.store.run("UPDATE member SET completed_at = ? WHERE member_id = 'U2'", deps.now());
    const row = () => deps.store.get<Record<string, unknown>>("SELECT * FROM member WHERE member_id = 'U2'");
    expect(row()).toMatchObject({ role: "technical", checklist_ts: expect.any(String), dm_channel_id: "D-U2" });
    const seededBefore = JSON.stringify(deps.store.all("SELECT * FROM member WHERE member_id = 'S1'"));
    const calls = deps.fake.calls.length;

    const reply = await handleReset(deps, { callerId: "UOP1", text: "reset <@U2|sam>" });
    expect(reply).toContain("the old channel and its messages stay");
    expect(reply).toContain("in a new channel");
    expect(reply).not.toContain("DM");

    expect(reply).toContain("<@U2>");
    expect(reply).toMatch(/reset/i);
    expect(reply).not.toMatch(/I[1-9]/);
    expect(row()).toMatchObject({ role: null, completed_at: null, checklist_ts: null, dm_channel_id: "D-U2" });
    expect(deps.store.all("SELECT 1 FROM checklist_item WHERE member_id = 'U2'")).toHaveLength(0);
    expect(deps.store.all("SELECT 1 FROM report_nonce WHERE member_id = 'U2'")).toHaveLength(1);
    expect(getMemberChannel(deps.store, "U2")).toEqual({ id: "G2", name: "onboarding-copilot-sam", state: "lost" });
    expect(JSON.stringify(deps.store.all("SELECT * FROM member WHERE member_id = 'S1'"))).toBe(seededBefore);
    // The only Slack call is the surface going back to its empty state (FR-CH-021); nothing is posted and nobody is told.
    const added = deps.fake.calls.slice(calls);
    expect(added.map((c) => c.method)).toEqual(["chat.update"]);
    expect(deps.fake.last("chat.update")).toMatchObject({ channel: "G2", text: "Checklist reset. A new one follows when you choose your role." });
  });

  it("a reset member who starts again gets a new channel with the first message and the role question (FR-CH-021)", async () => {
    const deps = makeDeps();
    await onboard(deps, "U2", "technical");
    const oldChannel = getMemberChannel(deps.store, "U2")?.id;
    await handleReset(deps, { callerId: "UOP1", text: "reset <@U2|sam>" });
    const creates = deps.fake.of("conversations.create").length;
    deps.fake.nameTaken = ["onboarding-copilot-u2"]; // the old channel still exists, so Slack refuses its name
    const reply = await handleOnboard(deps, { callerId: "U2", text: "" });
    expect(deps.fake.of("conversations.create")).toHaveLength(creates + 2); // the old name is refused, then the -2 name is made
    const fresh = getMemberChannel(deps.store, "U2");
    expect(fresh).toMatchObject({ state: "active" });
    expect(fresh?.id).not.toBe(oldChannel);
    expect(fresh?.name).toBe("onboarding-copilot-u2-2");
    expect(reply).toContain(`<#${fresh?.id}>`);
    const inNew = deps.fake.of("chat.postMessage").filter((c) => c.args.channel === fresh?.id);
    expect(inNew).toHaveLength(2);
    expect(JSON.stringify(inNew[1]?.args.blocks)).toContain("role_technical");
    expect(JSON.stringify(inNew[1]?.args.blocks)).toContain("role_non-technical");
    expect(deps.store.get<{ role: string | null }>("SELECT role FROM member WHERE member_id = 'U2'")?.role).toBeNull();
  });

  it("many resets in a row each get a new channel (a tester resets again and again)", async () => {
    const deps = makeDeps();
    await onboard(deps, "U2", "technical");
    const seen = new Set([getMemberChannel(deps.store, "U2")?.name]);
    for (let i = 0; i < 6; i++) {
      await handleReset(deps, { callerId: "UOP1", text: "reset <@U2>" });
      deps.fake.nameTaken = [...seen] as string[];
      expect(await handleOnboard(deps, { callerId: "U2", text: "" })).toContain("created your onboarding channel");
      const name = getMemberChannel(deps.store, "U2")?.name;
      expect(seen.has(name)).toBe(false);
      seen.add(name);
    }
    expect(seen.size).toBe(7);
  });

  it("`/onboard-ch reset all` clears every test member and leaves the 20 seeded members alone (Scenario 9)", async () => {
    const deps = makeDeps();
    await onboard(deps, "U2", "technical");
    await onboard(deps, "U3", "non-technical");
    await onboard(deps, "U4", "technical");
    setMemberChannel(deps.store, "U3", { id: "G3", name: "onboarding-copilot-u3", state: "active" });
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
    expect(getMemberChannel(deps.store, "U3")).toEqual({ id: "G3", name: "onboarding-copilot-u3", state: "lost" });
    // One surface reset per test member and nothing else: no post, no DM, no seeded member touched.
    expect(deps.fake.calls.slice(calls).map((c) => c.method)).toEqual(["chat.update", "chat.update", "chat.update"]);
  });

  it.each(["reset <@U9|nobody>", "reset <@U5>"])("`/onboard-ch %s` (no row, or a seeded row) says there is nothing to reset and changes nothing", async (text) => {
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

describe("/onboard-ch routing", () => {
  it("`/onboard-ch` and `/onboard-ch @member` still start onboarding", async () => {
    const deps = makeDeps();
    expect(await handleOnboard(deps, { callerId: "U1", text: "" })).toContain("onboarding channel");
    expect(await handleOnboard(deps, { callerId: "UOP1", text: "<@U3|sam>" })).toContain("<@U3>");
    expect(deps.store.get("SELECT 1 FROM member WHERE member_id = 'U3'")).toBeTruthy();
  });
});

describe("reset detaches the channel so the next start makes a new one (FR-CH-021, Scenario 25)", () => {
  const stored = (deps: Deps, id: string) =>
    deps.store.get<Record<string, unknown>>(
      "SELECT channel_id, channel_name, channel_state, checklist_canvas_id, canvas_surface, role, completed_at, checklist_ts FROM member WHERE member_id = ?",
      id,
    );

  it("the canvas surface is reset first, then the member is cleared and the channel detached; a later start makes a new channel and a new canvas", async () => {
    const deps = makeDeps({ checklistSurface: "canvas" });
    await onboard(deps, "U2", "technical");
    expect(stored(deps, "U2")).toMatchObject({ channel_id: "C-1", checklist_canvas_id: "F-1", canvas_surface: "canvas" });
    const calls = deps.fake.calls.length;

    await handleReset(deps, { callerId: "UOP1", text: "reset <@U2>" });

    expect(deps.fake.calls.slice(calls).map((c) => c.method)).toEqual(["canvases.edit"]);
    expect(deps.fake.canvasBodies["F-1"]).toContain("Checklist reset");
    expect(stored(deps, "U2")).toEqual({
      channel_id: "C-1",
      channel_name: "onboarding-copilot-u2",
      channel_state: "lost",
      checklist_canvas_id: "F-1",
      canvas_surface: "canvas",
      role: null,
      completed_at: null,
      checklist_ts: null,
    });
    expect(deps.store.all("SELECT 1 FROM checklist_item WHERE member_id = 'U2'")).toHaveLength(0);

    await handleOnboard(deps, { callerId: "U2", text: "" });
    await onboard(deps, "U2", "non-technical");
    expect(deps.fake.of("conversations.canvases.create")).toHaveLength(2);
    expect(deps.logs.filter((l) => l.includes("canvas_degraded"))).toHaveLength(0);
    expect(stored(deps, "U2")).toMatchObject({ channel_id: "C-2", channel_state: "active", canvas_surface: "canvas", role: "non-technical" });
    expect(stored(deps, "U2")?.checklist_canvas_id).not.toBe("F-1");
  });

  it("the surface reset runs before the store is cleared", async () => {
    const deps = makeDeps();
    await onboard(deps, "U2", "technical");
    let seen: unknown;
    deps.slack.chat.update = async () => {
      seen = deps.store.get("SELECT role, checklist_ts FROM member WHERE member_id = 'U2'");
      return {};
    };
    await handleReset(deps, { callerId: "UOP1", text: "reset <@U2>" });
    expect(seen).toMatchObject({ role: "technical", checklist_ts: expect.any(String) });
    expect(stored(deps, "U2")).toMatchObject({ role: null, checklist_ts: null });
  });

  it("a lost channel: the gone error is isolated, the member is still cleared and stays lost", async () => {
    const deps = makeDeps();
    await onboard(deps, "U2", "technical");
    deps.slack.chat.update = async () => {
      throw slackError("is_archived");
    };
    const reply = await handleReset(deps, { callerId: "UOP1", text: "reset <@U2>" });
    expect(reply).toContain("Reset <@U2>");
    expect(stored(deps, "U2")).toMatchObject({ channel_id: "C-1", channel_state: "lost", role: null, checklist_ts: null });
    expect(deps.store.all("SELECT 1 FROM checklist_item WHERE member_id = 'U2'")).toHaveLength(0);
  });

  it("a deleted canvas on a canvas member: the error is isolated, the member is cleared and the canvas columns stay", async () => {
    const deps = makeDeps({ checklistSurface: "canvas" });
    await onboard(deps, "U2", "technical");
    deps.slack.canvases.edit = async () => {
      throw slackError("canvas_deleted");
    };
    await expect(handleReset(deps, { callerId: "UOP1", text: "reset <@U2>" })).resolves.toContain("Reset <@U2>");
    expect(stored(deps, "U2")).toMatchObject({ role: null, channel_id: "C-1", checklist_canvas_id: "F-1" });
  });

  it("a non-gone Slack error is logged as reset_surface_failed and does not stop the reset", async () => {
    const deps = makeDeps();
    await onboard(deps, "U2", "technical");
    deps.slack.chat.update = async () => {
      throw slackError("ratelimited");
    };
    await expect(handleReset(deps, { callerId: "UOP1", text: "reset <@U2>" })).resolves.toContain("Reset <@U2>");
    expect(deps.logs.some((l) => l.includes("reset_surface_failed") && l.includes("ratelimited"))).toBe(true);
    expect(stored(deps, "U2")).toMatchObject({ role: null, channel_state: "lost" });
  });

  it("`reset all` continues past a member whose surface reset fails and counts every member cleared", async () => {
    const deps = makeDeps();
    for (const id of ["U2", "U3", "U4"]) await onboard(deps, id, "technical");
    const update = deps.slack.chat.update;
    deps.slack.chat.update = async (args) => {
      if (args.channel === "C-2") throw slackError("ratelimited");
      return update(args);
    };
    const reply = await handleReset(deps, { callerId: "UOP1", text: "reset all" });
    expect(reply).toContain("Reset 3 test members");
    for (const id of ["U2", "U3", "U4"]) expect(stored(deps, id)).toMatchObject({ role: null, checklist_ts: null });
    expect(deps.logs.filter((l) => l.includes("reset_surface_failed"))).toHaveLength(1);
  });

  it("a double reset clears twice with one surface call: the second finds no checklist", async () => {
    const deps = makeDeps();
    await onboard(deps, "U2", "technical");
    await handleReset(deps, { callerId: "UOP1", text: "reset <@U2>" });
    const updates = deps.fake.of("chat.update").length;
    const second = await handleReset(deps, { callerId: "UOP1", text: "reset <@U2>" });
    expect(second).toContain("Reset <@U2>");
    expect(deps.fake.of("chat.update")).toHaveLength(updates);
    expect(stored(deps, "U2")).toMatchObject({ role: null, channel_id: "C-1", channel_state: "lost" });
  });

  it("a member with no checklist yet (no role) is cleared with no surface call", async () => {
    const deps = makeDeps();
    await handleOnboard(deps, { callerId: "U2", text: "" });
    const calls = deps.fake.calls.length;
    await handleReset(deps, { callerId: "UOP1", text: "reset <@U2>" });
    expect(deps.fake.calls).toHaveLength(calls);
    expect(stored(deps, "U2")).toMatchObject({ channel_id: "C-1", channel_state: "lost" });
  });
});
