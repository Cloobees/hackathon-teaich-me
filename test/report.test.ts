import { describe, expect, it } from "vitest";
import { issueNonce, parseReport, promptFor, validateReport, type ValidateContext } from "../src/report.js";
import { openStore, type Store } from "../src/store.js";

const STARTED = "2026-10-26T10:00:00.000Z";
const ctx: ValidateContext = { memberId: "U1", memberEmail: "sam@example.com", roleChosenAt: STARTED, now: () => "2026-10-26T10:30:00.000Z" };

const block = (fields: Record<string, string>, version = 1) =>
  [`COPILOT-REPORT v${version}`, ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`)].join("\n");

function setup(item = "I2", member = "U1"): { store: Store; nonce: string } {
  const store = openStore(":memory:");
  return { store, nonce: issueNonce(store, member, item, ctx.now) };
}
const i2 = (nonce: string, over: Record<string, string> = {}) =>
  block({ item: "I2", nonce, scope_slug: "my-workspace@sam@example.com", last_knowledge_activity: "2026-10-26T10:12:00Z", ...over });

describe("validateReport: one fixture per failure", () => {
  it("passes a valid I2 block and marks the nonce used", () => {
    const { store, nonce } = setup();
    expect(validateReport(store, i2(nonce), ctx)).toEqual({ ok: true, item: "I2", nonce });
    expect(store.get<{ used_at: string }>("SELECT used_at FROM report_nonce WHERE nonce = ?", nonce)?.used_at).toBe(ctx.now());
  });
  it("tolerates a code fence around the block", () => {
    const { store, nonce } = setup();
    expect(validateReport(store, "```\n" + i2(nonce) + "\n```", ctx).ok).toBe(true);
  });
  it("ignores a trailing ' *Sent using* <@...>' the Slack connector appends (FR-VF-016)", () => {
    const { store, nonce } = setup("I4");
    const text = `COPILOT-REPORT v1
item: I4
nonce: ${nonce}
skill: copilot-check *Sent using* <@U0CDESX6B0V>`;
    expect(parseReport(text)?.fields.skill).toBe("copilot-check");
    expect(validateReport(store, text, ctx)).toMatchObject({ ok: true, item: "I4" });
  });
  it("failure messages point at the check button and posting the block again, never Get report prompt or paste", () => {
    const { store, nonce } = setup("I2", "U2");
    const messages = [
      validateReport(store, "hello", ctx),
      validateReport(store, i2("nope"), ctx),
      validateReport(store, i2(nonce), ctx),
      validateReport(store, i2(nonce, { last_knowledge_activity: "null" }), { ...ctx, memberId: "U2" }),
    ].map((r) => (r as { message: string }).message);
    for (const message of messages) expect(message).not.toMatch(/get report prompt|paste/i);
    expect(messages[0]).toMatch(/post the block again, unchanged/i);
    expect(messages[1]).toContain("check button");
  });
  it("malformed block", () => {
    const { store } = setup();
    expect(validateReport(store, "COPILOT-REPORT v1\nnonsense", ctx)).toMatchObject({ ok: false, rule: "malformed" });
    expect(validateReport(store, "hello", ctx)).toMatchObject({ ok: false, rule: "malformed" });
  });
  it("unsupported version", () => {
    const { store, nonce } = setup();
    expect(validateReport(store, block({ item: "I2", nonce }, 2), ctx)).toMatchObject({ ok: false, rule: "version" });
  });
  it("unknown nonce", () => {
    const { store } = setup();
    expect(validateReport(store, i2("nope"), ctx)).toMatchObject({ ok: false, rule: "nonce-unknown" });
  });
  it("nonce of another member", () => {
    const { store, nonce } = setup("I2", "U2");
    expect(validateReport(store, i2(nonce), ctx)).toMatchObject({ ok: false, rule: "nonce-member" });
  });
  it("wrong item", () => {
    const { store, nonce } = setup("I6");
    expect(validateReport(store, i2(nonce), ctx)).toMatchObject({ ok: false, rule: "item-mismatch" });
  });
  it("used nonce (Scenario 4)", () => {
    const { store, nonce } = setup();
    validateReport(store, i2(nonce), ctx);
    const second = validateReport(store, i2(nonce), ctx);
    expect(second).toMatchObject({ ok: false, rule: "nonce-used" });
    expect((second as { message: string }).message).toContain("already used");
  });
  it("I2 slug is not the member's Personal Workspace", () => {
    const { store, nonce } = setup();
    expect(validateReport(store, i2(nonce, { scope_slug: "my-workspace@other@example.com" }), ctx)).toMatchObject({ rule: "i2-slug" });
    expect(validateReport(store, i2(nonce), { ...ctx, memberEmail: undefined })).toMatchObject({ rule: "i2-slug" });
  });
  it("I2 activity before the checklist start, null, or equal to it (Scenario 3)", () => {
    const { store, nonce } = setup();
    expect(validateReport(store, i2(nonce, { last_knowledge_activity: "2026-10-26T09:40:00Z" }), ctx)).toMatchObject({ rule: "i2-activity" });
    expect(validateReport(store, i2(nonce, { last_knowledge_activity: "null" }), ctx)).toMatchObject({ rule: "i2-activity" });
    expect(validateReport(store, i2(nonce, { last_knowledge_activity: STARTED }), ctx)).toMatchObject({ rule: "i2-activity" });
  });
  it("a failed block leaves the nonce unused", () => {
    const { store, nonce } = setup();
    validateReport(store, i2(nonce, { last_knowledge_activity: "2026-10-26T09:40:00Z" }), ctx);
    expect(store.get<{ used_at: string | null }>("SELECT used_at FROM report_nonce WHERE nonce = ?", nonce)?.used_at).toBeNull();
  });
  it("I4 skill must be copilot-check, and a good block passes", () => {
    const { store, nonce } = setup("I4");
    expect(validateReport(store, block({ item: "I4", nonce, skill: "something-else" }), ctx)).toMatchObject({ rule: "i4-skill" });
    expect(validateReport(store, block({ item: "I4", nonce, skill: "copilot-check" }), ctx)).toMatchObject({ ok: true, item: "I4" });
  });
  it("I6 site_count must be 1 or more, and a good block passes", () => {
    const { store, nonce } = setup("I6");
    expect(validateReport(store, block({ item: "I6", nonce, site_count: "0" }), ctx)).toMatchObject({ rule: "i6-sites" });
    expect(validateReport(store, block({ item: "I6", nonce, site_count: "abc" }), ctx)).toMatchObject({ rule: "i6-sites" });
    expect(validateReport(store, block({ item: "I6", nonce, site_count: "2" }), ctx)).toMatchObject({ ok: true, item: "I6" });
  });
});

describe("prompts", () => {
  it("each prompt carries the nonce and asks for the fixed block", () => {
    for (const item of ["I2", "I4", "I6"] as const) {
      const prompt = promptFor(item, "abc123", "C0CHECK01");
      expect(prompt).toContain("abc123");
    }
    expect(promptFor("I2", "abc123", "C0CHECK01")).toContain("COPILOT-REPORT v1\nitem: I2\nnonce: abc123");
    expect(promptFor("I4", "abc123", "C0CHECK01")).toContain("copilot-check");
  });
  it("the block a prompt asks for parses with the grammar the validator reads", () => {
    const parsed = parseReport(promptFor("I6", "n1", "C0CHECK01"));
    expect(parsed?.fields).toMatchObject({ item: "I6", nonce: "n1" });
  });
  it("two issues give two nonces (DD-VF-005)", () => {
    const store = openStore(":memory:");
    expect(issueNonce(store, "U1", "I2", ctx.now)).not.toBe(issueNonce(store, "U1", "I2", ctx.now));
  });
});
