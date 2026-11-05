import { withClaudeMark } from "../src/verify.js";
import { describe, expect, it } from "vitest";
import { setMemberChannel } from "../src/store.js";
import { handleAttest, handleChannelMessage, handleChannelReport } from "../src/verify.js";
import { itemStatuses, makeDeps, onboard, slackError } from "./helpers.js";

type D = ReturnType<typeof makeDeps>;

// The member's own channel: created and stored by the real start flow (FakeSlack numbers the first one C-1); reports are read there.
const BOUND = "C-1";
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
  if (attestI1) await handleAttest(deps, "U1", "I1");
  deps.clock.advance(12 * 60_000);
  return deps;
}
const report = (deps: D, text: string, ts = "1.1", user = "U1", channel = BOUND, claudeAppId: string | undefined = "U0CDESX6B0V") =>
  handleChannelReport(deps, { channel, user, text, ts, claudeAppId });
const posts = (deps: D) => deps.fake.of("chat.postMessage").length;
const opens = (deps: D) => deps.fake.of("conversations.open").length;
const FAILURE_OR_NOTICE = /did not|already used|another member|does not look|not read|only person/;
const row = (deps: D, item: string) =>
  deps.store.get("SELECT status, method, evidence_ref FROM checklist_item WHERE member_id = 'U1' AND item_id = ?", item);

