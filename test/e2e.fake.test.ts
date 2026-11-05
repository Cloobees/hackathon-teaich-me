import { describe, expect, it } from "vitest";
import { getMetrics } from "../src/aggregate.js";
import { routeChannelMessage, routeMentionEvent, type ChannelMsg } from "../src/channelMessage.js";
import type { ClaudeClient } from "../src/claudeClient.js";
import { handleOnboard, handleRole } from "../src/start.js";
import { handleAttest, withClaudeMark } from "../src/verify.js";
import { itemStatuses, makeDeps, SKILL_ZIP, type Call } from "./helpers.js";

// End-to-end smoke (BP-107): the real handlers wired as src/app.ts wires them, on FakeSlack and a fake Claude client.
// One technical member, U1, goes from /onboard-ch to completion; every app call must land in the one channel (C-1) except the link DM.
type D = ReturnType<typeof makeDeps>;

const MEMBER = "U1";
const CHANNEL = "C-1"; // the first channel FakeSlack creates
const DM = "D-U1"; // FakeSlack's conversations.open result for U1
const CLAUDE = "U0CDESX6B0V"; // the Claude app: its user id and the app_id of its posts (as in channelReport.test.ts)
const SENT_USING = ` *Sent using* <@${CLAUDE}>`;
const ANSWER = "Open Settings, then Connectors. [Connect Claude to Slack]";

/** A fake model behind the one interface; counts calls. */
function model() {
  const state = { calls: 0 };
  const client: ClaudeClient = {
    complete: async () => {
      state.calls++;
      return ANSWER;
    },
  };
  return { client, state };
}

/** app.message in src/app.ts: the connector footer is marked, then the message is routed. */
const hear = (deps: D, claude: ClaudeClient, msg: ChannelMsg) =>
  routeChannelMessage(deps, claude, msg.text ? { ...msg, text: withClaudeMark(msg.text, msg.app_id, CLAUDE) } : msg, { claudeAppId: CLAUDE });
const fromMember = (text: string, ts: string): ChannelMsg => ({ channel: CHANNEL, channel_type: "group", user: MEMBER, text, ts });
const fromClaude = (text: string, ts: string): ChannelMsg => ({ ...fromMember(text, ts), app_id: CLAUDE });

const posts = (deps: D) => deps.fake.of("chat.postMessage").map((c) => c.args as { channel: string; text: string; blocks?: unknown[] });
const inChannel = (deps: D) => posts(deps).filter((p) => p.channel === CHANNEL);
const member = (deps: D) =>
  deps.store.get<Record<string, string | null>>(
    "SELECT role, role_chosen_at, completed_at, channel_id, channel_name, channel_state, checklist_ts, checklist_canvas_id, canvas_surface FROM member WHERE member_id = ?",
    MEMBER,
  ) as Record<string, string | null>;
const row = (deps: D, item: string) =>
  deps.store.get("SELECT status, method, evidence_ref FROM checklist_item WHERE member_id = ? AND item_id = ?", MEMBER, item);

/** The channel id every app call named, from every method that names one, with the link DM left out. */
function targets(deps: D): Set<string> {
  const named = (c: Call): unknown[] => {
    switch (c.method) {
      case "chat.postMessage":
      case "chat.update":
      case "pins.add":
      case "conversations.invite":
        return [c.args.channel];
      case "files.uploadV2":
      case "conversations.canvases.create":
        return [c.args.channel_id];
      default:
        return [];
    }
  };
  return new Set(deps.fake.calls.flatMap(named).filter((id) => id !== DM) as string[]);
}

function newDeps(surface?: "canvas" | "message"): D {
  const deps = makeDeps({ checklistSurface: surface, glossaryUrl: "https://example.invalid/glossary", skillZipPath: SKILL_ZIP });
  deps.fake.emails[MEMBER] = "sam@example.com";
  deps.fake.profiles[MEMBER] = { real_name: "Sam Member" };
  return deps;
}

