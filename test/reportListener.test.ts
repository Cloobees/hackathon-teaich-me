import { describe, expect, it } from "vitest";
import { findClaudeAppId, handleAttest, handleChannelMessage, handleReportDm, issueReportPrompt } from "../src/verify.js";
import { itemStatuses, makeDeps, onboard } from "./helpers.js";

type D = ReturnType<typeof makeDeps>;

const nonceFrom = (deps: D) => /nonce[: ]+(\S+)/.exec(deps.fake.last("chat.postMessage").text)?.[1] as string;
const i2Block = (nonce: string, activity = "2026-10-26T10:12:00Z") =>
  `COPILOT-REPORT v1\nitem: I2\nnonce: ${nonce}\nscope_slug: my-workspace@sam@example.com\nlast_knowledge_activity: ${activity}`;

async function ready(role: "technical" | "non-technical" = "technical"): Promise<D> {
  const deps = makeDeps();
  deps.fake.emails.U1 = "sam@example.com";
  await onboard(deps, "U1", role);
  deps.clock.advance(12 * 60_000);
  return deps;
}

describe("report prompt button (DD-VF-005)", () => {
  it("each click posts a prompt with a new nonce bound to the member and item", async () => {
    const deps = await ready();
    await issueReportPrompt(deps, "U1", "I2");
    const first = nonceFrom(deps);
    await issueReportPrompt(deps, "U1", "I2");
    const second = nonceFrom(deps);
    expect(first).not.toBe(second);
    expect(deps.store.all("SELECT * FROM report_nonce WHERE member_id = 'U1' AND item_id = 'I2'")).toHaveLength(2);
    expect(deps.fake.last("chat.postMessage").text).toContain("list_scopes");
  });
  it("issues nothing for an item with no report block", async () => {
    const deps = await ready();
    const posts = deps.fake.of("chat.postMessage").length;
    await issueReportPrompt(deps, "U1", "I1");
    expect(deps.fake.of("chat.postMessage")).toHaveLength(posts);
  });
});

describe("report DM listener", () => {
  it("a valid I2 block ticks I2 validated with the nonce as evidence (Scenario 2)", async () => {
    const deps = await ready();
    await issueReportPrompt(deps, "U1", "I2");
    const nonce = nonceFrom(deps);
    expect(await handleReportDm(deps, { memberId: "U1", channel: "D-U1", text: i2Block(nonce) })).toBe(true);
    expect(deps.store.get("SELECT status, method, evidence_ref FROM checklist_item WHERE member_id = 'U1' AND item_id = 'I2'")).toMatchObject({
      status: "ticked",
      method: "validated",
      evidence_ref: nonce,
    });
  });

  it("an invalid block gives one reply naming the rule and no tick (Scenario 3)", async () => {
    const deps = await ready();
    await issueReportPrompt(deps, "U1", "I2");
    const nonce = nonceFrom(deps);
    const posts = deps.fake.of("chat.postMessage").length;
    await handleReportDm(deps, { memberId: "U1", channel: "D-U1", text: i2Block(nonce, "2026-10-26T09:40:00Z") });
    expect(deps.fake.of("chat.postMessage")).toHaveLength(posts + 1);
    expect(deps.fake.last("chat.postMessage").text).toContain("Create a note in Context Builder");
    expect(itemStatuses(deps, "U1").I2).toBe("pending");
  });

  it("a reused nonce says already used and changes nothing (Scenario 4)", async () => {
    const deps = await ready();
    await issueReportPrompt(deps, "U1", "I2");
    const nonce = nonceFrom(deps);
    await handleReportDm(deps, { memberId: "U1", channel: "D-U1", text: i2Block(nonce) });
    const updates = deps.fake.of("chat.update").length;
    await handleReportDm(deps, { memberId: "U1", channel: "D-U1", text: i2Block(nonce) });
    expect(deps.fake.last("chat.postMessage").text).toContain("already used");
    expect(deps.fake.of("chat.update")).toHaveLength(updates);
  });

  it("a valid I4 block ticks I4 and I3 validated with one evidence_ref (Scenario 7)", async () => {
    const deps = await ready();
    await issueReportPrompt(deps, "U1", "I4");
    const nonce = /nonce (\S+)\./.exec(deps.fake.last("chat.postMessage").text)?.[1] ?? /with the nonce (\S+?)\./.exec(deps.fake.last("chat.postMessage").text)?.[1];
    await handleReportDm(deps, { memberId: "U1", channel: "D-U1", text: `COPILOT-REPORT v1\nitem: I4\nnonce: ${nonce}\nskill: copilot-check` });
    const rows = deps.store.all<{ item_id: string; method: string; evidence_ref: string }>(
      "SELECT item_id, method, evidence_ref FROM checklist_item WHERE member_id = 'U1' AND item_id IN ('I3','I4')",
    );
    expect(rows.map((r) => r.method)).toEqual(["validated", "validated"]);
    expect(new Set(rows.map((r) => r.evidence_ref)).size).toBe(1);
    expect(rows[0]?.evidence_ref).toBe(nonce);
  });

  it("text without a report block is left for the question listener", async () => {
    const deps = await ready();
    expect(await handleReportDm(deps, { memberId: "U1", channel: "D-U1", text: "How do I connect Slack?" })).toBe(false);
  });

  it("a member with no role is told to choose one", async () => {
    const deps = makeDeps();
    expect(await handleReportDm(deps, { memberId: "U7", channel: "D7", text: "COPILOT-REPORT v1" })).toBe(true);
    expect(deps.fake.last("chat.postMessage").text).toContain("role");
  });
});

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
    const deps = await ready();
    await handleChannelMessage(deps, { memberId: "U1", text: "hey <@UCLAUDE> help", ts: "555.1", claudeAppId: "UCLAUDE" });
    expect(deps.store.get("SELECT method, evidence_ref FROM checklist_item WHERE member_id = 'U1' AND item_id = 'I1'")).toMatchObject({
      method: "observed",
      evidence_ref: "555.1",
    });
  });
  it("a message without the mention ticks nothing", async () => {
    const deps = await ready();
    await handleChannelMessage(deps, { memberId: "U1", text: "hello team", ts: "555.2", claudeAppId: "UCLAUDE" });
    expect(itemStatuses(deps, "U1").I1).toBe("pending");
  });
  it("no Claude app id ticks nothing", async () => {
    const deps = await ready();
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
