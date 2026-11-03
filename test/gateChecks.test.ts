import { describe, expect, it } from "vitest";
import { handleAttest, issueReportPrompt } from "../src/verify.js";
import { itemStatuses, makeDeps, onboard } from "./helpers.js";

const CHECK = "C0CHECK01";
type D = ReturnType<typeof makeDeps>;

async function ready(overrides: Partial<Parameters<typeof makeDeps>[0]> = { checkChannelId: CHECK }): Promise<D> {
  const deps = makeDeps(overrides);
  await onboard(deps, "U1", "technical");
  return deps;
}
const nonces = (deps: D) => deps.store.all("SELECT * FROM report_nonce WHERE member_id = 'U1'");
const dms = (deps: D) => deps.fake.of("chat.postMessage").filter((c) => c.args.channel === "D-U1");

describe("gate on item 1 (FR-VF-012, Scenario 8)", () => {
  it.each(["I2", "I4", "I6"])("with I1 unticked, the %s check sends no prompt, no nonce and one DM naming item 1", async (item) => {
    const deps = await ready();
    const posts = deps.fake.of("chat.postMessage").length;
    await issueReportPrompt(deps, "U1", item);
    expect(nonces(deps)).toHaveLength(0);
    expect(deps.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM report_nonce")?.n).toBe(0);
    expect(deps.fake.of("chat.postMessage")).toHaveLength(posts + 1);
    const text = deps.fake.last("chat.postMessage").text;
    expect(text).toContain("1. Connect Claude to Slack");
    expect(text).not.toMatch(/\bI[1-7]\b/);
    expect(text).not.toContain("COPILOT-REPORT");
  });

  it("I did it on I2 still ticks self-attested while I1 is unticked", async () => {
    const deps = await ready();
    await handleAttest(deps, "U1", "I2");
    expect(deps.store.get("SELECT method, evidence_ref FROM checklist_item WHERE member_id = 'U1' AND item_id = 'I2'")).toMatchObject({
      method: "self-attested",
      evidence_ref: null,
    });
  });

  it("with I1 ticked, each click inserts one nonce bound to the member and item and sends one DM", async () => {
    const deps = await ready();
    await handleAttest(deps, "U1", "I1");
    expect(itemStatuses(deps, "U1").I1).toBe("ticked");
    const posts = deps.fake.of("chat.postMessage").length;
    await issueReportPrompt(deps, "U1", "I2");
    await issueReportPrompt(deps, "U1", "I2");
    const rows = deps.store.all<{ nonce: string; member_id: string; item_id: string }>("SELECT nonce, member_id, item_id FROM report_nonce");
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.nonce)).size).toBe(2);
    expect(rows.every((r) => r.member_id === "U1" && r.item_id === "I2")).toBe(true);
    expect(deps.fake.of("chat.postMessage")).toHaveLength(posts + 2);
    const text = deps.fake.last("chat.postMessage").text;
    expect(text).toContain(rows[1]?.nonce);
    expect(text).toContain(CHECK);
    expect(text).toMatch(/Slack connector/);
    expect(text).toMatch(/unchanged/);
  });

  it("the bot posts nothing to the check channel and no text mentions the Claude app", async () => {
    const deps = await ready();
    await handleAttest(deps, "U1", "I1");
    for (const item of ["I2", "I4", "I6"]) await issueReportPrompt(deps, "U1", item);
    const posts = deps.fake.of("chat.postMessage");
    expect(posts.some((c) => c.args.channel === CHECK)).toBe(false);
    expect(posts.some((c) => String(c.args.text).includes("<@"))).toBe(false);
    expect(dms(deps).length).toBeGreaterThan(0);
  });

  it("with the check channel unset, the click sends no prompt and says I did it is the route", async () => {
    const deps = await ready({});
    await handleAttest(deps, "U1", "I1");
    const posts = deps.fake.of("chat.postMessage").length;
    await issueReportPrompt(deps, "U1", "I2");
    expect(nonces(deps)).toHaveLength(0);
    expect(deps.fake.of("chat.postMessage")).toHaveLength(posts + 1);
    const text = deps.fake.last("chat.postMessage").text;
    expect(text).toContain("not set up");
    expect(text).toContain("I did it");
    expect(text).not.toContain("COPILOT-REPORT");
  });
});
