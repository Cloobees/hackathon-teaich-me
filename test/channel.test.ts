import { describe, expect, it } from "vitest";
import { channelLink, channelNameFor, channelPost, ensureMemberChannel, memberChannel } from "../src/channel.js";
import { getMemberChannel, setMemberChannel } from "../src/store.js";
import { makeDeps } from "./helpers.js";

const start = (deps: ReturnType<typeof makeDeps>, memberId = "U1") => ensureMemberChannel(deps, { memberId, startedBy: "command" });
const rowCount = (deps: ReturnType<typeof makeDeps>) => deps.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM member")?.n;

describe("channelNameFor", () => {
  it("builds the name from the profile name, or from the user id when there is none", () => {
    expect(channelNameFor("Ada Lovelace", "U1")).toBe("onboarding-copilot-ada-lovelace");
    expect(channelNameFor(undefined, "U1")).toBe("onboarding-copilot-u1");
    expect(channelNameFor("Zoë Müller", "U1")).toBe("onboarding-copilot-zoe-muller");
  });

  it("adds -2 to -4 for attempts 1 to 3 and uses the user id on attempt 4", () => {
    expect(channelNameFor("Ada Lovelace", "U1", 1)).toBe("onboarding-copilot-ada-lovelace-2");
    expect(channelNameFor("Ada Lovelace", "U1", 3)).toBe("onboarding-copilot-ada-lovelace-4");
    expect(channelNameFor("Ada Lovelace", "UABC9", 4)).toBe("onboarding-copilot-uabc9");
  });

  it("stays within 80 characters including the suffix", () => {
    const long = "a".repeat(200);
    for (let attempt = 0; attempt <= 4; attempt++) expect(channelNameFor(long, "U1", attempt).length).toBeLessThanOrEqual(80);
    expect(channelNameFor(long, "U1", 2).endsWith("-3")).toBe(true);
  });
});

