import { describe, expect, it } from "vitest";
import { loadCopilotConfig } from "../src/config.js";
import { promptFor } from "../src/report.js";
import { handleAttest, handleReportDm, issueReportPrompt } from "../src/verify.js";
import { itemStatuses, makeDeps, onboard } from "./helpers.js";

type D = ReturnType<typeof makeDeps>;

const CHECK = "C0CHECK01";
const nonceFrom = (deps: D) => /nonce[: ]+([\w-]+)/.exec(deps.fake.last("chat.postMessage").text)?.[1] as string;
const i2Block = (nonce: string) =>
  `COPILOT-REPORT v1\nitem: I2\nnonce: ${nonce}\nscope_slug: my-workspace@sam@example.com\nlast_knowledge_activity: 2026-10-26T10:12:00Z`;
const i6Block = (nonce: string) => `COPILOT-REPORT v1\nitem: I6\nnonce: ${nonce}\nsite_count: 2`;
const nonceRow = (deps: D, nonce: string) => deps.store.get<{ used_at: string | null }>("SELECT used_at FROM report_nonce WHERE nonce = ?", nonce);

async function ready(overrides: Partial<Parameters<typeof makeDeps>[0]>): Promise<D> {
  const deps = makeDeps(overrides);
  deps.fake.emails.U1 = "sam@example.com";
  await onboard(deps, "U1", "technical");
  await handleAttest(deps, "U1", "I1");
  deps.clock.advance(12 * 60_000);
  return deps;
}

describe("paste fallback on (FR-VF-015, Scenario 11)", () => {
  it("the check click DMs the prompt and tells the member to paste the block back into the DM, with no check channel set", async () => {
    const deps = await ready({ reportPasteFallback: true });
    await issueReportPrompt(deps, "U1", "I2");
    const sent = deps.fake.last("chat.postMessage");
    expect(sent.channel).toBe("D-U1");
    expect(sent.text).toContain("list_scopes");
    expect(sent.text).toContain(nonceFrom(deps));
    expect(sent.text).toMatch(/paste .*back .*this DM/is);
    expect(sent.text).not.toMatch(/Slack connector|channel with id/);
    expect(deps.store.all("SELECT * FROM report_nonce WHERE member_id = 'U1'")).toHaveLength(1);
  });

  it("is still gated on item 1", async () => {
    const deps = makeDeps({ reportPasteFallback: true });
    await onboard(deps, "U1", "technical");
    await issueReportPrompt(deps, "U1", "I2");
    expect(deps.store.all("SELECT * FROM report_nonce")).toHaveLength(0);
    expect(deps.fake.last("chat.postMessage").text).toContain("1. Connect Claude to Slack");
  });

  it("a valid I2 block pasted in the DM ticks I2 validated with the nonce as evidence", async () => {
    const deps = await ready({ reportPasteFallback: true });
    await issueReportPrompt(deps, "U1", "I2");
    const nonce = nonceFrom(deps);
    expect(await handleReportDm(deps, { memberId: "U1", channel: "D-U1", text: i2Block(nonce) })).toBe(true);
    expect(deps.store.get("SELECT status, method, evidence_ref FROM checklist_item WHERE member_id = 'U1' AND item_id = 'I2'")).toMatchObject({
      status: "ticked",
      method: "validated",
      evidence_ref: nonce,
    });
  });

  it("a valid I6 block ticks I6 validated", async () => {
    const deps = await ready({ reportPasteFallback: true });
    await issueReportPrompt(deps, "U1", "I6");
    await handleReportDm(deps, { memberId: "U1", channel: "D-U1", text: i6Block(nonceFrom(deps)) });
    expect(itemStatuses(deps, "U1").I6).toBe("ticked");
  });

  it("an invalid block gets one reply naming the rule and ticks nothing", async () => {
    const deps = await ready({ reportPasteFallback: true });
    await issueReportPrompt(deps, "U1", "I2");
    const nonce = nonceFrom(deps);
    const posts = deps.fake.of("chat.postMessage").length;
    await handleReportDm(deps, { memberId: "U1", channel: "D-U1", text: i2Block(nonce).replace("2026-10-26T10:12:00Z", "2026-10-26T09:40:00Z") });
    expect(deps.fake.of("chat.postMessage")).toHaveLength(posts + 1);
    expect(deps.fake.last("chat.postMessage").text).toContain("Create a note in Context Builder");
    expect(itemStatuses(deps, "U1").I2).toBe("pending");
  });
});

describe("paste fallback off, the default (FR-VF-015, Scenario 11)", () => {
  it("the check click asks for no paste and says the block goes in the check channel", async () => {
    const deps = await ready({ checkChannelId: CHECK });
    await issueReportPrompt(deps, "U1", "I2");
    const text = deps.fake.last("chat.postMessage").text;
    expect(text).not.toMatch(/paste/i);
    expect(text).toContain(CHECK);
  });

  it("a valid block pasted in the DM ticks nothing, posts nothing and leaves the nonce unused", async () => {
    const deps = await ready({ checkChannelId: CHECK });
    await issueReportPrompt(deps, "U1", "I2");
    const nonce = nonceFrom(deps);
    const posts = deps.fake.of("chat.postMessage").length;
    expect(await handleReportDm(deps, { memberId: "U1", channel: "D-U1", text: i2Block(nonce) })).toBe(false);
    expect(deps.fake.of("chat.postMessage")).toHaveLength(posts);
    expect(itemStatuses(deps, "U1").I2).toBe("pending");
    expect(nonceRow(deps, nonce)?.used_at).toBeNull();
  });

  it("a block from a member with no role gets no reply either", async () => {
    const deps = makeDeps();
    await handleReportDm(deps, { memberId: "U7", channel: "D7", text: "COPILOT-REPORT v1" });
    expect(deps.fake.of("chat.postMessage")).toHaveLength(0);
  });
});

describe("REPORT_PASTE_FALLBACK and the prompt variant", () => {
  const env = { SLACK_BOT_TOKEN: "x", SLACK_APP_TOKEN: "y", OPERATOR_USER_IDS: "U1" };
  it("is off when unset and on for true or 1", () => {
    expect(loadCopilotConfig(env).reportPasteFallback).toBe(false);
    expect(loadCopilotConfig({ ...env, REPORT_PASTE_FALLBACK: "true" }).reportPasteFallback).toBe(true);
    expect(loadCopilotConfig({ ...env, REPORT_PASTE_FALLBACK: "1" }).reportPasteFallback).toBe(true);
    expect(loadCopilotConfig({ ...env, REPORT_PASTE_FALLBACK: "false" }).reportPasteFallback).toBe(false);
  });
  it("promptFor without a channel asks for the block back and names no channel or connector post", () => {
    for (const item of ["I2", "I4", "I6"] as const) {
      const text = promptFor(item, "n0nce");
      expect(text).toContain("n0nce");
      expect(text).not.toMatch(/Slack connector|channel with id/);
    }
  });
});
