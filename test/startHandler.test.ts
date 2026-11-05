import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { handleOnboard, handleRole, handleTeamJoin, OPERATOR_ONLY, startOnboarding } from "../src/start.js";
import { FIXTURE_LIBRARY, makeDeps } from "./helpers.js";

const REAL_LIBRARY = fileURLToPath(new URL("../library", import.meta.url));

type Deps = ReturnType<typeof makeDeps>;
type Post = { channel: string; text: string; blocks?: { type: string }[] };

const row = (deps: Deps, id: string) =>
  deps.store.get<{ started_by: string; role: string | null; first_message_ts: string | null; channel_id: string | null; channel_state: string | null; dm_channel_id: string | null }>(
    "SELECT started_by, role, first_message_ts, channel_id, channel_state, dm_channel_id FROM member WHERE member_id = ?",
    id,
  );

const allPosts = (deps: Deps) => deps.fake.of("chat.postMessage").map((c) => c.args as unknown as Post);
/** Posts in a member channel (the fake numbers channels `C-<n>` and DMs `D-<user>`). */
const posts = (deps: Deps) => allPosts(deps).filter((p) => p.channel.startsWith("C-"));
/** Posts in a DM: the link message only (FR-CH-005, FR-CH-026). */
const dmPosts = (deps: Deps) => allPosts(deps).filter((p) => p.channel.startsWith("D-"));

