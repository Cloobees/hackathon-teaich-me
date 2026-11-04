import { describe, expect, it } from "vitest";
import { BIND_CONFIRMATION, bindOnFirstMessage, handleMemberJoinedChannel } from "../src/bindChannel.js";
import { getReportChannel, setReportChannel } from "../src/store.js";
import { makeDeps } from "./helpers.js";

const BOT = "UBOT";
const NAME = "onboarding-copilot-sam";

function setup() {
  const deps = makeDeps();
  for (const [id, name] of [["U1", NAME], ["U2", "onboarding-copilot-alex"]]) {
    deps.store.run("INSERT INTO member (member_id) VALUES (?)", id);
    setReportChannel(deps.store, id, { name });
  }
  deps.fake.channels.C1 = { name: NAME, is_private: true };
  return deps;
}
const posts = (deps: ReturnType<typeof setup>) => deps.fake.of("chat.postMessage");
const join = (deps: ReturnType<typeof setup>, channel: string, user = BOT) =>
  handleMemberJoinedChannel(deps, { event: { user, channel }, botUserId: BOT });

describe("bind and confirm on join (BP-073)", () => {
  it("binds the channel when the app joins a private channel with the member's name, and posts one confirmation (Scenario 14)", async () => {
    const deps = setup();
    const result = await join(deps, "C1");
    expect(result).toMatchObject({ outcome: "bound", memberId: "U1", channelId: "C1", channelName: NAME });
    expect(getReportChannel(deps.store, "U1")).toEqual({ name: NAME, id: "C1" });
    expect(posts(deps)).toHaveLength(1);
    expect(posts(deps)[0].args).toMatchObject({ channel: "C1", text: BIND_CONFIRMATION });
    expect(BIND_CONFIRMATION).toContain("Onboarding Copilot");
  });

  it("a name with a -2 suffix binds and stores the actual name", async () => {
    const deps = setup();
    deps.fake.channels.C2 = { name: `${NAME}-2`, is_private: true };
    expect(await join(deps, "C2")).toMatchObject({ outcome: "bound", memberId: "U1" });
    expect(getReportChannel(deps.store, "U1")).toEqual({ name: `${NAME}-2`, id: "C2" });
    expect(posts(deps)).toHaveLength(1);
  });

  it("a join by another user is ignored", async () => {
    const deps = setup();
    expect(await join(deps, "C1", "U1")).toMatchObject({ outcome: "not_own_join" });
    expect(getReportChannel(deps.store, "U1")?.id).toBeNull();
    expect(posts(deps)).toHaveLength(0);
    expect(deps.fake.of("conversations.info")).toHaveLength(0);
  });

  it("a public channel with the member's name is ignored", async () => {
    const deps = setup();
    deps.fake.channels.C1.is_private = false;
    expect(await join(deps, "C1")).toMatchObject({ outcome: "not_private" });
    expect(getReportChannel(deps.store, "U1")?.id).toBeNull();
    expect(posts(deps)).toHaveLength(0);
  });

  it("a private channel whose name matches no member is ignored", async () => {
    const deps = setup();
    deps.fake.channels.C3 = { name: "onboarding-copilot-sam-smith", is_private: true };
    expect(await join(deps, "C3")).toMatchObject({ outcome: "no_match" });
    expect(posts(deps)).toHaveLength(0);
  });

  it("a second join posts nothing and changes nothing", async () => {
    const deps = setup();
    await join(deps, "C1");
    expect(await join(deps, "C1")).toMatchObject({ outcome: "already_bound", memberId: "U1" });
    expect(posts(deps)).toHaveLength(1);
    expect(getReportChannel(deps.store, "U1")).toEqual({ name: NAME, id: "C1" });
  });

  it("a failed channel lookup binds nothing and posts nothing", async () => {
    const deps = setup();
    expect(await join(deps, "C404")).toMatchObject({ outcome: "lookup_failed" });
    expect(posts(deps)).toHaveLength(0);
  });
});

