import { describe, expect, it } from "vitest";
import { handleOnboard, handleTeamJoin, OPERATOR_ONLY, startOnboarding } from "../src/start.js";
import { makeDeps } from "./helpers.js";

const row = (deps: ReturnType<typeof makeDeps>, id: string) =>
  deps.store.get<{ started_by: string; role: string | null; welcome_ts: string | null }>("SELECT started_by, role, welcome_ts FROM member WHERE member_id = ?", id);

describe("/onboard (Scenarios 3 to 5)", () => {
  it("a member starts themselves: one DM with two buttons and the two role definitions", async () => {
    const deps = makeDeps();
    const reply = await handleOnboard(deps, { callerId: "U1", text: "" });
    expect(reply).toContain("DM");
    expect(deps.fake.of("conversations.open")).toHaveLength(1);
    const dm = deps.fake.last("chat.postMessage");
    const blocks = JSON.stringify(dm.blocks);
    expect(blocks).toContain("technical: You work in repositories");
    expect(blocks).toContain("non-technical: You work in any other consulting role");
    expect(blocks).toContain('"value":"technical"');
    expect(blocks).toContain('"value":"non-technical"');
    expect(row(deps, "U1")?.started_by).toBe("command");
    expect(row(deps, "U1")?.welcome_ts).toBeTruthy();
  });

  it("an operator starts a named member", async () => {
    const deps = makeDeps();
    await handleOnboard(deps, { callerId: "UOP1", text: "<@U2|sam>" });
    expect(deps.fake.last("conversations.open")).toEqual({ users: "U2" });
    expect(row(deps, "U2")?.started_by).toBe("command");
    expect(row(deps, "UOP1")).toBeUndefined();
  });

  it("a non-operator naming another member sends no DM and writes no row (Scenario 5)", async () => {
    const deps = makeDeps();
    const reply = await handleOnboard(deps, { callerId: "U1", text: "<@U2|sam>" });
    expect(reply).toBe(OPERATOR_ONLY);
    expect(deps.fake.calls).toHaveLength(0);
    expect(row(deps, "U2")).toBeUndefined();
  });

  it("naming yourself is the self form, open to everyone", async () => {
    const deps = makeDeps();
    await handleOnboard(deps, { callerId: "U1", text: "<@U1|me>" });
    expect(row(deps, "U1")).toBeTruthy();
  });
});

describe("start guards", () => {
  it("a bot user gets no DM", async () => {
    const deps = makeDeps();
    expect(await startOnboarding(deps, { memberId: "B1", startedBy: "event", isBot: true })).toBe("bot");
    expect(deps.fake.calls).toHaveLength(0);
  });

  it("a repeated event_id gives one DM", async () => {
    const deps = makeDeps();
    expect(await startOnboarding(deps, { memberId: "U1", startedBy: "event", eventId: "Ev1" })).toBe("sent");
    expect(await startOnboarding(deps, { memberId: "U1", startedBy: "event", eventId: "Ev1" })).toBe("duplicate");
    expect(deps.fake.of("chat.postMessage")).toHaveLength(1);
  });

  it("a conversations.open error writes one log line and makes no second attempt", async () => {
    const deps = makeDeps();
    deps.fake.failOpen = true;
    expect(await startOnboarding(deps, { memberId: "U1", startedBy: "command" })).toBe("dm_failed");
    expect(deps.fake.of("conversations.open")).toHaveLength(1);
    expect(deps.fake.of("chat.postMessage")).toHaveLength(0);
    expect(deps.logs.filter((l) => l.includes("start_failed"))).toHaveLength(1);
    expect(row(deps, "U1")).toBeUndefined();
  });

  it("a second start leaves the stored role unchanged", async () => {
    const deps = makeDeps();
    await startOnboarding(deps, { memberId: "U1", startedBy: "command" });
    deps.store.run("UPDATE member SET role = 'technical' WHERE member_id = 'U1'");
    await startOnboarding(deps, { memberId: "U1", startedBy: "command" });
    expect(row(deps, "U1")?.role).toBe("technical");
  });
});

describe("team_join (Scenario 2)", () => {
  it("a human starts onboarding with started_by event", async () => {
    const deps = makeDeps();
    await handleTeamJoin(deps, { memberId: "U9", eventId: "Ev9" });
    expect(row(deps, "U9")?.started_by).toBe("event");
    expect(deps.fake.of("chat.postMessage")).toHaveLength(1);
  });
  it("a bot calls nothing", async () => {
    const deps = makeDeps();
    await handleTeamJoin(deps, { memberId: "B9", isBot: true });
    expect(deps.fake.calls).toHaveLength(0);
  });
});

describe("welcome", () => {
  it("holds the glossary link when configured and omits it otherwise (FR-AS-006)", async () => {
    const withLink = makeDeps({ glossaryUrl: "https://example.slack.com/canvas/F1" });
    await startOnboarding(withLink, { memberId: "U1", startedBy: "command" });
    expect(JSON.stringify(withLink.fake.last("chat.postMessage").blocks)).toContain("https://example.slack.com/canvas/F1");
    const without = makeDeps();
    await startOnboarding(without, { memberId: "U1", startedBy: "command" });
    expect(JSON.stringify(without.fake.last("chat.postMessage").blocks)).not.toContain("canvas");
  });
});
