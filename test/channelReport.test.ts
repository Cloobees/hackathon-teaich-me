import { withClaudeMark } from "../src/verify.js";
import { describe, expect, it } from "vitest";
import { setReportChannel } from "../src/store.js";
import { handleAttest, handleChannelMessage, handleChannelReport } from "../src/verify.js";
import { itemStatuses, makeDeps, onboard } from "./helpers.js";

type D = ReturnType<typeof makeDeps>;

const BOUND = "C0BOUND01";
const OTHER = "C0OTHER01";
// Fields of the connector's message observed 2026-11-02 (.claude/evidence/BP-045/sp1.md): user is the member, no bot_id, no subtype.
// A report counts by channel, author and this mark (DD-VF-014, no nonce).
const SENT_USING = " *Sent using* <@U0CDESX6B0V>";
const i2Block = (activity = "2026-10-26T10:12:00Z") =>
  `COPILOT-REPORT v1\nitem: I2\nemail: sam@example.com\nlast_activity: ${activity}${SENT_USING}`;
const i4Block = `COPILOT-REPORT v1\nitem: I4\nskill: copilot-check${SENT_USING}`;
const i6Block = `COPILOT-REPORT v1\nitem: I6\nsite_count: 2${SENT_USING}`;

async function ready(attestI1 = true): Promise<D> {
  const deps = makeDeps();
  deps.fake.emails.U1 = "sam@example.com";
  await onboard(deps, "U1", "technical");
  setReportChannel(deps.store, "U1", { name: "claude-sam", id: BOUND });
  if (attestI1) await handleAttest(deps, "U1", "I1");
  deps.clock.advance(12 * 60_000);
  return deps;
}
const report = (deps: D, text: string, ts = "1.1", user = "U1", channel = BOUND, claudeAppId: string | undefined = "U0CDESX6B0V") =>
  handleChannelReport(deps, { channel, user, text, ts, claudeAppId });
const posts = (deps: D) => deps.fake.of("chat.postMessage").length;
const row = (deps: D, item: string) =>
  deps.store.get("SELECT status, method, evidence_ref FROM checklist_item WHERE member_id = 'U1' AND item_id = ?", item);

describe("channel report listener (BP-075)", () => {
  it("a valid I2 block by the member in the bound channel ticks I2 validated with the message ts and posts nothing in the channel (Scenario 2)", async () => {
    const deps = await ready();
    const dmPosts = deps.fake.of("chat.postMessage").filter((c) => c.args.channel === "D-U1").length;
    await report(deps, i2Block(), "1700000000.000100");
    expect(row(deps, "I2")).toMatchObject({ status: "ticked", method: "validated", evidence_ref: "1700000000.000100" });
    expect(deps.fake.of("chat.postMessage").filter((c) => c.args.channel === BOUND)).toHaveLength(0);
    // The only DM is the next instruction from the tick (FR-CL-011), not a failure message.
    expect(deps.fake.of("chat.postMessage").filter((c) => c.args.channel === "D-U1")).toHaveLength(dmPosts + 1);
    expect(deps.fake.last("chat.postMessage").text).not.toMatch(/did not|already used|another member/);
  });

  it("a valid I4 block ticks I4 and I3 validated with one evidence_ref (Scenario 7)", async () => {
    const deps = await ready();
    await report(deps, i4Block, "3.3");
    const rows = deps.store.all<{ item_id: string; method: string; evidence_ref: string }>(
      "SELECT item_id, method, evidence_ref FROM checklist_item WHERE member_id = 'U1' AND item_id IN ('I3','I4')",
    );
    expect(rows.map((r) => r.method)).toEqual(["validated", "validated"]);
    expect(new Set(rows.map((r) => r.evidence_ref))).toEqual(new Set(["3.3"]));
  });

  it("a valid I6 block ticks I6", async () => {
    const deps = await ready();
    await report(deps, i6Block, "4.4");
    expect(row(deps, "I6")).toMatchObject({ method: "validated", evidence_ref: "4.4" });
  });

  it("the exact observed text, with ' *Sent using* <@U0CDESX6B0V>' on the skill line, ticks I4 (Scenario 1, FR-VF-016)", async () => {
    const deps = await ready();
    await report(deps, "COPILOT-REPORT v1\nitem: I4\nskill: copilot-check *Sent using* <@U0CDESX6B0V>");
    expect(itemStatuses(deps, "U1").I4).toBe("ticked");
  });

  it("a report in a channel that is no member's bound channel is ignored: no tick, no DM (FR-VF-012, Scenario 8)", async () => {
    const deps = await ready();
    const before = posts(deps);
    await report(deps, i2Block(), "5.5", "U1", OTHER);
    expect(posts(deps)).toBe(before);
    expect(itemStatuses(deps, "U1").I2).toBe("pending");
  });

  it("another member's post in a member's bound channel sends one DM to the poster naming the author rule and ticks nothing (FR-VF-017, Scenario 12)", async () => {
    const deps = await ready();
    const before = posts(deps);
    await report(deps, i4Block, "6.6", "U2");
    expect(posts(deps)).toBe(before + 1);
    expect(deps.fake.last("chat.postMessage")).toMatchObject({ channel: "D-U2" });
    expect(deps.fake.last("chat.postMessage").text).toContain("another member's channel");
    expect(itemStatuses(deps, "U1").I4).toBe("pending");
    expect(itemStatuses(deps, "U1").I3).toBe("pending");
  });

  it("a repeat block changes nothing and sends nothing (Scenario 4)", async () => {
    const deps = await ready();
    await report(deps, i2Block(), "1.1");
    const before = posts(deps);
    const updates = deps.fake.of("chat.update").length;
    await report(deps, i2Block(), "2.2");
    expect(posts(deps)).toBe(before);
    expect(deps.fake.of("chat.update")).toHaveLength(updates);
    expect(row(deps, "I2")).toMatchObject({ evidence_ref: "1.1" });
  });

  it("an invalid block (activity before role_chosen_at) leaves I2 pending and sends one DM to the member naming the activity rule (Scenario 3)", async () => {
    const deps = await ready();
    const before = posts(deps);
    await report(deps, i2Block("2026-10-26T09:40:00Z"));
    expect(posts(deps)).toBe(before + 1);
    expect(deps.fake.last("chat.postMessage")).toMatchObject({ channel: "D-U1" });
    expect(deps.fake.last("chat.postMessage").text).toContain("Create a note in Context Builder");
    expect(itemStatuses(deps, "U1").I2).toBe("pending");
  });

  it("a block without the Claude mark leaves I2 pending and sends one DM naming the rule (Scenario 1)", async () => {
    const deps = await ready();
    const before = posts(deps);
    await report(deps, i2Block().replace(SENT_USING, ""));
    expect(posts(deps)).toBe(before + 1);
    expect(deps.fake.last("chat.postMessage").text).toContain("through its Slack connector");
    expect(itemStatuses(deps, "U1").I2).toBe("pending");
  });

  it("failure messages tell the member to have Claude post it again, never the check button, Get report prompt or paste", async () => {
    const deps = await ready();
    await report(deps, "COPILOT-REPORT v1\nitem: I4\nskill: other" + SENT_USING);
    const text = deps.fake.last("chat.postMessage").text;
    expect(text).toContain("copilot-check");
    expect(text).not.toMatch(/check button|get report prompt|paste/i);
  });

  it("a message in the bound channel with no report block is not read", async () => {
    const deps = await ready();
    const before = posts(deps);
    await report(deps, "just a note", "7.7", "U2");
    expect(posts(deps)).toBe(before);
  });
});