describe("bind on first message, the fallback (BP-073)", () => {
  it("binds on the member's first message in the channel and posts no confirmation", async () => {
    const deps = setup();
    expect(await bindOnFirstMessage(deps, { memberId: "U1", channel: "C1" })).toMatchObject({ outcome: "bound", channelId: "C1", channelName: NAME });
    expect(getReportChannel(deps.store, "U1")).toEqual({ name: NAME, id: "C1" });
    expect(posts(deps)).toHaveLength(0);
  });

  it("ignores a message from another author", async () => {
    const deps = setup();
    expect(await bindOnFirstMessage(deps, { memberId: "U2", channel: "C1" })).toMatchObject({ outcome: "not_author" });
    expect(await bindOnFirstMessage(deps, { memberId: "UNKNOWN", channel: "C1" })).toMatchObject({ outcome: "not_author" });
    expect(getReportChannel(deps.store, "U1")?.id).toBeNull();
    expect(posts(deps)).toHaveLength(0);
  });

  it("posts nothing for a bound channel, a repeat message or a public channel", async () => {
    const deps = setup();
    await join(deps, "C1");
    expect(await bindOnFirstMessage(deps, { memberId: "U1", channel: "C1" })).toMatchObject({ outcome: "already_bound" });
    expect(await bindOnFirstMessage(deps, { memberId: "U2", channel: "C1" })).toMatchObject({ outcome: "already_bound" });
    deps.fake.channels.C5 = { name: "onboarding-copilot-alex", is_private: false };
    expect(await bindOnFirstMessage(deps, { memberId: "U2", channel: "C5" })).toMatchObject({ outcome: "not_private" });
    expect(posts(deps)).toHaveLength(1);
  });
});

describe("two members with the same stored channel name (Scenario 14)", () => {
  const SAME = "onboarding-copilot-sam-lee";
  function twins() {
    const deps = makeDeps();
    for (const id of ["UA", "UB"]) {
      deps.store.run("INSERT INTO member (member_id) VALUES (?)", id);
      setReportChannel(deps.store, id, { name: SAME });
    }
    deps.fake.channels.GB = { name: SAME, is_private: true };
    deps.fake.channels.GA = { name: `${SAME}-2`, is_private: true };
    return deps;
  }
  const joinBy = (deps: ReturnType<typeof twins>, channel: string, inviter?: string) =>
    handleMemberJoinedChannel(deps, { event: { user: BOT, channel, inviter }, botUserId: BOT });

  it("the inviter's channel binds to the inviter, not the first member with that name", async () => {
    const deps = twins();
    expect(await joinBy(deps, "GB", "UB")).toMatchObject({ outcome: "bound", memberId: "UB", channelId: "GB", channelName: SAME });
    expect(getReportChannel(deps.store, "UB")).toEqual({ name: SAME, id: "GB" });
    expect(getReportChannel(deps.store, "UA")?.id).toBeNull();

    expect(await joinBy(deps, "GA", "UA")).toMatchObject({ outcome: "bound", memberId: "UA", channelId: "GA", channelName: `${SAME}-2` });
    expect(getReportChannel(deps.store, "UA")).toEqual({ name: `${SAME}-2`, id: "GA" });
    expect(getReportChannel(deps.store, "UB")).toEqual({ name: SAME, id: "GB" });
  });

  it("with no inviter, or an inviter who is not a candidate, the first candidate binds", async () => {
    const deps = twins();
    expect(await joinBy(deps, "GB")).toMatchObject({ outcome: "bound", memberId: "UA" });
    const other = twins();
    expect(await joinBy(other, "GB", "USTRANGER")).toMatchObject({ outcome: "bound", memberId: "UA" });
  });

  it("an already-bound member is never rebound by another channel", async () => {
    const deps = twins();
    await joinBy(deps, "GB", "UB");
    deps.fake.channels.GC = { name: SAME, is_private: true };
    // UB is bound, so the only candidate left is UA, even though UB invited the app.
    expect(await joinBy(deps, "GC", "UB")).toMatchObject({ outcome: "bound", memberId: "UA", channelId: "GC" });
    expect(getReportChannel(deps.store, "UB")).toEqual({ name: SAME, id: "GB" });
    // Both bound: a further channel with that name matches nobody and changes nothing.
    deps.fake.channels.GD = { name: SAME, is_private: true };
    expect(await joinBy(deps, "GD", "UB")).toMatchObject({ outcome: "no_match" });
    expect(getReportChannel(deps.store, "UB")).toEqual({ name: SAME, id: "GB" });
    expect(getReportChannel(deps.store, "UA")).toEqual({ name: SAME, id: "GC" });
  });

  it("an exact name beats a suffixed one among unbound members, and the join in a bound channel stays already_bound", async () => {
    const deps = twins();
    setReportChannel(deps.store, "UB", { name: `${SAME}-2` });
    expect(await joinBy(deps, "GA", "UA")).toMatchObject({ outcome: "bound", memberId: "UB", channelName: `${SAME}-2` });
    expect(await joinBy(deps, "GA", "UA")).toMatchObject({ outcome: "already_bound", memberId: "UB" });
  });

  it("the first-message fallback binds for the author even when another member stores the same name first", async () => {
    const deps = twins();
    expect(await bindOnFirstMessage(deps, { memberId: "UB", channel: "GB" })).toMatchObject({ outcome: "bound", memberId: "UB" });
    expect(getReportChannel(deps.store, "UB")).toEqual({ name: SAME, id: "GB" });
    expect(getReportChannel(deps.store, "UA")?.id).toBeNull();
  });
});
