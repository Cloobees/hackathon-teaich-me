import { describe, expect, it } from "vitest";
import { handleHomeOpened } from "../src/checklistMessage.js";
import { setMemberChannel } from "../src/store.js";
import { makeDeps, onboard, slackError } from "./helpers.js";

type Published = { user_id: string; view: { type: string; blocks: unknown[] } };
const viewText = (args: unknown) => JSON.stringify((args as Published).view.blocks);

describe("Home tab (FR-CH-020, Scenario 22)", () => {
  it("with a channel: one view with a link to it and no checklist text", async () => {
    const deps = makeDeps({ glossaryUrl: "https://example.slack.com/canvas/F1" });
    await onboard(deps, "U1", "technical");
    const channel = deps.store.get<{ channel_id: string }>("SELECT channel_id FROM member WHERE member_id = ?", "U1")!.channel_id;
    deps.fake.calls.length = 0;

    await handleHomeOpened(deps, "U1");

    const published = deps.fake.of("views.publish");
    expect(published).toHaveLength(1);
    expect(published[0]!.args).toMatchObject({ user_id: "U1", view: { type: "home" } });
    const view = viewText(published[0]!.args);
    expect(view).toContain(`<#${channel}>`);
    expect(view).toContain("Open it to continue");
    expect(view).not.toMatch(/checklist|Role:|done\.|:white_check_mark:|:white_circle:|open_glossary/);
  });

  it.each(["lost", "member_left", "invite_failed"] as const)("with a %s channel: no link, the /onboard-ch hint instead (BP-101 review finding 1)", async (state) => {
    const deps = makeDeps();
    await onboard(deps, "U1", "technical");
    setMemberChannel(deps.store, "U1", { id: "C-1", name: "onboarding-copilot-u1", state });
    deps.fake.calls.length = 0;

    await handleHomeOpened(deps, "U1");

    const view = viewText(deps.fake.of("views.publish")[0]!.args);
    expect(view).toContain("/onboard-ch");
    expect(view).not.toMatch(/<#|open your channel|Open it to continue/);
  });

  it("a rejoin brings the link back", async () => {
    const deps = makeDeps();
    await onboard(deps, "U1", "technical");
    setMemberChannel(deps.store, "U1", { id: "C-1", name: "onboarding-copilot-u1", state: "member_left" });
    setMemberChannel(deps.store, "U1", { id: "C-1", name: "onboarding-copilot-u1", state: "active" });
    deps.fake.calls.length = 0;
    await handleHomeOpened(deps, "U1");
    expect(viewText(deps.fake.of("views.publish")[0]!.args)).toContain("<#C-1>");
  });

  it("with no channel: one view that says to type /onboard-ch and holds no checklist text", async () => {
    const deps = makeDeps();
    await handleHomeOpened(deps, "U9");

    const published = deps.fake.of("views.publish");
    expect(published).toHaveLength(1);
    const view = viewText(published[0]!.args);
    expect(view).toContain("/onboard-ch");
    expect(view).not.toMatch(/checklist|Role:|<#/);
  });

  it("a failing views.publish is logged and does not throw", async () => {
    const deps = makeDeps();
    deps.slack.views.publish = async () => {
      throw slackError("not_authed");
    };
    await expect(handleHomeOpened(deps, "U9")).resolves.toBeUndefined();
    expect(deps.logs.some((l) => l.includes('"event":"home_publish_failed"') && l.includes("not_authed"))).toBe(true);
  });
});
