import { describe, expect, it } from "vitest";
import { issueNonce } from "../src/report.js";
import { handleAttest, handleChannelReport } from "../src/verify.js";
import { itemStatuses, makeDeps, onboard } from "./helpers.js";

type D = ReturnType<typeof makeDeps>;

const CHECK = "C0CHECK01";
// Fields of the connector's message observed 2026-11-02 (.claude/evidence/BP-045/sp1.md): user is the member, no bot_id, no subtype.
const SENT_USING = " *Sent using* <@U0CDESX6B0V>";
const i2Block = (nonce: string, activity = "2026-10-26T10:12:00Z") =>
  `COPILOT-REPORT v1\nitem: I2\nnonce: ${nonce}\nscope_slug: my-workspace@sam@example.com\nlast_knowledge_activity: ${activity}${SENT_USING}`;
const i4Block = (nonce: string) => `COPILOT-REPORT v1\nitem: I4\nnonce: ${nonce}\nskill: copilot-check${SENT_USING}`;
const i6Block = (nonce: string) => `COPILOT-REPORT v1\nitem: I6\nnonce: ${nonce}\nsite_count: 2${SENT_USING}`;

async function ready(): Promise<D> {
  const deps = makeDeps({ checkChannelId: CHECK });
  deps.fake.emails.U1 = "sam@example.com";
  await onboard(deps, "U1", "technical");
  await handleAttest(deps, "U1", "I1");
  deps.clock.advance(12 * 60_000);
  return deps;
}
const issue = (deps: D, item: string, member = "U1") => issueNonce(deps.store, member, item, deps.now);
const postsTo = (deps: D, channel: string) => deps.fake.of("chat.postMessage").filter((c) => c.args.channel === channel);