describe("/onboard-ch (Scenarios 3 to 6)", () => {
  it("a member starts themselves: a welcome post, then a role post with two buttons and the two role definitions, both in the channel", async () => {
    const deps = makeDeps();
    const reply = await handleOnboard(deps, { callerId: "U1", text: "" });
    expect(reply).toBe("I have created your onboarding channel: <#C-1>. Open it to start.");
    expect(deps.fake.of("conversations.create")).toHaveLength(1);
    expect(posts(deps)).toHaveLength(2);
    const role = posts(deps)[1] as Post;
    const blocks = JSON.stringify(role.blocks);
    expect(blocks).toContain("technical: You work in repositories");
    expect(blocks).toMatch(/non-technical: [^"]*any (other )?role/i);
    expect(blocks).toMatch(/non-technical: [^"]*repositor/i);
    expect(blocks).toContain('"value":"technical"');
    expect(blocks).toContain('"value":"non-technical"');
    expect(row(deps, "U1")).toMatchObject({ started_by: "command", channel_id: "C-1", channel_state: "active", first_message_ts: null });
  });

  it("the welcome and the role question are the first two channel posts, and the DM holds exactly one message with the channel mention (Scenarios 3 and 6)", async () => {
    const deps = makeDeps();
    deps.fake.teamId = "T1";
    await startOnboarding(deps, { memberId: "U1", startedBy: "command" });

    const methods = deps.fake.calls.map((c) => c.method);
    expect(methods).toEqual([
      "conversations.create",
      "conversations.invite",
      "chat.postMessage",
      "chat.postMessage",
      "conversations.open",
      "chat.postMessage",
    ]);
    const [welcome, question, link] = allPosts(deps) as [Post, Post, Post];
    expect([welcome.channel, question.channel]).toEqual(["C-1", "C-1"]);
    expect(JSON.stringify(question.blocks)).toContain("role_technical");
    expect(JSON.stringify(welcome.blocks)).not.toContain("role_technical");
    expect(dmPosts(deps)).toHaveLength(1);
    expect(link.channel).toBe("D-U1");
    expect(link.text).toContain("<#C-1>");
    expect(link.text).toContain("slack://channel?team=T1&id=C-1");
    expect(row(deps, "U1")?.dm_channel_id).toBe("D-U1");
  });

  it("an operator starts a named member", async () => {
    const deps = makeDeps();
    const reply = await handleOnboard(deps, { callerId: "UOP1", text: "<@U2|sam>" });
    expect(reply).toBe("I have created <@U2>'s onboarding channel.");
    expect(deps.fake.last("conversations.invite")).toEqual({ channel: "C-1", users: "U2" });
    expect(deps.fake.last("conversations.open")).toEqual({ users: "U2" });
    expect(row(deps, "U2")?.started_by).toBe("command");
    expect(row(deps, "UOP1")).toBeUndefined();
  });

  it("a non-operator naming another member creates no channel, sends no DM and writes no row (Scenario 5)", async () => {
    const deps = makeDeps();
    const reply = await handleOnboard(deps, { callerId: "U1", text: "<@U2|sam>" });
    expect(reply).toBe(OPERATOR_ONLY);
    expect(reply).toContain("/onboard-ch");
    expect(deps.fake.calls).toHaveLength(0);
    expect(row(deps, "U2")).toBeUndefined();
  });

  it("text that is not a mention gets the usage line", async () => {
    const deps = makeDeps();
    expect(await handleOnboard(deps, { callerId: "U1", text: "hello" })).toBe("Usage: `/onboard-ch` or `/onboard-ch @member` (operators only).");
    expect(deps.fake.calls).toHaveLength(0);
  });

  it("naming yourself is the self form, open to everyone", async () => {
    const deps = makeDeps();
    await handleOnboard(deps, { callerId: "U1", text: "<@U1|me>" });
    expect(row(deps, "U1")).toBeTruthy();
  });

  it("a repeat command for a member with a role says the channel exists and posts nothing", async () => {
    const deps = makeDeps();
    await handleOnboard(deps, { callerId: "U1", text: "" });
    deps.store.run("UPDATE member SET role = 'technical' WHERE member_id = 'U1'");
    const calls = deps.fake.calls.length;
    expect(await handleOnboard(deps, { callerId: "U1", text: "" })).toBe("You already have an onboarding channel: <#C-1>.");
    expect(deps.fake.calls).toHaveLength(calls);
  });

  it("a failed create is told as such, and a failed invite as such", async () => {
    const failedCreate = makeDeps();
    failedCreate.fake.failCreate = true;
    expect(await handleOnboard(failedCreate, { callerId: "U1", text: "" })).toBe("I could not create the onboarding channel. An operator can check the app log.");
    const failedInvite = makeDeps();
    failedInvite.fake.failInvite = true;
    expect(await handleOnboard(failedInvite, { callerId: "U1", text: "" })).toBe("I created the channel but could not invite the member.");
  });
});

describe("start guards", () => {
  it("a bot user gets no channel and no DM", async () => {
    const deps = makeDeps();
    expect(await startOnboarding(deps, { memberId: "B1", startedBy: "event", isBot: true })).toBe("bot");
    expect(deps.fake.calls).toHaveLength(0);
  });

  it("a repeated event_id gives one channel, two channel posts and one DM", async () => {
    const deps = makeDeps();
    expect(await startOnboarding(deps, { memberId: "U1", startedBy: "event", eventId: "Ev1" })).toBe("sent");
    expect(await startOnboarding(deps, { memberId: "U1", startedBy: "event", eventId: "Ev1" })).toBe("duplicate");
    expect(deps.fake.of("conversations.create")).toHaveLength(1);
    expect(posts(deps)).toHaveLength(2);
    expect(dmPosts(deps)).toHaveLength(1);
  });

  it("a conversations.create error leaves no row, no post and no DM, with one log line (Scenario 4)", async () => {
    const deps = makeDeps();
    deps.fake.failCreate = true;
    expect(await startOnboarding(deps, { memberId: "U1", startedBy: "command" })).toBe("channel_failed");
    expect(deps.fake.of("conversations.create")).toHaveLength(1);
    expect(deps.fake.of("conversations.open")).toHaveLength(0);
    expect(deps.fake.of("chat.postMessage")).toHaveLength(0);
    expect(deps.logs.filter((l) => l.includes("start_failed"))).toHaveLength(1);
    expect(deps.logs.some((l) => l.includes("channel_create_failed") && l.includes("restricted_action"))).toBe(true);
    expect(row(deps, "U1")).toBeUndefined();
  });

  it("an invite failure returns invite_failed and sends no DM (Scenario 4)", async () => {
    const deps = makeDeps();
    deps.fake.failInvite = true;
    expect(await startOnboarding(deps, { memberId: "U1", startedBy: "command" })).toBe("invite_failed");
    expect(deps.fake.of("conversations.open")).toHaveLength(0);
    expect(deps.fake.of("chat.postMessage")).toHaveLength(0);
    expect(row(deps, "U1")).toMatchObject({ channel_id: "C-1", channel_state: "invite_failed" });
  });

  it("a link DM failure is logged once, changes nothing else and the start is still sent (Scenario 3)", async () => {
    const deps = makeDeps();
    deps.fake.failOpen = true;
    expect(await startOnboarding(deps, { memberId: "U1", startedBy: "command" })).toBe("sent");
    expect(deps.fake.of("conversations.open")).toHaveLength(1);
    expect(posts(deps)).toHaveLength(2);
    expect(dmPosts(deps)).toHaveLength(0);
    expect(deps.logs.filter((l) => l.includes("link_dm_failed"))).toHaveLength(1);
    expect(row(deps, "U1")).toMatchObject({ channel_id: "C-1", channel_state: "active", dm_channel_id: null });
  });

  it("a second start leaves the stored role unchanged, returns existing and posts nothing (Scenario 5)", async () => {
    const deps = makeDeps();
    await startOnboarding(deps, { memberId: "U1", startedBy: "command" });
    deps.store.run("UPDATE member SET role = 'technical' WHERE member_id = 'U1'");
    const calls = deps.fake.calls.length;
    expect(await startOnboarding(deps, { memberId: "U1", startedBy: "command" })).toBe("existing");
    expect(row(deps, "U1")?.role).toBe("technical");
    expect(deps.fake.calls).toHaveLength(calls);
    expect(deps.fake.of("conversations.create")).toHaveLength(1);
  });

  it("a start after a reset (no role) posts the welcome and the role question again, with no second create and no second DM (FR-CH-004)", async () => {
    const deps = makeDeps();
    await startOnboarding(deps, { memberId: "U1", startedBy: "command" });
    expect(await startOnboarding(deps, { memberId: "U1", startedBy: "command" })).toBe("sent");
    expect(deps.fake.of("conversations.create")).toHaveLength(1);
    expect(posts(deps)).toHaveLength(4);
    expect(dmPosts(deps)).toHaveLength(1);
  });
});

describe("handleRole guard (FR-CH-012)", () => {
  it("a click on a message in a channel other than the member's is ignored and logged", async () => {
    const deps = makeDeps();
    await startOnboarding(deps, { memberId: "U1", startedBy: "command" });
    await handleRole(deps, { memberId: "U1", role: "technical", channel: "D-U1", messageTs: "100.002" });
    expect(row(deps, "U1")?.role).toBeNull();
    expect(deps.fake.of("chat.update")).toHaveLength(0);
    expect(deps.logs.filter((l) => l.includes("role_ignored"))).toHaveLength(1);
  });
});

describe("team_join (Scenario 2)", () => {
  it("a human starts onboarding with started_by event", async () => {
    const deps = makeDeps();
    await handleTeamJoin(deps, { memberId: "U9", eventId: "Ev9" });
    expect(row(deps, "U9")?.started_by).toBe("event");
    expect(posts(deps)).toHaveLength(2);
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
    expect(JSON.stringify(posts(withLink)[0]?.blocks)).toContain("https://example.slack.com/canvas/F1");
    const without = makeDeps();
    await startOnboarding(without, { memberId: "U1", startedBy: "command" });
    expect(JSON.stringify(posts(without)[0]?.blocks)).not.toContain("canvas");
  });
});

describe("first message (FR-ST-008, Scenarios 2, 3, 4 and 6)", () => {
  const URL = "https://example.slack.com/canvas/F1";
  const BODY = "Fixture first message";
  const welcomeBlocks = (deps: Deps) => posts(deps)[0]?.blocks ?? [];
  const roleBlocks = (deps: Deps) => posts(deps)[1]?.blocks ?? [];

  it("posts the welcome first (body, then the glossary link button), then the role question with the two definitions and one actions block", async () => {
    const deps = makeDeps({ glossaryUrl: URL });
    await startOnboarding(deps, { memberId: "U1", startedBy: "command" });
    expect(posts(deps)).toHaveLength(2);
    const welcome = welcomeBlocks(deps);
    const welcomeJson = JSON.stringify(welcome);
    expect(welcomeJson.indexOf(BODY)).toBeGreaterThan(-1);
    expect((welcome.at(-1) as { accessory?: unknown } | undefined)?.accessory).toMatchObject({ type: "button", url: URL, action_id: "open_glossary" });
    expect(welcome.some((b) => b.type === "actions")).toBe(false);
    expect(welcomeJson).not.toContain("Which describes you better?");
    expect(posts(deps)[0]?.text).toContain(URL);

    const blocks = roleBlocks(deps);
    const json = JSON.stringify(blocks);
    const at = (needle: string) => json.indexOf(needle);
    expect(json).not.toContain(BODY);
    expect(json).not.toContain(URL);
    expect(at("Which describes you better?")).toBeLessThan(at("technical: You work in repositories"));
    expect(at("technical: You work in repositories")).toBeLessThan(at('"type":"actions"'));
    expect(blocks.filter((b) => b.type === "actions")).toHaveLength(1);
    expect(blocks.at(-1)?.type).toBe("actions");
    expect(json.match(/"value":"(non-)?technical"/g)).toHaveLength(2);
  });

  it("omits the link line when glossaryUrl is unset", async () => {
    const deps = makeDeps();
    await startOnboarding(deps, { memberId: "U1", startedBy: "command" });
    const json = JSON.stringify(welcomeBlocks(deps));
    expect(json).toContain(BODY);
    expect(json).not.toContain("glossary");
  });

  it("with no first-message file the welcome holds only the link line, and with no link either it is skipped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "no-first-message-"));
    cpSync(FIXTURE_LIBRARY, dir, { recursive: true });
    rmSync(join(dir, "first-message.md"));
    const linked = makeDeps({ libraryDir: dir, glossaryUrl: URL });
    expect(await startOnboarding(linked, { memberId: "U1", startedBy: "command" })).toBe("sent");
    expect(posts(linked)).toHaveLength(2);
    expect(JSON.stringify(welcomeBlocks(linked))).toContain(URL);
    expect(JSON.stringify(welcomeBlocks(linked))).not.toContain(BODY);

    const bare = makeDeps({ libraryDir: dir });
    expect(await startOnboarding(bare, { memberId: "U1", startedBy: "command" })).toBe("sent");
    expect(posts(bare)).toHaveLength(1);
    expect(JSON.stringify(posts(bare)[0]?.blocks)).toContain('"type":"actions"');
    expect(row(bare, "U1")?.first_message_ts).toBeNull();
  });

  it("/onboard-ch, /onboard-ch @member and team_join post identical blocks for the same member", async () => {
    const options = { glossaryUrl: URL };
    const self = makeDeps(options);
    await handleOnboard(self, { callerId: "U2", text: "" });
    const named = makeDeps(options);
    await handleOnboard(named, { callerId: "UOP1", text: "<@U2|sam>" });
    const joined = makeDeps(options);
    await handleTeamJoin(joined, { memberId: "U2", eventId: "Ev2" });
    expect(posts(named)).toEqual(posts(self));
    expect(posts(joined)).toEqual(posts(self));
    expect([self, named, joined].map((d) => row(d, "U2")?.started_by)).toEqual(["command", "command", "event"]);
  });

  it("reads the body at each start, so an edit shows in the next channel", async () => {
    const dir = mkdtempSync(join(tmpdir(), "first-message-"));
    cpSync(FIXTURE_LIBRARY, dir, { recursive: true });
    const deps = makeDeps({ libraryDir: dir });
    await startOnboarding(deps, { memberId: "U1", startedBy: "command" });
    expect(JSON.stringify(welcomeBlocks(deps))).toContain(BODY);
    writeFileSync(join(dir, "first-message.md"), ["---", "title: first-message", "roles: all", "---", "Edited between starts.", ""].join("\n"));
    await startOnboarding(deps, { memberId: "U2", startedBy: "command" });
    const second = JSON.stringify(posts(deps).slice(2));
    expect(second).toContain("Edited between starts.");
    expect(second).not.toContain(BODY);
  });
});

describe.each([
  ["fixture library", FIXTURE_LIBRARY],
  ["real library", REAL_LIBRARY],
])("role question, %s (FR-ST-009, Scenario 7)", (_name, libraryDir) => {
  it("names no consulting, shows one definition per button, and the non-technical line covers any other role", async () => {
    const deps = makeDeps({ libraryDir });
    await startOnboarding(deps, { memberId: "U1", startedBy: "command" });
    const question = posts(deps).at(-1) as Post;
    expect(`${question.text} ${JSON.stringify(question.blocks)}`).not.toMatch(/consult(ing|ancy)/i);
    const lines = (question.blocks ?? []).flatMap((b) => (b.type === "section" ? String((b as unknown as { text: { text: string } }).text.text).split("\n") : []));
    expect(lines.filter((l) => l.startsWith("• technical:"))).toHaveLength(1);
    const nonTechnical = lines.filter((l) => l.startsWith("• non-technical:"));
    expect(nonTechnical).toHaveLength(1);
    expect(nonTechnical[0]).toMatch(/any (other )?role/i);
    expect(nonTechnical[0]).toMatch(/repositor/i);
  });
});
