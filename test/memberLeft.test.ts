import { describe, expect, it } from "vitest";
import type { ClaudeClient } from "../src/claudeClient.js";
import { handleMemberJoined, handleMemberLeft } from "../src/channel.js";
import { routeChannelMessage } from "../src/channelMessage.js";
import { handleOnboard } from "../src/start.js";
import { getMemberChannel, setMemberChannel } from "../src/store.js";
import { makeDeps, onboard } from "./helpers.js";

type D = ReturnType<typeof makeDeps>;

const state = (deps: D, id = "U1") => getMemberChannel(deps.store, id)?.state;
const setState = (deps: D, value: "active" | "member_left" | "invite_failed" | "lost", id = "U1") =>
  setMemberChannel(deps.store, id, { id: "C-1", name: "onboarding-copilot-u1", state: value });

/** A started member (U1) with a role and the channel the real start flow creates (C-1). */
async function ready(): Promise<D> {
  const deps = makeDeps();
  await onboard(deps, "U1", "technical");
  return deps;
}

describe("member_left_channel and member_joined_channel (FR-CH-023, Scenario 23)", () => {
  it("the owner leaving sets member_left and logs one line", async () => {
    const deps = await ready();
    deps.logs.length = 0;
    await handleMemberLeft(deps, { channel: "C-1", user: "U1" });
    expect(state(deps)).toBe("member_left");
    expect(deps.logs).toHaveLength(1);
    expect(deps.logs[0]).toContain("member_left_channel");
  });

  it("the owner rejoining sets active, from member_left and from invite_failed, and logs one line", async () => {
    for (const from of ["member_left", "invite_failed"] as const) {
      const deps = await ready();
      setState(deps, from);
      deps.logs.length = 0;
      await handleMemberJoined(deps, { channel: "C-1", user: "U1" });
      expect(state(deps)).toBe("active");
      expect(deps.logs).toHaveLength(1);
      expect(deps.logs[0]).toContain("member_joined_channel");
    }
  });

  it("another user leaving or joining changes nothing", async () => {
    const deps = await ready();
    await handleMemberLeft(deps, { channel: "C-1", user: "U2" });
    expect(state(deps)).toBe("active");
    setState(deps, "member_left");
    await handleMemberJoined(deps, { channel: "C-1", user: "U2" });
    expect(state(deps)).toBe("member_left");
  });

  it("the bot's own join and leave are ignored", async () => {
    const deps = await ready();
    await handleMemberLeft(deps, { channel: "C-1", user: "UBOT" });
    expect(state(deps)).toBe("active");
    setState(deps, "member_left");
    await handleMemberJoined(deps, { channel: "C-1", user: "UBOT" });
    expect(state(deps)).toBe("member_left");
  });

  it("a lost channel stays lost when the owner joins", async () => {
    const deps = await ready();
    setState(deps, "lost");
    await handleMemberJoined(deps, { channel: "C-1", user: "U1" });
    expect(state(deps)).toBe("lost");
  });

  it("an active channel stays active on a join, and a join does not touch the checklist or role", async () => {
    const deps = await ready();
    const before = JSON.stringify(deps.store.all("SELECT * FROM member"));
    await handleMemberJoined(deps, { channel: "C-1", user: "U1" });
    expect(JSON.stringify(deps.store.all("SELECT * FROM member"))).toBe(before);
  });

  it("an event for a channel that is not any member's changes nothing and does not throw", async () => {
    const deps = await ready();
    const before = JSON.stringify(deps.store.all("SELECT * FROM member"));
    await expect(handleMemberLeft(deps, { channel: "C-OTHER", user: "U1" })).resolves.toBeUndefined();
    await expect(handleMemberJoined(deps, { channel: "C-OTHER", user: "U1" })).resolves.toBeUndefined();
    expect(JSON.stringify(deps.store.all("SELECT * FROM member"))).toBe(before);
  });

  it("the owner's own id in a different channel does not count: only the channel the member owns", async () => {
    const deps = await ready();
    await onboard(deps, "U2", "technical");
    await handleMemberLeft(deps, { channel: "C-2", user: "U1" });
    expect(state(deps, "U1")).toBe("active");
    expect(state(deps, "U2")).toBe("active");
    await handleMemberLeft(deps, { channel: "C-2", user: "U2" });
    expect(state(deps, "U1")).toBe("active");
    expect(state(deps, "U2")).toBe("member_left");
  });

  it("an event with no user is ignored", async () => {
    const deps = await ready();
    await handleMemberLeft(deps, { channel: "C-1" });
    expect(state(deps)).toBe("active");
  });

  it("two simultaneous member_left events leave one consistent state", async () => {
    const deps = await ready();
    await Promise.all([handleMemberLeft(deps, { channel: "C-1", user: "U1" }), handleMemberLeft(deps, { channel: "C-1", user: "U1" })]);
    expect(state(deps)).toBe("member_left");
    expect(getMemberChannel(deps.store, "U1")).toEqual({ id: "C-1", name: "onboarding-copilot-u1", state: "member_left" });
  });

  it("a left then joined pair ends active, and a store failure is logged and never thrown", async () => {
    const deps = await ready();
    await handleMemberLeft(deps, { channel: "C-1", user: "U1" });
    await handleMemberJoined(deps, { channel: "C-1", user: "U1" });
    expect(state(deps)).toBe("active");

    const run = deps.store.run;
    deps.store.run = () => {
      throw new Error("database is locked");
    };
    await expect(handleMemberLeft(deps, { channel: "C-1", user: "U1" })).resolves.toBeUndefined();
    await expect(handleMemberJoined(deps, { channel: "C-1", user: "U1" })).resolves.toBeUndefined();
    deps.store.run = run;
    expect(deps.logs.some((l) => l.includes("member_left_failed") && l.includes("database is locked"))).toBe(true);
    expect(deps.logs.some((l) => l.includes("member_joined_failed"))).toBe(true);
  });
});