describe("I1 mention listener in the bound channel (FR-VF-003, FR-VF-017)", () => {
  it("the member's Claude welcome message with the Claude mark in the bound channel ticks I1 observed with the message ts", async () => {
    const deps = await ready(false);
    await handleChannelMessage(deps, { memberId: "U1", text: `Hello from my Claude${SENT_USING}`, ts: "8.8", claudeAppId: "U0CDESX6B0V" });
    expect(row(deps, "I1")).toMatchObject({ status: "ticked", method: "observed", evidence_ref: "8.8" });
  });
});

describe("Claude app id and harness repo reach the rules (Scenarios 1 and 15)", () => {
  const i5Block = (repo: string) => `COPILOT-REPORT v1
item: I5
repo: ${repo}${SENT_USING}`;

  it("while the Claude app id is unknown no report ticks; the member gets one DM naming the Claude rule", async () => {
    const deps = await ready();
    const before = posts(deps);
    await handleChannelReport(deps, { channel: BOUND, user: "U1", text: i2Block(), ts: "9.1" });
    expect(itemStatuses(deps, "U1").I2).toBe("pending");
    expect(posts(deps)).toBe(before + 1);
    expect(deps.fake.last("chat.postMessage").text).toContain("through its Slack connector");
  });

  it("a mark naming some other user does not tick", async () => {
    const deps = await ready();
    await report(deps, i2Block().replace("U0CDESX6B0V", "U0SOMEONE"));
    expect(itemStatuses(deps, "U1").I2).toBe("pending");
  });

  it("with HARNESS_REPO set, a different repo leaves I5 pending and the same repo ticks it", async () => {
    const deps = await ready();
    deps.harnessRepo = "synechron/harness";
    const before = posts(deps);
    await report(deps, i5Block("other/repo"), "9.2");
    expect(itemStatuses(deps, "U1").I5).toBe("pending");
    expect(posts(deps)).toBe(before + 1);
    expect(deps.fake.last("chat.postMessage").text).toMatch(/repo/i);
    await report(deps, i5Block("Synechron/Harness"), "9.3");
    expect(itemStatuses(deps, "U1").I5).toBe("ticked");
  });

  it("with HARNESS_REPO unset, any non-empty repo ticks I5", async () => {
    const deps = await ready();
    await report(deps, i5Block("any/repo"), "9.4");
    expect(itemStatuses(deps, "U1").I5).toBe("ticked");
  });
});

describe("withClaudeMark", () => {
  const APP = "A08SF47R6P4";
  it("rewrites a plain 'Sent using Claude' footer to the mention form when the event app_id is the Claude app", () => {
    expect(withClaudeMark("Hello *Sent using* Claude", APP, APP)).toBe(`Hello *Sent using* <@${APP}>`);
  });
  it("leaves the text alone for another app_id, no app_id, or no configured id", () => {
    const text = "Hello *Sent using* Claude";
    expect(withClaudeMark(text, "A0OTHER", APP)).toBe(text);
    expect(withClaudeMark(text, undefined, APP)).toBe(text);
    expect(withClaudeMark(text, APP, undefined)).toBe(text);
  });
  it("does not rewrite a footer typed in the middle of a message", () => {
    const text = "*Sent using* Claude and more";
    expect(withClaudeMark(text, APP, APP)).toBe(text);
  });
});