describe("channel report listener (BP-048)", () => {
  it("a valid I2 block ticks I2 validated with the nonce, posts nothing in the channel and sends no failure DM (Scenario 2)", async () => {
    const deps = await ready();
    const nonce = issue(deps, "I2");
    const dmPosts = postsTo(deps, "D-U1").length;
    await handleChannelReport(deps, { memberId: "U1", text: i2Block(nonce) });
    expect(deps.store.get("SELECT status, method, evidence_ref FROM checklist_item WHERE member_id = 'U1' AND item_id = 'I2'")).toMatchObject({
      status: "ticked",
      method: "validated",
      evidence_ref: nonce,
    });
    expect(postsTo(deps, CHECK)).toHaveLength(0);
    // The only DM is the next instruction from the tick (FR-CL-011), not a failure message.
    expect(postsTo(deps, "D-U1")).toHaveLength(dmPosts + 1);
    expect(deps.fake.last("chat.postMessage").text).not.toMatch(/did not|already used|someone else/);
  });

  it("an invalid block (activity before role_chosen_at) leaves I2 pending and sends one DM naming the activity rule (Scenario 3)", async () => {
    const deps = await ready();
    const nonce = issue(deps, "I2");
    const posts = deps.fake.of("chat.postMessage").length;
    await handleChannelReport(deps, { memberId: "U1", text: i2Block(nonce, "2026-10-26T09:40:00Z") });
    expect(deps.fake.of("chat.postMessage")).toHaveLength(posts + 1);
    expect(deps.fake.last("chat.postMessage")).toMatchObject({ channel: "D-U1" });
    expect(deps.fake.last("chat.postMessage").text).toContain("Create a note in Context Builder");
    expect(itemStatuses(deps, "U1").I2).toBe("pending");
  });

  it("a reused nonce sends one DM saying already used and changes nothing (Scenario 4)", async () => {
    const deps = await ready();
    const nonce = issue(deps, "I2");
    await handleChannelReport(deps, { memberId: "U1", text: i2Block(nonce) });
    const posts = deps.fake.of("chat.postMessage").length;
    const updates = deps.fake.of("chat.update").length;
    await handleChannelReport(deps, { memberId: "U1", text: i2Block(nonce) });
    expect(deps.fake.of("chat.postMessage")).toHaveLength(posts + 1);
    expect(deps.fake.last("chat.postMessage")).toMatchObject({ channel: "D-U1" });
    expect(deps.fake.last("chat.postMessage").text).toContain("already used");
    expect(deps.fake.of("chat.update")).toHaveLength(updates);
  });

  it("a valid I4 block ticks I4 and I3 validated with one evidence_ref (Scenario 7)", async () => {
    const deps = await ready();
    const nonce = issue(deps, "I4");
    await handleChannelReport(deps, { memberId: "U1", text: i4Block(nonce) });
    const rows = deps.store.all<{ item_id: string; method: string; evidence_ref: string }>(
      "SELECT item_id, method, evidence_ref FROM checklist_item WHERE member_id = 'U1' AND item_id IN ('I3','I4')",
    );
    expect(rows.map((r) => r.method)).toEqual(["validated", "validated"]);
    expect(new Set(rows.map((r) => r.evidence_ref))).toEqual(new Set([nonce]));
  });

  it("a valid I6 block ticks I6", async () => {
    const deps = await ready();
    const nonce = issue(deps, "I6");
    await handleChannelReport(deps, { memberId: "U1", text: i6Block(nonce) });
    expect(deps.store.get("SELECT method, evidence_ref FROM checklist_item WHERE member_id = 'U1' AND item_id = 'I6'")).toMatchObject({
      method: "validated",
      evidence_ref: nonce,
    });
  });

  it("the exact observed text, with ' *Sent using* <@U0CDESX6B0V>' on the skill line, ticks I4 (Scenario 1, FR-VF-016)", async () => {
    const deps = await ready();
    const nonce = issue(deps, "I4");
    const observed = `COPILOT-REPORT v1\nitem: I4\nnonce: ${nonce}\nskill: copilot-check *Sent using* <@U0CDESX6B0V>`;
    await handleChannelReport(deps, { memberId: "U1", text: observed });
    expect(itemStatuses(deps, "U1").I4).toBe("ticked");
  });

  it("member A's nonce authored by member B ticks nothing, stays unused and sends B one DM (Scenario 12)", async () => {
    const deps = await ready();
    await onboard(deps, "U2", "technical");
    const nonce = issue(deps, "I4", "U1");
    const posts = deps.fake.of("chat.postMessage").length;
    await handleChannelReport(deps, { memberId: "U2", text: i4Block(nonce) });
    expect(deps.fake.of("chat.postMessage")).toHaveLength(posts + 1);
    expect(deps.fake.last("chat.postMessage")).toMatchObject({ channel: "D-U2" });
    expect(deps.fake.last("chat.postMessage").text).toContain("someone else");
    expect(deps.store.get<{ used_at: string | null }>("SELECT used_at FROM report_nonce WHERE nonce = ?", nonce)?.used_at).toBeNull();
    expect(itemStatuses(deps, "U1").I4).toBe("pending");
    expect(itemStatuses(deps, "U2").I4).toBe("pending");
  });

  it("a block with an unknown nonce sends the author one DM", async () => {
    const deps = await ready();
    const posts = deps.fake.of("chat.postMessage").length;
    await handleChannelReport(deps, { memberId: "U1", text: i4Block("nope") });
    expect(deps.fake.of("chat.postMessage")).toHaveLength(posts + 1);
    expect(deps.fake.last("chat.postMessage")).toMatchObject({ channel: "D-U1" });
    expect(deps.fake.last("chat.postMessage").text).toContain("did not issue");
  });

  it("failure messages say the check button and post it again, never Get report prompt or paste", async () => {
    const deps = await ready();
    await handleChannelReport(deps, { memberId: "U1", text: i4Block("nope") });
    const text = deps.fake.last("chat.postMessage").text;
    expect(text).toContain("check button");
    expect(text).not.toMatch(/get report prompt|paste/i);
  });

  it("an author with no DM channel gets no post and nothing throws", async () => {
    const deps = await ready();
    const posts = deps.fake.of("chat.postMessage").length;
    await handleChannelReport(deps, { memberId: "U9", text: i4Block("nope") });
    expect(deps.fake.of("chat.postMessage")).toHaveLength(posts);
  });
});