describe("what member_left changes downstream", () => {
  const model = () => {
    const calls = { n: 0 };
    const client: ClaudeClient = {
      complete: async () => {
        calls.n++;
        return "Open Settings. [Connect Claude to Slack]";
      },
    };
    return { client, calls };
  };
  const ask = (deps: D, client: ClaudeClient, ts: string) =>
    routeChannelMessage(deps, client, { channel: "C-1", channel_type: "group", user: "U1", text: "how do I connect Slack?", ts });

  it("Q&A in the channel is silent while the state is member_left and answers again after the rejoin", async () => {
    const deps = await ready();
    const { client, calls } = model();
    await handleMemberLeft(deps, { channel: "C-1", user: "U1" });
    const posts = deps.fake.of("chat.postMessage").length;
    await ask(deps, client, "300.1");
    expect(calls.n).toBe(0);
    expect(deps.fake.of("chat.postMessage")).toHaveLength(posts);

    await handleMemberJoined(deps, { channel: "C-1", user: "U1" });
    await ask(deps, client, "300.2");
    expect(calls.n).toBe(1);
    expect(deps.fake.of("chat.postMessage")).toHaveLength(posts + 1);
  });

  it("`/onboard-ch` for a member_left member re-invites once, sets active and creates no channel", async () => {
    const deps = await ready();
    await handleMemberLeft(deps, { channel: "C-1", user: "U1" });
    const invites = deps.fake.of("conversations.invite").length;
    const creates = deps.fake.of("conversations.create").length;

    await handleOnboard(deps, { callerId: "U1", text: "" });

    expect(deps.fake.of("conversations.invite")).toHaveLength(invites + 1);
    expect(deps.fake.last("conversations.invite")).toEqual({ channel: "C-1", users: "U1" });
    expect(deps.fake.of("conversations.create")).toHaveLength(creates);
    expect(state(deps)).toBe("active");
  });
});
