import { describe, expect, it } from "vitest";
import { applyTick } from "../src/checklistMessage.js";
import { makeDeps, onboard } from "./helpers.js";

const text = (blocks: unknown[] | undefined) => JSON.stringify(blocks);

describe("checklist message", () => {
  it("a tick makes one chat.update with text and blocks, highlights the next item, keeps the help line (Scenario 2)", async () => {
    const deps = makeDeps();
    await onboard(deps, "U1", "technical");
    const posts = deps.fake.of("chat.postMessage").length;
    await applyTick(deps, "U1", "I1", "observed", "100.5");

    expect(deps.fake.of("chat.postMessage")).toHaveLength(posts);
    const update = deps.fake.last("chat.update");
    expect(update.text).toContain("1 of 6");
    expect(update.blocks?.length).toBeGreaterThan(0);
    expect(text(update.blocks)).toContain("~I1 Connect Claude to Slack~");
    expect(text(update.blocks)).toMatch(/Next:\* \*I2 Connect Claude to Context Builder/);
    expect(text(update.blocks)).toContain(deps.items.help);
  });

  it("edits the stored checklist message, not a new one", async () => {
    const deps = makeDeps();
    await onboard(deps, "U1", "non-technical");
    const ts = deps.store.get<{ checklist_ts: string }>("SELECT checklist_ts FROM member WHERE member_id = 'U1'")?.checklist_ts;
    await applyTick(deps, "U1", "I1", "self-attested", null);
    expect(deps.fake.last("chat.update").ts).toBe(ts);
  });

  it("a refused I4 sends one DM naming I3 (Scenario 4)", async () => {
    const deps = makeDeps();
    await onboard(deps, "U1", "technical");
    const updates = deps.fake.of("chat.update").length;
    const result = await applyTick(deps, "U1", "I4", "self-attested", null);
    expect(result).toEqual({ status: "refused", needs: "I3" });
    expect(deps.fake.last("chat.postMessage").text).toContain("I3");
    expect(deps.fake.of("chat.update")).toHaveLength(updates);
  });

  it("a validated I4 sends no refusal and ticks both (Scenario 5)", async () => {
    const deps = makeDeps();
    await onboard(deps, "U1", "technical");
    const posts = deps.fake.of("chat.postMessage").length;
    await applyTick(deps, "U1", "I4", "validated", "n1");
    expect(deps.fake.of("chat.postMessage")).toHaveLength(posts);
    expect(text(deps.fake.last("chat.update").blocks)).toContain("~I3 Set up a Claude Project~");
  });

  it("completion sends one message naming the glossary and the help contact, and a duplicate sends none (Scenario 6)", async () => {
    const deps = makeDeps({ glossaryUrl: "https://example.slack.com/canvas/F1" });
    await onboard(deps, "N1", "non-technical");
    for (const id of ["I1", "I2", "I3", "I4"]) await applyTick(deps, "N1", id, "self-attested", null);
    const done = deps.fake.of("chat.postMessage").filter((c) => String(c.args.text).includes("finished onboarding"));
    expect(done).toHaveLength(1);
    expect(done[0]?.args.text).toContain("glossary");
    expect(done[0]?.args.text).toContain(deps.items.help);
    expect(done[0]?.args.text).toContain("https://example.slack.com/canvas/F1");

    await applyTick(deps, "N1", "I4", "self-attested", null);
    expect(deps.fake.of("chat.postMessage").filter((c) => String(c.args.text).includes("finished onboarding"))).toHaveLength(1);
  });

  it("every pending item has an instruction and an I did it button with a confirm dialog (FR-VF-001)", async () => {
    const deps = makeDeps();
    await onboard(deps, "U1", "technical");
    const blocks = deps.fake.last("chat.postMessage").blocks as { type: string; elements?: { action_id: string; confirm?: unknown }[] }[];
    const buttons = blocks.filter((b) => b.type === "actions").flatMap((b) => b.elements ?? []);
    const attest = buttons.filter((b) => b.action_id.startsWith("attest_"));
    expect(attest.map((b) => b.action_id)).toEqual(["attest_I1", "attest_I2", "attest_I3", "attest_I4", "attest_I5", "attest_I6"]);
    for (const b of attest) expect(b.confirm).toMatchObject({ confirm: { text: "Yes, I did it" }, deny: { text: "Cancel" } });
    expect(JSON.stringify(blocks)).toContain("Open Claude, go to Settings");
  });

  it("Get report prompt sits beside I did it on I2, I4 and I6 only (FR-VF-004)", async () => {
    const deps = makeDeps();
    await onboard(deps, "U1", "technical");
    const blocks = deps.fake.last("chat.postMessage").blocks as { type: string; elements?: { action_id: string }[] }[];
    const prompts = blocks.filter((b) => b.type === "actions").flatMap((b) => b.elements ?? []).filter((b) => b.action_id.startsWith("report_prompt_"));
    expect(prompts.map((b) => b.action_id)).toEqual(["report_prompt_I2", "report_prompt_I4", "report_prompt_I6"]);
  });

  it("a ticked item loses its buttons", async () => {
    const deps = makeDeps();
    await onboard(deps, "U1", "technical");
    await applyTick(deps, "U1", "I1", "self-attested", null);
    expect(text(deps.fake.last("chat.update").blocks)).not.toContain("attest_I1");
  });
});