describe("ensureMemberChannel", () => {
  it("Scenario 1: creates a private channel, then invites the member, and stores id, name and state", async () => {
    const deps = makeDeps();
    deps.fake.profiles.U1 = { real_name: "Ada Lovelace" };
    const result = await start(deps);
    expect(result).toEqual({ outcome: "created", channelId: "C-1", channelName: "onboarding-copilot-ada-lovelace", teamId: undefined });
    expect(deps.fake.of("conversations.create")).toHaveLength(1);
    expect(deps.fake.of("conversations.create")[0].args).toEqual({ name: "onboarding-copilot-ada-lovelace", is_private: true });
    expect(deps.fake.of("conversations.invite")[0].args).toEqual({ channel: "C-1", users: "U1" });
    const order = deps.fake.calls.map((c) => c.method).filter((m) => m.startsWith("conversations."));
    expect(order).toEqual(["conversations.create", "conversations.invite"]);
    expect(getMemberChannel(deps.store, "U1")).toEqual({ id: "C-1", name: "onboarding-copilot-ada-lovelace", state: "active" });
    expect(deps.store.get<{ started_by: string }>("SELECT started_by FROM member WHERE member_id = 'U1'")?.started_by).toBe("command");
  });

  it("falls back to the user id name when users.info fails", async () => {
    const deps = makeDeps();
    deps.slack.users.info = async () => {
      throw new Error("ratelimited");
    };
    expect((await start(deps)).channelName).toBe("onboarding-copilot-u1");
  });

  it("returns teamId from context_team_id when the create response has it", async () => {
    const deps = makeDeps();
    const create = deps.slack.conversations.create;
    deps.slack.conversations.create = async (args) => {
      const response = await create(args);
      return { channel: { ...response.channel, context_team_id: "T9" } };
    };
    expect((await start(deps)).teamId).toBe("T9");
  });

  it("keeps the started_by of a row that already exists", async () => {
    const deps = makeDeps();
    deps.store.run("INSERT INTO member (member_id, started_by) VALUES ('U1', 'event')");
    await start(deps);
    expect(deps.store.get<{ started_by: string }>("SELECT started_by FROM member WHERE member_id = 'U1'")?.started_by).toBe("event");
    expect(getMemberChannel(deps.store, "U1")?.state).toBe("active");
  });

  it("Scenario 2: retries name_taken with -2, -3, -4 and stores the name that succeeded", async () => {
    const deps = makeDeps();
    deps.fake.profiles.U1 = { real_name: "Ada Lovelace" };
    deps.fake.nameTaken = ["onboarding-copilot-ada-lovelace", "onboarding-copilot-ada-lovelace-2"];
    const result = await start(deps);
    expect(deps.fake.of("conversations.create").map((c) => (c.args as { name: string }).name)).toEqual([
      "onboarding-copilot-ada-lovelace",
      "onboarding-copilot-ada-lovelace-2",
      "onboarding-copilot-ada-lovelace-3",
    ]);
    expect(result.channelName).toBe("onboarding-copilot-ada-lovelace-3");
    expect(getMemberChannel(deps.store, "U1")?.name).toBe("onboarding-copilot-ada-lovelace-3");
  });

  it("Scenario 2: after 3 retries the lowercase user id name is used", async () => {
    const deps = makeDeps();
    deps.fake.profiles.UABC9 = { real_name: "Ada Lovelace" };
    deps.fake.nameTaken = ["-", "-2", "-3", "-4"].map((s) => `onboarding-copilot-ada-lovelace${s === "-" ? "" : s}`);
    const result = await start(deps, "UABC9");
    expect(deps.fake.of("conversations.create")).toHaveLength(5);
    expect(result).toMatchObject({ outcome: "created", channelName: "onboarding-copilot-uabc9" });
  });

  it("returns create_failed when the user id name is taken too", async () => {
    const deps = makeDeps();
    deps.fake.nameTaken = ["onboarding-copilot-u1", "onboarding-copilot-u1-2", "onboarding-copilot-u1-3", "onboarding-copilot-u1-4", "onboarding-copilot-u1"];
    const result = await start(deps);
    expect(deps.fake.of("conversations.create")).toHaveLength(5);
    expect(result.outcome).toBe("create_failed");
    expect(rowCount(deps)).toBe(0);
  });

  it("accepts name_taken reported in data.error", async () => {
    const deps = makeDeps();
    let calls = 0;
    deps.slack.conversations.create = async (args) => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("An API error occurred: name_taken"), { data: { ok: false, error: "name_taken" } });
      return { channel: { id: "C-9", name: args.name } };
    };
    expect(await start(deps)).toMatchObject({ outcome: "created", channelId: "C-9" });
    expect(calls).toBe(2);
  });

  it("Scenario 4: a create error returns create_failed, writes no row and logs the code once", async () => {
    const deps = makeDeps();
    deps.fake.failCreate = true;
    const result = await start(deps);
    expect(result).toEqual({ outcome: "create_failed" });
    expect(rowCount(deps)).toBe(0);
    expect(deps.fake.of("conversations.invite")).toHaveLength(0);
    expect(deps.logs).toHaveLength(1);
    expect(deps.logs[0]).toContain("restricted_action");
  });

  it("Scenario 4: an enterprise_is_restricted error from data.error is logged and not retried", async () => {
    const deps = makeDeps();
    deps.slack.conversations.create = async () => {
      throw Object.assign(new Error("An API error occurred: enterprise_is_restricted"), { data: { ok: false, error: "enterprise_is_restricted" } });
    };
    expect((await start(deps)).outcome).toBe("create_failed");
    expect(rowCount(deps)).toBe(0);
    expect(deps.logs).toHaveLength(1);
    expect(deps.logs[0]).toContain("enterprise_is_restricted");
  });

  it("Scenario 4: an invite error sets invite_failed, keeps the channel and logs once", async () => {
    const deps = makeDeps();
    deps.fake.failInvite = true;
    const result = await start(deps);
    expect(result).toMatchObject({ outcome: "invite_failed", channelId: "C-1" });
    expect(getMemberChannel(deps.store, "U1")).toEqual({ id: "C-1", name: "onboarding-copilot-u1", state: "invite_failed" });
    expect(deps.logs).toHaveLength(1);
    expect(deps.logs[0]).toContain("user_is_restricted");
  });

  it("treats already_in_channel on the invite as success", async () => {
    const deps = makeDeps();
    deps.slack.conversations.invite = async () => {
      throw Object.assign(new Error("An API error occurred: already_in_channel"), { data: { ok: false, error: "already_in_channel" } });
    };
    expect((await start(deps)).outcome).toBe("created");
    expect(getMemberChannel(deps.store, "U1")?.state).toBe("active");
    expect(deps.logs).toHaveLength(0);
  });

  it("Scenario 5: a second start reuses the active channel without a create or an invite", async () => {
    const deps = makeDeps();
    await start(deps);
    const second = await start(deps);
    expect(second).toEqual({ outcome: "existing", channelId: "C-1", channelName: "onboarding-copilot-u1" });
    expect(deps.fake.of("conversations.create")).toHaveLength(1);
    expect(deps.fake.of("conversations.invite")).toHaveLength(1);
  });

  it("re-invites once after member_left and sets active", async () => {
    const deps = makeDeps();
    await start(deps);
    setMemberChannel(deps.store, "U1", { id: "C-1", name: "onboarding-copilot-u1", state: "member_left" });
    const result = await start(deps);
    expect(result).toMatchObject({ outcome: "reinvited", channelId: "C-1" });
    expect(deps.fake.of("conversations.create")).toHaveLength(1);
    expect(deps.fake.of("conversations.invite")).toHaveLength(2);
    expect(getMemberChannel(deps.store, "U1")?.state).toBe("active");
  });

  it("retries the invite for invite_failed: success sets active, failure stays invite_failed", async () => {
    const deps = makeDeps();
    deps.fake.failInvite = true;
    await start(deps);
    const failed = await start(deps);
    expect(failed).toMatchObject({ outcome: "invite_failed", channelId: "C-1" });
    expect(getMemberChannel(deps.store, "U1")?.state).toBe("invite_failed");
    expect(deps.fake.of("conversations.create")).toHaveLength(1);
    deps.fake.failInvite = false;
    expect((await start(deps)).outcome).toBe("reinvited");
    expect(getMemberChannel(deps.store, "U1")?.state).toBe("active");
  });

  it("a failed re-invite after member_left returns invite_failed", async () => {
    const deps = makeDeps();
    await start(deps);
    setMemberChannel(deps.store, "U1", { id: "C-1", name: "onboarding-copilot-u1", state: "member_left" });
    deps.fake.failInvite = true;
    expect((await start(deps)).outcome).toBe("invite_failed");
    expect(getMemberChannel(deps.store, "U1")?.state).toBe("invite_failed");
  });

  it("Scenario 24: a lost channel is replaced with a suffixed name when the old name is taken", async () => {
    const deps = makeDeps();
    await start(deps);
    setMemberChannel(deps.store, "U1", { id: "C-1", name: "onboarding-copilot-u1", state: "lost" });
    deps.fake.nameTaken = ["onboarding-copilot-u1"];
    const result = await start(deps);
    expect(result).toMatchObject({ outcome: "created", channelId: "C-2", channelName: "onboarding-copilot-u1-2" });
    expect(getMemberChannel(deps.store, "U1")).toEqual({ id: "C-2", name: "onboarding-copilot-u1-2", state: "active" });
    expect(rowCount(deps)).toBe(1);
  });
});

