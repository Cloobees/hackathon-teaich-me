import { describe, expect, it } from "vitest";
import { findClaudeAppId, handleAttest, handleChannelMessage } from "../src/verify.js";
import { itemStatuses, makeDeps, onboard } from "./helpers.js";

type D = ReturnType<typeof makeDeps>;

async function ready(role: "technical" | "non-technical" = "technical", tickI1 = true): Promise<D> {
  const deps = makeDeps();
  deps.fake.emails.U1 = "sam@example.com";
  await onboard(deps, "U1", role);
  if (tickI1) await handleAttest(deps, "U1", "I1");
  deps.clock.advance(12 * 60_000);
  return deps;
}

describe("self-attest (FR-VF-002)", () => {
  it("a confirmed click ticks self-attested with no evidence", async () => {
    const deps = await ready();
    await handleAttest(deps, "U1", "I5");
    expect(deps.store.get("SELECT method, evidence_ref FROM checklist_item WHERE member_id = 'U1' AND item_id = 'I5'")).toMatchObject({
      method: "self-attested",
      evidence_ref: null,
    });
  });
});

describe("Claude mention (FR-VF-003, assumed route SP-1)", () => {
  it("a message mentioning the Claude app ticks I1 observed with the message ts", async () => {
    const deps = await ready("technical", false);
    await handleChannelMessage(deps, { memberId: "U1", text: "hey <@UCLAUDE> help", ts: "555.1", claudeAppId: "UCLAUDE" });
    expect(deps.store.get("SELECT method, evidence_ref FROM checklist_item WHERE member_id = 'U1' AND item_id = 'I1'")).toMatchObject({
      method: "observed",
      evidence_ref: "555.1",
    });
  });
  it("a message without the mention ticks nothing", async () => {
    const deps = await ready("technical", false);
    await handleChannelMessage(deps, { memberId: "U1", text: "hello team", ts: "555.2", claudeAppId: "UCLAUDE" });
    expect(itemStatuses(deps, "U1").I1).toBe("pending");
  });
  it("no Claude app id ticks nothing", async () => {
    const deps = await ready("technical", false);
    await handleChannelMessage(deps, { memberId: "U1", text: "<@UCLAUDE>", ts: "555.3" });
    expect(itemStatuses(deps, "U1").I1).toBe("pending");
  });
  it("finds the Claude app in users.list", async () => {
    const deps = makeDeps();
    deps.fake.members = [{ id: "U1", name: "sam" }, { id: "UCLAUDE", name: "claude", is_bot: true }];
    expect(await findClaudeAppId(deps)).toBe("UCLAUDE");
  });
  it("a failed users.list returns undefined and does not throw", async () => {
    const deps = makeDeps();
    deps.fake.failList = true;
    expect(await findClaudeAppId(deps)).toBeUndefined();
    expect(deps.logs.some((l) => l.includes("claude_app_lookup_failed"))).toBe(true);
  });
});
