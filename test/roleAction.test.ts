import { describe, expect, it } from "vitest";
import { handleRole, startOnboarding } from "../src/start.js";
import { itemStatuses, makeDeps } from "./helpers.js";

describe("role buttons (Scenario 1)", () => {
  it("a click stores the role and role_chosen_at, replaces the buttons and creates the checklist once", async () => {
    const deps = makeDeps();
    await startOnboarding(deps, { memberId: "U1", startedBy: "command" });
    // The first post is the welcome (first_message_ts); the buttons are on the second, the role message.
    const [welcome, roleMessage] = deps.fake.of("chat.postMessage");
    expect((welcome?.args.blocks as { type: string }[]).some((b) => b.type === "actions")).toBe(false);
    expect((roleMessage?.args.blocks as { type: string }[]).some((b) => b.type === "actions")).toBe(true);
    const roleMessageTs = "100.002";

    await handleRole(deps, { memberId: "U1", role: "non-technical", channel: "D-U1", messageTs: roleMessageTs });

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

  it("a second click with the other button changes nothing and creates no second checklist", async () => {
    const deps = makeDeps();
    await startOnboarding(deps, { memberId: "U1", startedBy: "command" });
    await handleRole(deps, { memberId: "U1", role: "technical", channel: "D-U1", messageTs: "100.001" });
    deps.clock.advance(60_000);
    await handleRole(deps, { memberId: "U1", role: "non-technical", channel: "D-U1", messageTs: "100.001" });

    expect(deps.store.get("SELECT role, role_chosen_at FROM member WHERE member_id = 'U1'")).toMatchObject({
      role: "technical",
      role_chosen_at: "2026-10-26T10:00:00.000Z",
    });
    expect(deps.fake.of("chat.update").at(-1)?.args.text).toContain("technical");
    expect(deps.fake.of("chat.postMessage").filter((c) => String(c.args.text).includes("onboarding checklist"))).toHaveLength(1);
    expect(Object.keys(itemStatuses(deps, "U1"))).toHaveLength(7);
  });
});