/** `/onboard-ch` by the member, then the owner's role click on the role question the app posted. Asserts the start. */
async function startAndChooseRole(deps: D): Promise<void> {
  const reply = await handleOnboard(deps, { callerId: MEMBER, text: "", triggerId: "TRIG1" });
  expect(reply).toContain(`<#${CHANNEL}>`);

  // ONE private channel, the member invited into it.
  expect(deps.fake.of("conversations.create")).toHaveLength(1);
  expect(deps.fake.of("conversations.create")[0]?.args).toMatchObject({ name: "onboarding-copilot-sam-member", is_private: true });
  expect(deps.fake.of("conversations.invite")).toHaveLength(1);
  expect(deps.fake.of("conversations.invite")[0]?.args).toMatchObject({ channel: CHANNEL, users: MEMBER });
  expect(member(deps)).toMatchObject({ channel_id: CHANNEL, channel_name: "onboarding-copilot-sam-member", channel_state: "active", role: null });

  // The channel's first two app posts: the welcome (glossary line first), then the role question with two buttons.
  const [welcome, question] = inChannel(deps);
  expect(welcome?.text.split("\n")[0]).toContain("https://example.invalid/glossary");
  expect(welcome?.text).toContain("Fixture first message");
  expect(question?.text).toContain("Which describes you better?");
  const buttons = JSON.stringify(question?.blocks);
  expect(buttons).toContain("role_technical");
  expect(buttons).toContain("role_non-technical");
  expect(inChannel(deps)).toHaveLength(2);

  // The member's DM holds exactly one app message: the link.
  const dm = posts(deps).filter((p) => p.channel === DM);
  expect(dm).toHaveLength(1);
  expect(dm[0]?.text).toContain(`<#${CHANNEL}>`);
  expect(dm[0]?.text).toContain(`channel=${CHANNEL}`);

  // The owner's click stores the role and creates the checklist.
  const roleTs = `100.${String(posts(deps).indexOf(question as never) + 1).padStart(3, "0")}`;
  deps.clock.advance(60_000);
  await handleRole(deps, { memberId: MEMBER, role: "technical", channel: CHANNEL, messageTs: roleTs });
  expect(member(deps)).toMatchObject({ role: "technical", role_chosen_at: deps.clock.now() });
  expect(deps.fake.of("chat.update")[0]?.args).toMatchObject({ channel: CHANNEL, ts: roleTs });
  expect(String((deps.fake.of("chat.update")[0]?.args as { text: string }).text)).toContain("technical");
  expect(deps.store.all("SELECT * FROM checklist_item WHERE member_id = ?", MEMBER)).toHaveLength(7);
}

/** Everything after the role click, shared by both surfaces. Returns once the member has completed. */
async function walkChecklist(deps: D): Promise<{ model: ReturnType<typeof model> }> {
  const claude = model();

  // I1: a message in the member's channel from the member's Claude, with the connector footer, mentions the Claude app.
  await hear(deps, claude.client, fromClaude(`Hello from Claude, I can post in this channel.${SENT_USING}`, "200.001"));
  expect(row(deps, "I1")).toEqual({ status: "ticked", method: "observed", evidence_ref: "200.001" });
  expect(claude.state.calls).toBe(0);

  // A how-to question by the owner is answered from the library, once, in the channel, and changes no checklist row.
  const before = itemStatuses(deps, MEMBER);
  const sent = inChannel(deps).length;
  await hear(deps, claude.client, fromMember("how do I connect Slack?", "200.002"));
  await routeMentionEvent(deps, claude.client, { ...fromMember("<@UBOT> how do I connect Slack?", "200.002"), channel_type: undefined }, { claudeAppId: CLAUDE });
  expect(claude.state.calls).toBe(1); // the message event and the app_mention for the same ts give one answer
  expect(inChannel(deps)).toHaveLength(sent + 1);
  const reply = inChannel(deps).at(-1);
  expect(reply?.text).toContain("_Sources: Connect Claude to Slack_");
  expect(reply?.text).toContain("Your next step: 2. Connect Claude to Context Builder");
  expect(itemStatuses(deps, MEMBER)).toEqual(before);

  // A post by the member's own Claude (app_id set) is not answered.
  await hear(deps, claude.client, fromClaude("how do I connect Slack?", "200.003"));
  expect(claude.state.calls).toBe(1);
  expect(inChannel(deps)).toHaveLength(sent + 1);

  // I2: a valid COPILOT-REPORT posted in the channel, email equal to the profile email, activity after the role was chosen.
  deps.clock.advance(12 * 60_000);
  const i2 = `COPILOT-REPORT v1\nitem: I2\nemail: SAM@example.com\nlast_activity: ${deps.clock.now()}${SENT_USING}`;
  await hear(deps, claude.client, fromClaude(i2, "200.004"));
  expect(row(deps, "I2")).toEqual({ status: "ticked", method: "validated", evidence_ref: "200.004" });

  // I3 by its report, so the I4 instruction is posted and the skill zip follows it into the channel.
  expect(deps.fake.of("files.uploadV2")).toHaveLength(0);
  await hear(deps, claude.client, fromClaude(`COPILOT-REPORT v1\nitem: I3\nproject_name: Onboarding${SENT_USING}`, "200.005"));
  expect(row(deps, "I3")).toMatchObject({ status: "ticked", method: "validated" });
  expect(deps.fake.of("files.uploadV2")).toHaveLength(1);
  expect(deps.fake.of("files.uploadV2")[0]?.args).toMatchObject({ channel_id: CHANNEL, filename: "copilot-check.zip" });

  // I4 by a valid report.
  await hear(deps, claude.client, fromClaude(`COPILOT-REPORT v1\nitem: I4\nskill: copilot-check${SENT_USING}`, "200.006"));
  expect(row(deps, "I4")).toEqual({ status: "ticked", method: "validated", evidence_ref: "200.006" });

  // I5, I6, I7 by "I did it".
  await handleAttest(deps, MEMBER, "I5");
  await handleAttest(deps, MEMBER, "I6");
  expect(member(deps).completed_at).toBeNull();
  expect(posts(deps).filter((p) => p.text.startsWith("You have finished onboarding"))).toHaveLength(0);
  deps.clock.advance(60_000);
  await handleAttest(deps, MEMBER, "I7");

  // Completion: completed_at set once, one completion message in the channel; a repeat changes nothing.
  const completedAt = member(deps).completed_at;
  expect(completedAt).toBe(deps.clock.now());
  expect(Object.values(itemStatuses(deps, MEMBER))).toEqual(Array(7).fill("ticked"));
  const completion = () => inChannel(deps).filter((p) => p.text.startsWith("You have finished onboarding"));
  expect(completion()).toHaveLength(1);
  deps.clock.advance(60_000);
  await handleAttest(deps, MEMBER, "I7");
  expect(member(deps).completed_at).toBe(completedAt);
  expect(completion()).toHaveLength(1);
  return { model: claude };
}

