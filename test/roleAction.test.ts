import { describe, expect, it } from "vitest";
import { handleRole, startOnboarding } from "../src/start.js";
import { itemStatuses, makeDeps } from "./helpers.js";

describe("role buttons (Scenario 1)", () => {
  it("a click stores the role and role_chosen_at, replaces the buttons and creates the checklist once", async () => {
    const deps = makeDeps();
    await startOnboarding(deps, { memberId: "U1", startedBy: "command" });
    // The first channel post is the welcome; the buttons are on the second, the role message.
    const [welcome, roleMessage] = deps.fake.of("chat.postMessage");
    expect((welcome?.args.blocks as { type: string }[]).some((b) => b.type === "actions")).toBe(false);
    expect((roleMessage?.args.blocks as { type: string }[]).some((b) => b.type === "actions")).toBe(true);
    const roleMessageTs = "100.002";

    await handleRole(deps, { memberId: "U1", role: "non-technical", channel: "C-1", messageTs: roleMessageTs });

    expect(deps.store.get("SELECT role, role_chosen_at FROM member WHERE member_id = 'U1'")).toMatchObject({
      role: "non-technical",
      role_chosen_at: deps.clock.now(),
    });
    const update = deps.fake.of("chat.update")[0]?.args as { ts: string; text: string; blocks: { type: string }[] };
    expect(update.ts).toBe(roleMessageTs);
    expect(deps.fake.of("chat.update")).toHaveLength(1);
    expect(update.text).toContain("non-technical");
    expect(update.blocks.some((b) => b.type === "actions")).toBe(false);
    expect(Object.keys(itemStatuses(deps, "U1"))).toEqual(["I1", "I2", "I3", "I4", "I7"]);
    expect(deps.fake.of("chat.postMessage").filter((c) => String(c.args.text).includes("onboarding checklist"))).toHaveLength(1);
  });

  it("the update, the checklist, the pin and the first instruction all go to the member's channel and none to the DM (FR-CH-011)", async () => {
    const deps = makeDeps();
    await startOnboarding(deps, { memberId: "U1", startedBy: "command" });
    const dmBefore = deps.fake.of("chat.postMessage").filter((c) => c.args.channel === "D-U1").length;
    await handleRole(deps, { memberId: "U1", role: "technical", channel: "C-1", messageTs: "100.002" });

    expect(deps.fake.of("chat.update")[0]?.args.channel).toBe("C-1");
    expect(deps.fake.of("pins.add")[0]?.args.channel).toBe("C-1");
    const afterRole = deps.fake.of("chat.postMessage").slice(3);
    expect(afterRole.length).toBeGreaterThanOrEqual(2);
    expect(afterRole.map((c) => c.args.channel)).toEqual(afterRole.map(() => "C-1"));
    expect(deps.fake.of("chat.postMessage").filter((c) => c.args.channel === "D-U1")).toHaveLength(dmBefore);
  });

  it("a click on a message in another channel changes nothing: no role, no update, no checklist", async () => {
    const deps = makeDeps();
    await startOnboarding(deps, { memberId: "U1", startedBy: "command" });
    await handleRole(deps, { memberId: "U1", role: "technical", channel: "C-99", messageTs: "100.002" });

    expect(deps.store.get<{ role: string | null }>("SELECT role FROM member WHERE member_id = 'U1'")?.role).toBeNull();
    expect(deps.fake.of("chat.update")).toHaveLength(0);
    expect(Object.keys(itemStatuses(deps, "U1"))).toHaveLength(0);
    expect(deps.logs.some((l) => l.includes("role_ignored"))).toBe(true);
  });

  it("a click by a member with no row is ignored and creates no row", async () => {
    const deps = makeDeps();
    await handleRole(deps, { memberId: "U7", role: "technical", channel: "D-U7", messageTs: "100.001" });
    expect(deps.store.get("SELECT 1 FROM member WHERE member_id = 'U7'")).toBeUndefined();
    expect(deps.fake.calls).toHaveLength(0);
  });

  it("a second click with the other button changes nothing and creates no second checklist", async () => {
    const deps = makeDeps();
    await startOnboarding(deps, { memberId: "U1", startedBy: "command" });
    await handleRole(deps, { memberId: "U1", role: "technical", channel: "C-1", messageTs: "100.001" });
    deps.clock.advance(60_000);
    await handleRole(deps, { memberId: "U1", role: "non-technical", channel: "C-1", messageTs: "100.001" });

    expect(deps.store.get("SELECT role, role_chosen_at FROM member WHERE member_id = 'U1'")).toMatchObject({
      role: "technical",
      role_chosen_at: "2026-10-26T10:00:00.000Z",
    });
    expect(deps.fake.of("chat.update").at(-1)?.args.text).toContain("technical");
    expect(deps.fake.of("chat.postMessage").filter((c) => String(c.args.text).includes("onboarding checklist"))).toHaveLength(1);
    expect(Object.keys(itemStatuses(deps, "U1"))).toHaveLength(7);
  });
});
