import { describe, expect, it } from "vitest";
import { applyTick, createChecklist, handleHomeOpened, renderChecklist } from "../src/checklistMessage.js";
import { getRows, itemsForRole } from "../src/checklist.js";
import { makeDeps, onboard, type Call } from "./helpers.js";

const text = (blocks: unknown[] | undefined) => JSON.stringify(blocks);

/** Every string a member can read in a call: `text` fields at any depth. Button action_id and value are not read by members. */
const readable = (node: unknown): string[] => {
  if (Array.isArray(node)) return node.flatMap(readable);
  if (node && typeof node === "object") {
    return Object.entries(node).flatMap(([key, value]) => (key === "text" && typeof value === "string" ? [value] : readable(value)));
  }
  return [];
};
const messages = (calls: Call[]) =>
  calls.filter((c) => ["chat.postMessage", "chat.update", "views.publish"].includes(c.method)).flatMap((c) => readable(c.args));
const ITEM_ID = /(^|[^A-Za-z0-9_])I[1-7]\b/;

describe("checklist message", () => {
  it("a tick makes one chat.update with text and blocks, highlights the next item, keeps the help line (Scenario 2)", async () => {
    const deps = makeDeps();
    await onboard(deps, "U1", "technical");
    const updates = deps.fake.of("chat.update").length;
    await applyTick(deps, "U1", "I1", "observed", "100.5");

    expect(deps.fake.of("chat.update")).toHaveLength(updates + 1);
    const update = deps.fake.last("chat.update");
    expect(update.text).toContain("1 of 7");
    expect(update.blocks?.length).toBeGreaterThan(0);
    expect(text(update.blocks)).toContain("~1. Connect Claude to Slack~");
    expect(text(update.blocks)).toMatch(/Next:\* \*2\. Connect Claude to Context Builder/);
    expect(text(update.blocks)).toContain(deps.items.help);
  });

  it("the checklist is status only: glossary link button first, numbered items, help line, no action buttons, no instruction text (Scenarios 8, 10)", async () => {
    const deps = makeDeps({ glossaryUrl: "https://example.slack.com/canvas/F1" });
    await onboard(deps, "U1", "technical");
    const checklist = deps.fake.of("chat.postMessage").find((c) => String(c.args.text).includes("onboarding checklist"))?.args as {
      blocks: { type: string; text?: { text: string }; accessory?: { type: string; url: string; action_id: string } }[];
    };

    expect(checklist.blocks[0]?.accessory).toMatchObject({ type: "button", url: "https://example.slack.com/canvas/F1", action_id: "open_glossary" });
    const lines = checklist.blocks.map((b) => b.text?.text ?? "");
    const titles = ["Connect Claude to Slack", "Connect Claude to Context Builder", "Set up a Claude Project", "Add a skill to the Project and use it", "Connect GitHub (harness repo)", "Connect Atlassian", "Join the int-sf-ai channel"];
    titles.forEach((title, i) => expect(lines.some((l) => l.includes(`${i + 1}. ${title}`))).toBe(true));
    expect(JSON.stringify(checklist.blocks)).toContain(deps.items.help);
    expect(checklist.blocks.some((b) => b.type === "actions")).toBe(false);
    expect(JSON.stringify(checklist.blocks)).not.toContain("attest_");
    expect(JSON.stringify(checklist.blocks)).not.toContain("report_prompt_");
    expect(JSON.stringify(checklist.blocks)).not.toContain("Open Claude, go to Settings");
    expect(JSON.stringify(checklist.blocks)).not.toContain("No instruction is in the library");
  });

  it("renderChecklist holds no actions block in any state, for either role (FR-VF-011)", async () => {
    for (const role of ["technical", "non-technical"] as const) {
      const deps = makeDeps();
      await onboard(deps, "U1", role);
      const items = itemsForRole(deps.items, role);
      for (const item of [null, ...items]) {
        if (item) await applyTick(deps, "U1", item.id, "self-attested", null);
        const { blocks } = renderChecklist(deps, role, items, getRows(deps.store, "U1"));
        expect(blocks.some((b) => b.type === "actions")).toBe(false);
        expect(JSON.stringify(blocks)).not.toMatch(/"(button|confirm)"|attest_|report_prompt_/);
      }
    }
  });

  it("pins the checklist once and publishes no Home view, at creation or after a tick (Scenario 8)", async () => {
    const deps = makeDeps();
    await onboard(deps, "U1", "technical");
    const ts = deps.store.get<{ checklist_ts: string }>("SELECT checklist_ts FROM member WHERE member_id = 'U1'")?.checklist_ts;

    expect(deps.fake.of("pins.add")).toHaveLength(1);
    expect(deps.fake.of("pins.add")[0]?.args).toEqual({ channel: "C-1", timestamp: ts });
    expect(deps.fake.of("views.publish")).toHaveLength(0);

    await applyTick(deps, "U1", "I1", "observed", "100.5");
    expect(deps.fake.of("views.publish")).toHaveLength(0);
  });

  it("a refused pin shows no Home view, keeps the checklist message and still edits it after a tick (Scenario 9)", async () => {
    const deps = makeDeps();
    deps.fake.failPin = true;
    await onboard(deps, "U1", "technical");
    const ts = deps.store.get<{ checklist_ts: string }>("SELECT checklist_ts FROM member WHERE member_id = 'U1'")?.checklist_ts;

    expect(ts).toBeTruthy();
    expect(deps.fake.of("views.publish")).toHaveLength(0);
    expect(deps.logs.some((l) => l.includes("pin_failed"))).toBe(true);

    await applyTick(deps, "U1", "I1", "observed", "100.5");
    expect(deps.fake.of("views.publish")).toHaveLength(0);
    expect(deps.fake.last("chat.update").ts).toBe(ts);
    expect(text(deps.fake.last("chat.update").blocks)).toContain("~1. Connect Claude to Slack~");
  });

  it("the checklist has no glossary line when no glossary URL is set", async () => {
    const deps = makeDeps();
    await onboard(deps, "U1", "technical");
    const checklist = deps.fake.of("chat.postMessage").find((c) => String(c.args.text).includes("onboarding checklist"))?.args;
    expect(JSON.stringify(checklist?.blocks)).not.toContain("glossary");
  });

  it("numbers by position in the role's own checklist, not by the item's order", async () => {
    const deps = makeDeps();
    await onboard(deps, "N1", "non-technical");
    await applyTick(deps, "N1", "I1", "self-attested", null);
    expect(text(deps.fake.last("chat.update").blocks)).toContain("5. Join the int-sf-ai channel");
  });

  it("edits the stored checklist message, not a new one", async () => {
    const deps = makeDeps();
    await onboard(deps, "U1", "non-technical");
    const ts = deps.store.get<{ checklist_ts: string }>("SELECT checklist_ts FROM member WHERE member_id = 'U1'")?.checklist_ts;
    await applyTick(deps, "U1", "I1", "self-attested", null);
    expect(deps.fake.last("chat.update").ts).toBe(ts);
  });

  it("the checklist, acknowledgement, refusal and completion are all posted and edited in the member's channel, never in the DM (FR-CH-011)", async () => {
    const deps = makeDeps();
    await onboard(deps, "N1", "non-technical");
    await applyTick(deps, "N1", "I4", "self-attested", null); // refused: I3 is unticked
    for (const id of ["I1", "I2", "I3", "I4", "I7"]) await applyTick(deps, "N1", id, "self-attested", null);

    const channels = deps.fake.of("chat.postMessage").map((c) => c.args.channel);
    // The link DM from the start is the only DM post.
    expect(channels.filter((c) => c === "D-N1")).toHaveLength(1);
    expect(channels.filter((c) => c === "C-1").length).toBe(channels.length - 1);
    expect(deps.fake.of("chat.update").every((c) => c.args.channel === "C-1")).toBe(true);
    expect(deps.fake.of("chat.postMessage").some((c) => String(c.args.text).includes("finished onboarding") && c.args.channel === "C-1")).toBe(true);
  });

  it("a member with no channel gets no checklist and the skip is logged as checklist_no_channel", async () => {
    const deps = makeDeps();
    deps.store.run("INSERT INTO member (member_id, started_by, dm_channel_id) VALUES ('U5', 'command', 'D-U5')");
    await createChecklist(deps, "U5", "technical");
    expect(deps.fake.of("chat.postMessage")).toHaveLength(0);
    expect(deps.logs.some((l) => l.includes("checklist_no_channel"))).toBe(true);
  });

  it("a refused I4 posts one message in the channel naming 3. Set up a Claude Project and no letter (Scenario 4)", async () => {
    const deps = makeDeps();
    await onboard(deps, "U1", "technical");
    const updates = deps.fake.of("chat.update").length;
    const posts = deps.fake.of("chat.postMessage").length;
    const result = await applyTick(deps, "U1", "I4", "self-attested", null);
    expect(result).toEqual({ status: "refused", needs: "I3" });
    expect(deps.fake.of("chat.postMessage")).toHaveLength(posts + 1);
    const refusal = deps.fake.last("chat.postMessage").text;
    expect(refusal).toContain("3. Set up a Claude Project");
    expect(refusal).toContain("4. Add a skill to the Project and use it");
    expect(refusal).not.toMatch(ITEM_ID);
    expect(deps.fake.of("chat.update")).toHaveLength(updates);
  });

  it("a validated I4 sends no refusal, ticks both and posts one message naming both (Scenario 5)", async () => {
    const deps = makeDeps();
    await onboard(deps, "U1", "technical");
    const posts = deps.fake.of("chat.postMessage").length;
    await applyTick(deps, "U1", "I4", "validated", "n1");
    expect(deps.fake.of("chat.postMessage")).toHaveLength(posts + 1);
    expect(text(deps.fake.last("chat.update").blocks)).toContain("~3. Set up a Claude Project~");
  });

  it("completion sends one message naming the glossary and the help contact, and a duplicate sends none (Scenario 6)", async () => {
    const deps = makeDeps({ glossaryUrl: "https://example.slack.com/canvas/F1" });
    await onboard(deps, "N1", "non-technical");
    for (const id of ["I1", "I2", "I3", "I4", "I7"]) await applyTick(deps, "N1", id, "self-attested", null);
    const done = deps.fake.of("chat.postMessage").filter((c) => String(c.args.text).includes("finished onboarding"));
    expect(done).toHaveLength(1);
    expect(done[0]?.args.text).toContain("glossary");
    expect(done[0]?.args.text).toContain(deps.items.help);
    expect(done[0]?.args.text).toContain("https://example.slack.com/canvas/F1");
    expect(done[0]?.args.text).toContain("int-sf-ai");
    expect(done[0]?.args.text).not.toMatch(/stuck/i);

    await applyTick(deps, "N1", "I7", "self-attested", null);
    expect(deps.fake.of("chat.postMessage").filter((c) => String(c.args.text).includes("finished onboarding"))).toHaveLength(1);
  });

  it("the checklist never carries buttons, before or after a tick", async () => {
    const deps = makeDeps();
    await onboard(deps, "U1", "technical");
    await applyTick(deps, "U1", "I1", "self-attested", null);
    expect(text(deps.fake.last("chat.update").blocks)).not.toContain("attest_");
    expect(text(deps.fake.last("chat.update").blocks)).not.toContain("report_prompt_");
  });

  it("the help line names the help channel and has no stuck wording", () => {
    const { items } = makeDeps();
    expect(items.help).toContain("int-sf-ai");
    expect(items.help).not.toMatch(/stuck|\{helpChannel\}/i);
  });

  it.each([
    ["technical", ["I1", "I2", "I3", "I4", "I5", "I6", "I7"]],
    ["non-technical", ["I1", "I2", "I3", "I4", "I7"]],
  ] as const)("a full %s run leaves no item id in any message or block text (Scenario 12)", async (role, ids) => {
    const deps = makeDeps({ glossaryUrl: "https://example.slack.com/canvas/F1" });
    await onboard(deps, "U1", role);
    await applyTick(deps, "U1", "I4", "self-attested", null);
    for (const id of ids) await applyTick(deps, "U1", id, "self-attested", null);

    const seen = messages(deps.fake.calls);
    expect(seen.length).toBeGreaterThan(ids.length);
    expect(seen.filter((t) => ITEM_ID.test(t))).toEqual([]);
    expect(deps.fake.of("chat.postMessage").filter((c) => String(c.args.text).includes("finished onboarding"))).toHaveLength(1);
  });
});

describe("Home tab", () => {
  it("shows the checklist with the glossary button for a member who has started", async () => {
    const deps = makeDeps({ glossaryUrl: "https://example.slack.com/canvas/F1" });
    await onboard(deps, "U1", "technical");
    const before = deps.fake.of("views.publish").length;
    await handleHomeOpened(deps, "U1");

    const published = deps.fake.of("views.publish");
    expect(published).toHaveLength(before + 1);
    const args = published.at(-1)?.args as unknown as { user_id: string; view: { type: string; blocks: unknown[] } };
    expect(args).toMatchObject({ user_id: "U1", view: { type: "home" } });
    expect(text(args.view.blocks)).toContain("Your onboarding checklist");
    expect(text(args.view.blocks)).toContain("open_glossary");
  });

  it("points a member who has not started to /onboard", async () => {
    const deps = makeDeps();
    await handleHomeOpened(deps, "U9");
    const blocks = (deps.fake.of("views.publish").at(-1)?.args as unknown as { view: { blocks: unknown[] } }).view.blocks;
    expect(text(blocks)).toContain("/onboard");
    expect(text(blocks)).not.toContain("Your onboarding checklist");
  });
});
