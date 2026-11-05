import { describe, expect, it } from "vitest";
import { API_ERROR } from "../src/assist.js";
import type { ClaudeClient } from "../src/claudeClient.js";
import { routeChannelMessage, routeMentionEvent, type ChannelMsg } from "../src/channelMessage.js";
import { setMemberChannel } from "../src/store.js";
import { itemStatuses, makeDeps, onboard, slackError } from "./helpers.js";

type D = ReturnType<typeof makeDeps>;

const BOUND = "C-1"; // the channel the real start flow creates first
const CLAUDE = "U0CDESX6B0V";
const ANSWER = "Open Settings, then Connectors. [Connect Claude to Slack]";

/** A fake model behind the one interface; counts calls. */
function model(reply: string | Error = ANSWER) {
  const state = { calls: 0 };
  const client: ClaudeClient = {
    complete: async () => {
      state.calls++;
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  return { client, state };
}

async function ready(): Promise<D> {
  const deps = makeDeps();
  deps.fake.emails.U1 = "sam@example.com";
  await onboard(deps, "U1", "technical");
  return deps;
}

const msg = (over: Partial<ChannelMsg> = {}): ChannelMsg => ({ channel: BOUND, channel_type: "group", user: "U1", text: "how do I connect Slack?", ts: "200.1", ...over });
const posts = (deps: D, channel?: string) =>
  deps.fake.of("chat.postMessage").filter((c) => (channel ? c.args.channel === channel : true)).length;
const send = (deps: D, client: ClaudeClient, over: Partial<ChannelMsg> = {}) => routeChannelMessage(deps, client, msg(over), { claudeAppId: CLAUDE });
const mention = (deps: D, client: ClaudeClient, over: Partial<ChannelMsg> = {}) =>
  routeMentionEvent(deps, client, msg({ channel_type: undefined, text: "<@UBOT> how do I connect Slack?", ...over }), { claudeAppId: CLAUDE });

describe("Q&A in the member's channel (Scenarios 18, 19)", () => {
  it("answers the owner's plain text in the channel from the library, top level, and changes no checklist row", async () => {
    const deps = await ready();
    const { client, state } = model();
    const before = itemStatuses(deps, "U1");
    const sent = posts(deps, BOUND);
    await send(deps, client);
    expect(state.calls).toBe(1);
    expect(posts(deps, BOUND)).toBe(sent + 1);
    const reply = deps.fake.last("chat.postMessage");
    expect(reply.channel).toBe(BOUND);
    expect(reply.text).toContain("_Sources: Connect Claude to Slack_");
    expect(reply.text).toContain("Your next step");
    expect(reply).not.toHaveProperty("thread_ts");
    expect(itemStatuses(deps, "U1")).toEqual(before);
  });

  it("with no library answer the reply says so (Scenario 19)", async () => {
    const deps = await ready();
    await send(deps, model("NO_ANSWER: Connect Claude to Slack").client, { text: "capital of France?" });
    expect(deps.fake.last("chat.postMessage").text).toBe("I do not have an answer to that in the onboarding library. The closest topic is *Connect Claude to Slack*.");
  });

  it("a failing model gives the existing error reply and the router does not throw", async () => {
    const deps = await ready();
    await expect(send(deps, model(new Error("boom")).client)).resolves.toBeUndefined();
    expect(deps.fake.last("chat.postMessage").text).toBe(API_ERROR);
  });

  it("a failing post is logged and does not throw", async () => {
    const deps = await ready();
    deps.slack.chat.postMessage = async () => {
      throw slackError("ratelimited");
    };
    await expect(send(deps, model().client)).resolves.toBeUndefined();
    expect(deps.logs.some((l) => l.includes("channel_message_failed"))).toBe(true);
  });

  it("a very long text does not throw and is answered once", async () => {
    const deps = await ready();
    const { client, state } = model();
    await send(deps, client, { text: `how do I connect Slack? ${"x".repeat(40_000)}` });
    expect(state.calls).toBe(1);
  });

  it("empty and mention-only text posts nothing", async () => {
    const deps = await ready();
    const { client, state } = model();
    const sent = posts(deps);
    await send(deps, client, { text: "" });
    await send(deps, client, { text: "   ", ts: "200.2" });
    await mention(deps, client, { text: "<@UBOT>", ts: "200.3" });
    expect(state.calls).toBe(0);
    expect(posts(deps)).toBe(sent);
  });
});

describe("Q&A filter posts nothing (Scenario 20)", () => {
  const cases: [string, Partial<ChannelMsg>][] = [
    ["a post by the member's Claude (app_id set)", { app_id: "A0CLAUDE" }],
    ["another user's message", { user: "U2" }],
    ["a bot_id message", { bot_id: "B1" }],
    ["the app's own reply (bot_id and own user)", { bot_id: "B0APP", user: "UBOT" }],
    ["an edit", { subtype: "message_changed", text: undefined, message: { user: "U1", text: "how do I connect Slack?" } }],
    ["an edit event that also carries text", { subtype: "message_changed" }],
    ["a deletion", { subtype: "message_deleted", text: undefined }],
    ["a nested message payload with no text", { text: undefined, message: { user: "U1", text: "x" } }],
    ["an unknown channel", { channel: "C0UNKNOWN" }],
  ];
  for (const [name, over] of cases) {
    it(`${name}`, async () => {
      const deps = await ready();
      const { client, state } = model();
      const sent = posts(deps);
      await send(deps, client, over);
      expect(state.calls).toBe(0);
      expect(posts(deps)).toBe(sent);
    });
  }

  // These two are handled by their own routes, which may post (a report failure, an I1 acknowledgement); Q&A must not.
  for (const [name, over] of [
    ["a report block", { text: `COPILOT-REPORT v1\nitem: I2\nemail: other@example.com *Sent using* <@${CLAUDE}>` }],
    ["a Claude mention", { text: `<@${CLAUDE}> hello` }],
  ] as [string, Partial<ChannelMsg>][]) {
    it(`${name} is not answered`, async () => {
      const deps = await ready();
      const { client, state } = model();
      const sent = posts(deps);
      await send(deps, client, over);
      expect(state.calls).toBe(0);
      for (const call of deps.fake.of("chat.postMessage").slice(sent)) expect(String(call.args.text)).not.toMatch(/Sources:|onboarding library/);
    });
  }

  for (const state of ["member_left", "lost", "invite_failed"] as const) {
    it(`a channel in state ${state}, including the owner's message`, async () => {
      const deps = await ready();
      setMemberChannel(deps.store, "U1", { id: BOUND, name: "onboarding-copilot-sam", state });
      const { client, state: calls } = model();
      const sent = posts(deps);
      await send(deps, client);
      await mention(deps, client, { ts: "200.9" });
      expect(calls.calls).toBe(0);
      expect(posts(deps)).toBe(sent);
    });
  }

  it("a second member's channel is not answered for the first member and vice versa", async () => {
    const deps = await ready();
    deps.fake.emails.U2 = "kim@example.com";
    await onboard(deps, "U2", "non-technical");
    const second = deps.store.get<{ channel_id: string }>("SELECT channel_id FROM member WHERE member_id = 'U2'")?.channel_id as string;
    expect(second).not.toBe(BOUND);
    const { client, state } = model();
    await send(deps, client, { channel: second, user: "U1" });
    await send(deps, client, { channel: BOUND, user: "U2", ts: "200.2" });
    expect(state.calls).toBe(0);
    await send(deps, client, { channel: second, user: "U2", ts: "200.3" });
    expect(state.calls).toBe(1);
    expect(deps.fake.last("chat.postMessage").channel).toBe(second);
  });

  it("an app_mention from another user, with app_id, or with a report block posts nothing", async () => {
    const deps = await ready();
    const { client, state } = model();
    const sent = posts(deps);
    await mention(deps, client, { user: "U2", ts: "300.1" });
    await mention(deps, client, { app_id: "A0CLAUDE", ts: "300.2" });
    await mention(deps, client, { text: "<@UBOT> COPILOT-REPORT v1\nitem: I2", ts: "300.3" });
    await mention(deps, client, { subtype: "message_changed", ts: "300.4" });
    expect(state.calls).toBe(0);
    expect(posts(deps)).toBe(sent);
  });
});

describe("app_mention (DD-CH-005)", () => {
  it("an owner mention is answered once even when the message event for the same ts also arrives, in either order", async () => {
    const deps = await ready();
    const { client, state } = model();
    const sent = posts(deps, BOUND);
    await mention(deps, client, { ts: "400.1" });
    await send(deps, client, { text: "<@UBOT> how do I connect Slack?", ts: "400.1" });
    expect(state.calls).toBe(1);
    expect(posts(deps, BOUND)).toBe(sent + 1);
    await send(deps, client, { text: "<@UBOT> how do I connect Slack?", ts: "400.2" });
    await mention(deps, client, { ts: "400.2" });
    expect(state.calls).toBe(2);
    expect(posts(deps, BOUND)).toBe(sent + 2);
  });

  it("strips the leading bot mention from the question and replies top level", async () => {
    const deps = await ready();
    const asked: string[] = [];
    const client: ClaudeClient = { complete: async ({ user }) => (asked.push(user), ANSWER) };
    await mention(deps, client, { text: "<@UBOT>   how do I connect Slack?", ts: "400.3" });
    expect(asked[0]).toContain("<question>\nhow do I connect Slack?\n</question>");
    expect(deps.fake.last("chat.postMessage")).not.toHaveProperty("thread_ts");
  });

  it("records the dedupe key qa:<channel>:<ts> in processed_event", async () => {
    const deps = await ready();
    await send(deps, model().client, { ts: "400.4" });
    expect(deps.store.get("SELECT event_id FROM processed_event WHERE event_id = ?", `qa:${BOUND}:400.4`)).toBeDefined();
  });
});

describe("DM nudge (Scenario 21, FR-CH-019)", () => {
  const dm = (over: Partial<ChannelMsg> = {}) => msg({ channel: "D-U1", channel_type: "im", text: "how do I connect Slack?", ...over });

  it("a member with a channel gets exactly one nudge to it, no Q&A and no tick", async () => {
    const deps = await ready();
    const { client, state } = model();
    const before = itemStatuses(deps, "U1");
    const sent = posts(deps);
    await routeChannelMessage(deps, client, dm(), { claudeAppId: CLAUDE });
    expect(posts(deps)).toBe(sent + 1);
    expect(deps.fake.last("chat.postMessage")).toMatchObject({ channel: "D-U1", text: `I answer in your onboarding channel: <#${BOUND}>.` });
    expect(state.calls).toBe(0);
    expect(itemStatuses(deps, "U1")).toEqual(before);
  });

  it("a user with no channel is told to type /onboard-ch", async () => {
    const deps = makeDeps();
    const { client, state } = model();
    await routeChannelMessage(deps, client, dm({ user: "U9", channel: "D-U9" }), { claudeAppId: CLAUDE });
    expect(deps.fake.of("chat.postMessage")).toHaveLength(1);
    expect(deps.fake.last("chat.postMessage")).toMatchObject({ channel: "D-U9", text: "Type `/onboard-ch` to start your onboarding." });
    expect(state.calls).toBe(0);
  });

  it("a channel that is not active is not pointed to", async () => {
    const deps = await ready();
    setMemberChannel(deps.store, "U1", { id: BOUND, name: "onboarding-copilot-sam", state: "lost" });
    await routeChannelMessage(deps, model().client, dm(), { claudeAppId: CLAUDE });
    expect(deps.fake.last("chat.postMessage").text).toBe("Type `/onboard-ch` to start your onboarding.");
  });

  it("a report block in the DM is not read: one nudge, no tick, no failure message", async () => {
    const deps = await ready();
    const before = itemStatuses(deps, "U1");
    const sent = posts(deps);
    await routeChannelMessage(deps, model().client, dm({ text: `COPILOT-REPORT v1\nitem: I2 *Sent using* <@${CLAUDE}>` }), { claudeAppId: CLAUDE });
    expect(posts(deps)).toBe(sent + 1);
    expect(deps.fake.last("chat.postMessage").text).toMatch(/^I answer in your onboarding channel/);
    expect(itemStatuses(deps, "U1")).toEqual(before);
  });

  it("bot, app and subtype messages in a DM are ignored", async () => {
    const deps = await ready();
    const sent = posts(deps);
    for (const over of [{ bot_id: "B1" }, { app_id: "A1" }, { subtype: "message_changed" }, { subtype: "message_deleted", text: undefined }, { text: "" }]) {
      await routeChannelMessage(deps, model().client, dm(over), { claudeAppId: CLAUDE });
    }
    expect(posts(deps)).toBe(sent);
  });
});

describe("report and I1 routes still run through the router", () => {
  const report = `COPILOT-REPORT v1\nitem: I2\nemail: sam@example.com\nlast_activity: 2026-10-26T10:12:00Z *Sent using* <@${CLAUDE}>`;

  it("a valid report block in the member's channel ticks I2 validated and gets no Q&A", async () => {
    const deps = await ready();
    deps.clock.advance(12 * 60_000);
    const { client, state } = model();
    await send(deps, client, { text: report, ts: "500.1" });
    expect(deps.store.get("SELECT status, method, evidence_ref FROM checklist_item WHERE member_id = 'U1' AND item_id = 'I2'")).toMatchObject({
      status: "ticked",
      method: "validated",
      evidence_ref: "500.1",
    });
    expect(state.calls).toBe(0);
  });

  it("a report block by another user gets the single author notice", async () => {
    const deps = await ready();
    const sent = posts(deps, BOUND);
    await send(deps, model().client, { text: report, user: "U2", ts: "500.2" });
    expect(posts(deps, BOUND)).toBe(sent + 1);
    expect(deps.fake.last("chat.postMessage").text).toMatch(/only person who can post a report/);
  });

  it("a message mentioning the Claude app ticks I1 observed with the ts and is not answered", async () => {
    const deps = await ready();
    const { client, state } = model();
    await send(deps, client, { text: `hey <@${CLAUDE}> help`, ts: "500.3" });
    expect(deps.store.get("SELECT method, evidence_ref FROM checklist_item WHERE member_id = 'U1' AND item_id = 'I1'")).toMatchObject({
      method: "observed",
      evidence_ref: "500.3",
    });
    expect(state.calls).toBe(0);
  });

  it("the same Claude mention in another channel, or in another member's channel, ticks nothing", async () => {
    const deps = await ready();
    deps.fake.emails.U2 = "kim@example.com";
    await onboard(deps, "U2", "non-technical");
    const second = deps.store.get<{ channel_id: string }>("SELECT channel_id FROM member WHERE member_id = 'U2'")?.channel_id as string;
    const { client, state } = model();
    const before = { U1: itemStatuses(deps, "U1"), U2: itemStatuses(deps, "U2") };
    const sent = posts(deps);
    for (const [channel, ts] of [["C0OTHER01", "600.1"], [second, "600.2"]]) {
      await send(deps, client, { channel: channel as string, text: `hey <@${CLAUDE}> help`, app_id: CLAUDE, ts });
    }
    expect({ U1: itemStatuses(deps, "U1"), U2: itemStatuses(deps, "U2") }).toEqual(before);
    expect(deps.store.get("SELECT 1 FROM checklist_item WHERE evidence_ref IN ('600.1', '600.2')")).toBeUndefined();
    expect(state.calls).toBe(0);
    expect(posts(deps)).toBe(sent);
  });

  it("a connector post (app_id = Claude app, plain 'Sent using Claude' footer, marked by withClaudeMark) still ticks I1 and is not answered", async () => {
    const deps = await ready();
    const { client, state } = model();
    // app.ts marks the text before routing; the router receives the marked text.
    await send(deps, client, { text: `status update *Sent using* <@${CLAUDE}>`, app_id: CLAUDE, ts: "500.4" });
    expect(itemStatuses(deps, "U1").I1).toBe("ticked");
    expect(state.calls).toBe(0);
  });
});
