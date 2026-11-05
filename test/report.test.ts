import { describe, expect, it } from "vitest";
import { parseReport, validateReport, type ValidateContext } from "../src/report.js";

const STARTED = "2026-10-26T10:00:00.000Z";
const CLAUDE_APP = "U0CDESX6B0V";
const ctx: ValidateContext = { inMemberChannel: true, authorIsMember: true, memberEmail: "sam@example.com", roleChosenAt: STARTED, claudeAppId: CLAUDE_APP };
const MARK = ` *Sent using* <@${CLAUDE_APP}>`;

/** A block as the member's Claude posts it: the connector appends the mark to the last line. */
const block = (fields: Record<string, string>, { version = 1, mark = true }: { version?: number; mark?: boolean } = {}) =>
  [`COPILOT-REPORT v${version}`, ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`)].join("\n") + (mark ? MARK : "");
const i2 = (over: Record<string, string> = {}) =>
  block({ item: "I2", email: "sam@example.com", last_activity: "2026-10-26T10:12:00Z", ...over });

describe("validateReport: one fixture per rule (Scenario 1)", () => {
  it("passes a valid I2 block, with no nonce line", () => {
    expect(validateReport(i2(), ctx)).toEqual({ ok: true, item: "I2" });
  });
  it("tolerates a code fence around the block", () => {
    expect(validateReport("```\n" + i2().replace(MARK, "") + "\n```" + MARK, ctx).ok).toBe(true);
  });
  it("the exact 2 November 2026 observed text, with the mark on the skill line, passes for I4 (FR-VF-016)", () => {
    const text = `COPILOT-REPORT v1
item: I4
skill: copilot-check *Sent using* <@U0CDESX6B0V>`;
    expect(parseReport(text)).toMatchObject({ viaClaude: true, fields: { skill: "copilot-check" } });
    expect(validateReport(text, ctx)).toEqual({ ok: true, item: "I4" });
  });
  it("a block that still carries a nonce line passes; the line is not read", () => {
    expect(validateReport(i2({ nonce: "anything" }), ctx)).toEqual({ ok: true, item: "I2" });
  });
  it("channel: a report outside the member's channel fails first", () => {
    expect(validateReport(i2(), { ...ctx, inMemberChannel: false })).toMatchObject({ ok: false, rule: "channel" });
    expect(validateReport("hello", { ...ctx, inMemberChannel: false, authorIsMember: false })).toMatchObject({ rule: "channel" });
  });
  it("author: a report written by another member fails (Scenario 12)", () => {
    const result = validateReport(i2(), { ...ctx, authorIsMember: false });
    expect(result).toMatchObject({ ok: false, rule: "author" });
    expect((result as { message: string }).message).toContain("another member's channel");
  });
  it("via-claude: a block typed by the member, with no mark, fails", () => {
    expect(validateReport(i2().replace(MARK, ""), ctx)).toMatchObject({ ok: false, rule: "via-claude" });
    expect(validateReport(block({ item: "I4", skill: "copilot-check" }, { mark: false }), ctx)).toMatchObject({ rule: "via-claude" });
  });
  it("via-claude: the mark in the middle of the message does not count", () => {
    expect(validateReport(`COPILOT-REPORT v1\nitem: I4${MARK}\nskill: copilot-check`, ctx)).toMatchObject({ rule: "via-claude" });
  });
  it("malformed: no block", () => {
    expect(validateReport("hello" + MARK, ctx)).toMatchObject({ ok: false, rule: "malformed" });
    expect(validateReport("COPILOT-REPORT v1\nnonsense" + MARK, ctx)).toMatchObject({ ok: false, rule: "malformed" });
  });
  it("version: v2 fails", () => {
    expect(validateReport(block({ item: "I2" }, { version: 2 }), ctx)).toMatchObject({ ok: false, rule: "version" });
  });
  it("item: I1, I7 and unknown items fail", () => {
    for (const item of ["I1", "I7", "I9", "x"]) {
      expect(validateReport(block({ item }), ctx)).toMatchObject({ ok: false, rule: "item" });
    }
  });
  it("failure messages never point at the check button, Get report prompt or a paste", () => {
    const messages = [
      validateReport("hello", { ...ctx, inMemberChannel: false }),
      validateReport("hello", { ...ctx, authorIsMember: false }),
      validateReport("hello", ctx),
      validateReport(i2().replace(MARK, ""), ctx),
      validateReport(block({ item: "I2" }, { version: 2 }), ctx),
      validateReport(block({ item: "I7" }), ctx),
      validateReport(i2({ last_activity: "null" }), ctx),
      validateReport(block({ item: "I3" }), ctx),
      validateReport(block({ item: "I5" }), ctx),
      validateReport(block({ item: "I6", site_count: "0" }), ctx),
    ].map((r) => (r as { message: string }).message);
    for (const message of messages) expect(message).not.toMatch(/check button|get report prompt|paste/i);
    expect(messages[2]).toMatch(/post the block again, unchanged/i);
  });
  it("I2 email is not the member's own Context Builder email", () => {
    expect(validateReport(i2({ email: "other@example.com" }), ctx)).toMatchObject({ rule: "i2-email" });
    expect(validateReport(i2(), { ...ctx, memberEmail: undefined })).toMatchObject({ rule: "i2-email" });
  });
  it("I2 activity before the checklist start, null, or equal to it (Scenario 3)", () => {
    expect(validateReport(i2({ last_activity: "2026-10-26T09:40:00Z" }), ctx)).toMatchObject({ rule: "i2-activity" });
    expect(validateReport(i2({ last_activity: "null" }), ctx)).toMatchObject({ rule: "i2-activity" });
    expect(validateReport(i2({ last_activity: STARTED }), ctx)).toMatchObject({ rule: "i2-activity" });
  });
  it("I3 project_name must be present and not empty (Scenario 15)", () => {
    expect(validateReport(block({ item: "I3" }), ctx)).toMatchObject({ ok: false, rule: "i3-project" });
    expect(validateReport(block({ item: "I3", project_name: "" }), ctx)).toMatchObject({ ok: false, rule: "i3-project" });
    expect(validateReport(block({ item: "I3", project_name: "Onboarding" }), ctx)).toEqual({ ok: true, item: "I3" });
  });
  it("I4 skill must be copilot-check, and a good block passes", () => {
    expect(validateReport(block({ item: "I4", skill: "something-else" }), ctx)).toMatchObject({ rule: "i4-skill" });
    expect(validateReport(block({ item: "I4", skill: "copilot-check" }), ctx)).toEqual({ ok: true, item: "I4" });
  });
  it("I5 repo must be present and not empty (Scenario 15)", () => {
    expect(validateReport(block({ item: "I5" }), ctx)).toMatchObject({ ok: false, rule: "i5-repo" });
    expect(validateReport(block({ item: "I5", repo: "" }), ctx)).toMatchObject({ ok: false, rule: "i5-repo" });
    expect(validateReport(block({ item: "I5", repo: "synechron/harness" }), ctx)).toEqual({ ok: true, item: "I5" });
  });
  it("I6 site_count must be a whole number of 1 or more, and a good block passes", () => {
    expect(validateReport(block({ item: "I6", site_count: "0" }), ctx)).toMatchObject({ rule: "i6-sites" });
    expect(validateReport(block({ item: "I6", site_count: "abc" }), ctx)).toMatchObject({ rule: "i6-sites" });
    expect(validateReport(block({ item: "I6", site_count: "-1" }), ctx)).toMatchObject({ rule: "i6-sites" });
    expect(validateReport(block({ item: "I6" }), ctx)).toMatchObject({ rule: "i6-sites" });
    expect(validateReport(block({ item: "I6", site_count: "2" }), ctx)).toEqual({ ok: true, item: "I6" });
  });
  it("is stateless: the same valid block validates twice (a repeat is the tick's job, Scenario 4)", () => {
    expect(validateReport(i2(), ctx).ok).toBe(true);
    expect(validateReport(i2(), ctx).ok).toBe(true);
  });
});

describe("the Claude mark must carry the real Claude app user id (Scenario 1, data contract claude_app_user_id)", () => {
  const i4 = (mark: string) => `COPILOT-REPORT v1
item: I4
skill: copilot-check${mark}`;

  it("a mark naming another user fails the via-claude rule, though the block parses", () => {
    const text = i4(" *Sent using* <@U0SOMEONE>");
    expect(parseReport(text)).toMatchObject({ fields: { item: "I4", skill: "copilot-check" } });
    expect(validateReport(text, ctx)).toMatchObject({ ok: false, rule: "via-claude" });
  });
  it("with no Claude app id known, no report passes, whatever id the mark carries", () => {
    const unknown = { ...ctx, claudeAppId: undefined };
    expect(validateReport(i4(MARK), unknown)).toMatchObject({ ok: false, rule: "via-claude" });
    expect(validateReport(i4(" *Sent using* <@U0SOMEONE>"), unknown)).toMatchObject({ ok: false, rule: "via-claude" });
    expect(validateReport(i2(), unknown)).toMatchObject({ ok: false, rule: "via-claude" });
  });
  it("the real id passes", () => {
    expect(validateReport(i4(MARK), ctx)).toEqual({ ok: true, item: "I4" });
  });
});

describe("I5 repo against HARNESS_REPO (Scenario 15, data contract harness_repo)", () => {
  const i5 = (repo: string) => block({ item: "I5", repo });

  it("when set, a different repo fails with the i5-repo rule and the same repo passes", () => {
    const set = { ...ctx, harnessRepo: "synechron/harness" };
    expect(validateReport(i5("other/repo"), set)).toMatchObject({ ok: false, rule: "i5-repo" });
    expect(validateReport(i5("synechron/harness"), set)).toEqual({ ok: true, item: "I5" });
  });
  it("the comparison trims and ignores case, on both sides", () => {
    expect(validateReport(i5("  Synechron/Harness "), { ...ctx, harnessRepo: "synechron/harness" }).ok).toBe(true);
    expect(validateReport(i5("synechron/harness"), { ...ctx, harnessRepo: " Synechron/Harness  " }).ok).toBe(true);
  });
  it("when set, an empty repo still fails", () => {
    expect(validateReport(block({ item: "I5", repo: "" }), { ...ctx, harnessRepo: "synechron/harness" })).toMatchObject({ rule: "i5-repo" });
  });
  it("when unset, or blank, any non-empty repo passes and an empty one fails", () => {
    for (const harnessRepo of [undefined, "", "  "]) {
      expect(validateReport(i5("any/thing"), { ...ctx, harnessRepo })).toEqual({ ok: true, item: "I5" });
      expect(validateReport(block({ item: "I5", repo: "" }), { ...ctx, harnessRepo })).toMatchObject({ rule: "i5-repo" });
    }
  });
});

describe("values as Slack and Claude format them (I2 email bug)", () => {
  const wrapped = [
    ["Slack's mailto link", "<mailto:sam@example.com|sam@example.com>"],
    ["a mailto link with a different label", "<mailto:Sam@Example.com|Sam>"],
    ["backticks", "`sam@example.com`"],
    ["bold", "*sam@example.com*"],
    ["a markdown link", "[sam@example.com](mailto:sam@example.com)"],
  ] as const;
  for (const [name, email] of wrapped) {
    it(`an I2 email as ${name} matches the member's email`, () => {
      expect(validateReport(i2({ email }), ctx)).toEqual({ ok: true, item: "I2" });
    });
  }
  it("a wrapped email for another account still fails", () => {
    expect(validateReport(i2({ email: "<mailto:other@example.com|other@example.com>" }), ctx)).toMatchObject({ rule: "i2-email" });
  });
  it("a last_activity time in backticks or bold is read", () => {
    expect(validateReport(i2({ last_activity: "`2026-10-26T10:12:00Z`" }), ctx).ok).toBe(true);
    expect(validateReport(i2({ last_activity: "*2026-10-26T10:12:00Z*" }), ctx).ok).toBe(true);
  });
  it("an unknown member email gets its own message that does not blame the report", () => {
    const result = validateReport(i2(), { ...ctx, memberEmail: undefined });
    expect(result).toMatchObject({ ok: false, rule: "i2-email" });
    expect((result as { message: string }).message).toContain("could not read your email");
  });
});