describe("channel report listener (BP-075)", () => {
  it("a valid I2 block by the member in the bound channel ticks I2 validated with the message ts and posts no failure or notice (Scenario 2)", async () => {
    const deps = await ready();
    const channelPosts = () => deps.fake.of("chat.postMessage").filter((c) => c.args.channel === BOUND);
    const before = channelPosts().length;
    await report(deps, i2Block(), "1700000000.000100");
    expect(row(deps, "I2")).toMatchObject({ status: "ticked", method: "validated", evidence_ref: "1700000000.000100" });
    // The tick itself posts the acknowledgement and the next instruction in the member channel (FR-CL-011): one message, no failure text.
    expect(channelPosts()).toHaveLength(before + 1);
    for (const call of channelPosts()) expect(String(call.args.text)).not.toMatch(FAILURE_OR_NOTICE);
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

  it("a report in a channel that is no member's stored channel is ignored: no tick, no post, no DM call (FR-CH-016, Scenario 14)", async () => {
    const deps = await ready();
    const before = posts(deps);
    const opened = opens(deps);
    await report(deps, i2Block(), "5.5", "U1", OTHER);
    await report(deps, i2Block(), "5.6", "U2", OTHER);
    expect(posts(deps)).toBe(before);
    expect(opens(deps)).toBe(opened);
    expect(itemStatuses(deps, "U1").I2).toBe("pending");
  });

  it("another member's post in a member's channel puts one notice in that channel naming the owner as the only valid author, ticks nothing and opens no DM (FR-CH-016, Scenario 14)", async () => {
    const deps = await ready();
    const before = posts(deps);
    const opened = opens(deps);
    await report(deps, i4Block, "6.6", "U2");
    expect(posts(deps)).toBe(before + 1);
    expect(deps.fake.last("chat.postMessage")).toMatchObject({ channel: BOUND });
    expect(deps.fake.last("chat.postMessage").text).toContain("<@U1>");
    expect(deps.fake.last("chat.postMessage").text).toMatch(/only person/);
    expect(opens(deps)).toBe(opened);
    expect(deps.fake.of("chat.postMessage").slice(before).some((c) => c.args.channel === "D-U2")).toBe(false);
    expect(itemStatuses(deps, "U1").I4).toBe("pending");
    expect(itemStatuses(deps, "U1").I3).toBe("pending");
  });

  it("a non-owner's valid-looking block is refused too, and each post gets its own notice", async () => {
    const deps = await ready();
    const before = posts(deps);
    await report(deps, i2Block(), "6.7", "U2");
    await report(deps, i2Block(), "6.8", "U2");
    expect(posts(deps)).toBe(before + 2);
    expect(itemStatuses(deps, "U1").I2).toBe("pending");
  });

  it("two members never share a channel: a report in the second member's channel by the first is a non-owner post naming the second", async () => {
    const deps = await ready();
    await onboard(deps, "U2", "technical");
    const second = deps.store.get<{ channel_id: string }>("SELECT channel_id FROM member WHERE member_id = 'U2'")?.channel_id as string;
    expect(second).not.toBe(BOUND);
    await report(deps, i2Block(), "6.9", "U1", second);
    expect(deps.fake.last("chat.postMessage")).toMatchObject({ channel: second });
    expect(deps.fake.last("chat.postMessage").text).toContain("<@U2>");
    expect(itemStatuses(deps, "U1").I2).toBe("pending");
    expect(itemStatuses(deps, "U2").I2).toBe("pending");
  });

  it.each(["lost", "member_left"] as const)("a report in a channel whose state is %s is still routed by its stored id", async (state) => {
    const deps = await ready();
    setMemberChannel(deps.store, "U1", { id: BOUND, name: "onboarding-copilot-u1", state });
    const before = posts(deps);
    await report(deps, i4Block, "6.10", "U2");
    expect(posts(deps)).toBe(before + 1);
    expect(deps.fake.last("chat.postMessage")).toMatchObject({ channel: BOUND });
    await report(deps, i2Block("2026-10-26T09:40:00Z"));
    expect(deps.fake.last("chat.postMessage")).toMatchObject({ channel: BOUND });
    expect(deps.fake.last("chat.postMessage").text).toContain("Create a note in Context Builder");
    await report(deps, i2Block(), "6.11");
    expect(row(deps, "I2")).toMatchObject({ status: "ticked", method: "validated" });
  });

  it("a notice or failure into a gone channel does not throw: the channel is marked lost", async () => {
    const deps = await ready();
    deps.slack.chat.postMessage = async () => {
      throw slackError("channel_not_found");
    };
    await expect(report(deps, i4Block, "6.12", "U2")).resolves.toBeUndefined();
    expect(deps.store.get("SELECT channel_state FROM member WHERE member_id = 'U1'")).toEqual({ channel_state: "lost" });
    await expect(report(deps, i2Block("2026-10-26T09:40:00Z"))).resolves.toBeUndefined();
    expect(itemStatuses(deps, "U1").I2).toBe("pending");
  });

  it("any other post failure is logged and not thrown", async () => {
    const deps = await ready();
    deps.slack.chat.postMessage = async () => {
      throw slackError("ratelimited");
    };
    await expect(report(deps, i4Block, "6.13", "U2")).resolves.toBeUndefined();
    expect(deps.logs.some((l) => l.includes("report_post_failed"))).toBe(true);
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

  it("an invalid block (activity before role_chosen_at) leaves I2 pending and posts the failure naming the activity rule in the channel, with no DM call (FR-CH-015, Scenario 13)", async () => {
    const deps = await ready();
    const before = posts(deps);
    const opened = opens(deps);
    await report(deps, i2Block("2026-10-26T09:40:00Z"));
    expect(posts(deps)).toBe(before + 1);
    expect(deps.fake.last("chat.postMessage")).toMatchObject({ channel: BOUND });
    expect(deps.fake.last("chat.postMessage").text).toContain("Create a note in Context Builder");
    expect(opens(deps)).toBe(opened);
    expect(deps.fake.of("chat.postMessage").slice(before).some((c) => c.args.channel === "D-U1")).toBe(false);
    expect(itemStatuses(deps, "U1").I2).toBe("pending");
  });

  it("a block without the Claude mark leaves I2 pending and posts one failure in the channel naming the rule (Scenario 1)", async () => {
    const deps = await ready();
    const before = posts(deps);
    await report(deps, i2Block().replace(SENT_USING, ""));
    expect(posts(deps)).toBe(before + 1);
    expect(deps.fake.last("chat.postMessage")).toMatchObject({ channel: BOUND });
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

  it("while the Claude app id is unknown no report ticks; the channel gets one message naming the Claude rule", async () => {
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