describe("memberChannel", () => {
  it("returns the stored id, name and state, or undefined", async () => {
    const deps = makeDeps();
    expect(memberChannel(deps.store, "U1")).toBeUndefined();
    deps.store.run("INSERT INTO member (member_id) VALUES ('U1')");
    expect(memberChannel(deps.store, "U1")).toBeUndefined();
    await start(deps);
    expect(memberChannel(deps.store, "U1")).toEqual({ id: "C-1", name: "onboarding-copilot-u1", state: "active" });
  });
});

describe("channelLink", () => {
  it("Scenario 3: holds the channel mention, and the deep link when the team id is known", () => {
    expect(channelLink("C1")).toBe("<#C1>");
    const text = channelLink("C1", "T9");
    expect(text).toContain("<#C1>");
    expect(text).toContain("slack://channel?team=T9&id=C1");
  });
});

describe("channelPost", () => {
  const fail = (code: string, viaData = false) => async () => {
    throw viaData ? Object.assign(new Error(`An API error occurred: ${code}`), { data: { ok: false, error: code } }) : new Error(code);
  };

  it("posts and returns the response", async () => {
    const deps = makeDeps();
    await start(deps);
    const response = await channelPost(deps, "U1", { channel: "C-1", text: "hello" });
    expect(response?.ts).toBeDefined();
    expect(deps.fake.last("chat.postMessage").text).toBe("hello");
  });

  for (const code of ["is_archived", "channel_not_found", "not_in_channel"]) {
    it(`Scenario 24: ${code} sets lost, logs channel_lost once and does not throw`, async () => {
      const deps = makeDeps();
      await start(deps);
      deps.logs.length = 0;
      deps.slack.chat.postMessage = fail(code, code === "is_archived");
      await expect(channelPost(deps, "U1", { channel: "C-1", text: "hi" })).resolves.toBeUndefined();
      expect(getMemberChannel(deps.store, "U1")?.state).toBe("lost");
      expect(deps.logs).toHaveLength(1);
      expect(deps.logs[0]).toContain("channel_lost");
    });
  }

  it("rethrows any other error and leaves the state alone", async () => {
    const deps = makeDeps();
    await start(deps);
    deps.slack.chat.postMessage = fail("ratelimited");
    await expect(channelPost(deps, "U1", { channel: "C-1", text: "hi" })).rejects.toThrow("ratelimited");
    expect(getMemberChannel(deps.store, "U1")?.state).toBe("active");
  });
});