/** What holds for both surfaces: one channel, one DM, one dashboard member. */
function expectOneChannelAndDashboard(deps: D): void {
  expect(deps.fake.of("conversations.create")).toHaveLength(1);
  expect([...targets(deps)]).toEqual([CHANNEL]);
  expect(posts(deps).filter((p) => p.channel === DM)).toHaveLength(1);
  const { groups } = getMetrics(deps.store, deps.items);
  expect(groups.all).toMatchObject({ started: { total: 1, seeded: 0 }, completed: { total: 1, seeded: 0 }, completionRate: 100, inProgress: { total: 0 } });
  expect(groups.technical).toMatchObject({ started: { total: 1 }, completed: { total: 1 } });
  expect(groups["non-technical"]).toMatchObject({ started: { total: 0 }, completed: { total: 0 } });
  expect(deps.logs.filter((l) => /_failed|"error"/.test(l))).toEqual([]);
}

describe("end to end on the fake clients (BP-107)", () => {
  it("message surface: /onboard-ch to completion in one channel, with one pinned checklist message", async () => {
    const deps = newDeps(); // CHECKLIST_SURFACE unset is the default, `message`
    await startAndChooseRole(deps);

    // One checklist message in the channel, pinned, no canvas.
    const checklist = inChannel(deps).filter((p) => p.text.startsWith("Your onboarding checklist"));
    expect(checklist).toHaveLength(1);
    const ts = member(deps).checklist_ts as string;
    expect(deps.fake.of("pins.add")).toHaveLength(1);
    expect(deps.fake.of("pins.add")[0]?.args).toEqual({ channel: CHANNEL, timestamp: ts });
    expect(deps.fake.of("conversations.canvases.create")).toHaveLength(0);

    await walkChecklist(deps);

    // The one message was edited in place on every tick (7 ticks), never posted again.
    const edits = deps.fake.of("chat.update").filter((c) => (c.args as { ts: string }).ts === ts);
    expect(edits).toHaveLength(7);
    expect((edits.at(-1)?.args as { text: string }).text).toContain("7 of 7 done");
    expect(inChannel(deps).filter((p) => p.text.startsWith("Your onboarding checklist"))).toHaveLength(1);
    expect(member(deps)).toMatchObject({ canvas_surface: null, checklist_canvas_id: null });
    expectOneChannelAndDashboard(deps);
  });

  it("canvas surface: /onboard-ch to completion in one channel, with one canvas and no getContent call", async () => {
    const deps = newDeps("canvas");
    await startAndChooseRole(deps);

    // One canvas created for the channel; a short message points to it; nothing pinned.
    expect(deps.fake.of("conversations.canvases.create")).toHaveLength(1);
    expect(deps.fake.of("conversations.canvases.create")[0]?.args).toMatchObject({ channel_id: CHANNEL });
    expect(member(deps)).toMatchObject({ canvas_surface: "canvas", checklist_canvas_id: "F-1", checklist_ts: null });
    expect(inChannel(deps).filter((p) => /Canvas tab/.test(p.text))).toHaveLength(1);
    expect(deps.fake.of("pins.add")).toHaveLength(0);
    expect(inChannel(deps).filter((p) => /\d of 7 done/.test(p.text))).toHaveLength(0); // no message-surface checklist

    await walkChecklist(deps);

    // Each of the 7 ticks was a lookup then one replace; the app never reads the canvas back; every task line is ticked.
    expect(deps.fake.of("canvases.sections.lookup")).toHaveLength(7);
    expect(deps.fake.of("canvases.edit")).toHaveLength(7);
    expect(deps.fake.calls.filter((c) => /getContent/.test(c.method))).toHaveLength(0);
    const lines = deps.fake.canvasBodies["F-1"]?.split("\n").filter((l) => l.startsWith("- [")) ?? [];
    expect(lines).toHaveLength(7);
    expect(lines.every((l) => l.startsWith("- [x]"))).toBe(true);
    expect(deps.fake.of("chat.update")).toHaveLength(1); // only the role question
    expectOneChannelAndDashboard(deps);
  });

  it("a validated I4 report ticks I3 as well when I3 is still pending (skip ahead)", async () => {
    const deps = newDeps();
    await startAndChooseRole(deps);
    const claude = model();
    deps.clock.advance(60_000);
    await hear(deps, claude.client, fromClaude(`COPILOT-REPORT v1\nitem: I2\nemail: sam@example.com\nlast_activity: ${deps.clock.now()}${SENT_USING}`, "300.001"));
    await hear(deps, claude.client, fromClaude(`COPILOT-REPORT v1\nitem: I4\nskill: copilot-check${SENT_USING}`, "300.002"));
    expect(row(deps, "I3")).toEqual({ status: "ticked", method: "validated", evidence_ref: "300.002" });
    expect(row(deps, "I4")).toEqual({ status: "ticked", method: "validated", evidence_ref: "300.002" });
  });

  it("an operator reset detaches the channel; the next start makes a new one with the welcome and role question and a second link DM", async () => {
    const deps = newDeps();
    await startAndChooseRole(deps);
    const claude = model();
    await hear(deps, claude.client, fromClaude(`Hello from Claude${SENT_USING}`, "400.001"));
    expect(row(deps, "I1")).toMatchObject({ status: "ticked" });
    const welcomes = () => inChannel(deps).filter((p) => p.text.includes("Fixture first message")).length;
    const questions = () => inChannel(deps).filter((p) => p.text.includes("Which describes you better?")).length;
    expect([welcomes(), questions()]).toEqual([1, 1]);

    const reset = await handleOnboard(deps, { callerId: "UOP1", text: `reset <@${MEMBER}>` });
    expect(reset).toContain(`Reset <@${MEMBER}>`);
    expect(member(deps)).toMatchObject({ role: null, role_chosen_at: null, completed_at: null, checklist_ts: null, channel_id: CHANNEL, channel_name: "onboarding-copilot-sam-member", channel_state: "lost" });
    expect(deps.store.all("SELECT * FROM checklist_item WHERE member_id = ?", MEMBER)).toHaveLength(0);

    const restart = await handleOnboard(deps, { callerId: MEMBER, text: "", triggerId: "TRIG2" });
    const NEW = "C-2";
    expect(restart).toBe(`I have created your onboarding channel: <#${NEW}>. Open it to start.`);
    expect(deps.fake.of("conversations.create")).toHaveLength(2);
    expect(deps.fake.of("conversations.invite")).toHaveLength(2);
    expect([welcomes(), questions()]).toEqual([1, 1]); // the old channel gets nothing more
    const inNew = posts(deps).filter((p) => p.channel === NEW);
    expect(inNew.map((p) => p.text.includes("Fixture first message") || p.text.includes("Which describes you better?"))).toEqual([true, true]);
    expect(posts(deps).filter((p) => p.channel === DM)).toHaveLength(2); // a link DM for the new channel
    expect(member(deps)).toMatchObject({ channel_id: NEW, channel_state: "active" });

    // The member chooses a role again, in the new channel.
    await handleRole(deps, { memberId: MEMBER, role: "technical", channel: NEW, messageTs: "100.099" });
    expect(member(deps).role).toBe("technical");
    expect(deps.store.all("SELECT * FROM checklist_item WHERE member_id = ?", MEMBER)).toHaveLength(7);
  });
});
