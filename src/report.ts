const SUPPORTED_VERSION = 1;
export type ReportItem = "I2" | "I3" | "I4" | "I5" | "I6";
const REPORT_ITEM_IDS: readonly string[] = ["I2", "I3", "I4", "I5", "I6"];

export type Rule =
  | "channel"
  | "author"
  | "malformed"
  | "via-claude"
  | "version"
  | "item"
  | "i2-email"
  | "i2-activity"
  | "i3-project"
  | "i4-skill"
  | "i5-repo"
  | "i6-sites";

export type Validation = { ok: true; item: ReportItem } | { ok: false; rule: Rule; message: string };

export interface ParsedReport {
  version: number;
  fields: Record<string, string>;
  /** The message ended with the connector's ` *Sent using* <@...>`, which was removed before the fields were read. */
  viaClaude: boolean;
  /** The user id in that mark; the validator accepts it only when it is the Claude app's. */
  markId?: string;
}

// The Slack connector appends this to the last line of a message it posts (observed 2026-11-02).
const CONNECTOR_SUFFIX = /\s*\*Sent using\*\s*<@([A-Z0-9]+)>\s*$/;

/**
 * A field value as the member's Claude meant it. Slack rewrites an email in a posted message as `<mailto:a@b|a@b>`, and
 * Claude may add backticks, bold or a markdown link; none of that is part of the value.
 */
export function tidyValue(raw: string): string {
  let value = raw.trim();
  const slackMail = /^<mailto:([^|>]+)(?:\|[^>]*)?>$/i.exec(value);
  const mdLink = /^\[([^\]]*)\]\(([^)]*)\)$/.exec(value);
  if (slackMail) value = slackMail[1] as string;
  else if (mdLink) value = (mdLink[2] as string).replace(/^mailto:/i, "") || (mdLink[1] as string);
  return value.replace(/^[`*_"'<\s]+|[`*_"'>\s]+$/g, "").trim();
}

/** Fixed grammar: a `COPILOT-REPORT v<N>` line, then `key: value` lines. Code fences are ignored; the connector's trailing "Sent using" is removed and reported. */
export function parseReport(text: string): ParsedReport | undefined {
  const markId = CONNECTOR_SUFFIX.exec(text)?.[1];
  const lines = text.replace(CONNECTOR_SUFFIX, "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("```"));
  const start = lines.findIndex((l) => /^COPILOT-REPORT v\d+$/.test(l));
  if (start < 0) return undefined;
  const fields: Record<string, string> = {};
  for (const line of lines.slice(start + 1)) {
    const match = /^([a-z_0-9]+): ?(.*)$/.exec(line);
    if (!match) break;
    fields[match[1] as string] = tidyValue(match[2] as string);
  }
  return { version: Number((lines[start] as string).slice("COPILOT-REPORT v".length)), fields, viaClaude: markId !== undefined, markId };
}

const fail = (rule: Rule, message: string): Validation => ({ ok: false, rule, message });

export interface ValidateContext {
  /** The caller has matched the message's channel to the member's channel (FR-VF-012). */
  inMemberChannel: boolean;
  /** The caller has matched the message author to that member (FR-VF-017). */
  authorIsMember: boolean;
  memberEmail?: string;
  /** `member.role_chosen_at`: the checklist start for the I2 activity rule (DD-VF-006). */
  roleChosenAt: string | null;
  /** Slack user id of the Claude app (`claude_app_user_id`); while unknown, no report passes the Claude mark rule. */
  claudeAppId?: string;
  /** `owner/name` the I5 `repo` must equal (HARNESS_REPO); unset accepts any non-empty repo. */
  harnessRepo?: string;
}

/**
 * The rules, in the order the member can fix them: channel, author, Claude mark, version, item, result (Scenario 1).
 * There is no nonce (DD-VF-014); the caller supplies the channel and author checks.
 */
export function validateReport(text: string, ctx: ValidateContext): Validation {
  if (!ctx.inMemberChannel) return fail("channel", "That report was not posted in your own channel, so I did not read it. Post it again in your channel.");
  if (!ctx.authorIsMember) return fail("author", "That report was posted in another member's channel, so I did not read it. Ask your own Claude to post it in your channel.");
  const report = parseReport(text);
  if (!report) return fail("malformed", "That does not look like a COPILOT-REPORT block. Post the block again, unchanged.");
  if (!ctx.claudeAppId || report.markId !== ctx.claudeAppId) return fail("via-claude", "That report was not posted by your Claude through its Slack connector. Ask your Claude to post it, unchanged.");
  if (report.version !== SUPPORTED_VERSION) return fail("version", `This report is version ${report.version}; I only read version ${SUPPORTED_VERSION}.`);
  const f = report.fields;
  const item = f.item;
  if (!item) return fail("malformed", "That does not look like a COPILOT-REPORT block. Post the block again, unchanged.");
  if (!REPORT_ITEM_IDS.includes(item)) return fail("item", `${item} has no report block. I read reports for I2 to I6.`);

  if (item === "I2") {
    const expected = ctx.memberEmail?.toLowerCase();
    if (!expected) {
      return fail("i2-email", "I could not read your email from your Slack profile, so I cannot match the report to you. Use *I did it* for this step and tell an operator.");
    }
    if (f.email?.toLowerCase() !== expected) {
      return fail("i2-email", "The email in the block is not your own Context Builder account. Ask your Claude to read it from your USER scope and post the report again.");
    }
    const activity = Date.parse(f.last_activity ?? "");
    const started = Date.parse(ctx.roleChosenAt ?? "");
    if (Number.isNaN(activity) || Number.isNaN(started) || activity <= started) {
      return fail("i2-activity", "I see no Context Builder activity since you started. Create a note in Context Builder, then ask your Claude to post the report again.");
    }
  } else if (item === "I3") {
    if (!f.project_name) return fail("i3-project", "The block names no Claude Project. Set up a Project, then ask your Claude to post the report again.");
  } else if (item === "I4") {
    if (f.skill !== "copilot-check") return fail("i4-skill", "The block does not come from the copilot-check skill.");
  } else if (item === "I5") {
    if (!f.repo) return fail("i5-repo", "The block names no repository. Connect GitHub, then ask your Claude to post the report again.");
    const harness = ctx.harnessRepo?.trim().toLowerCase();
    if (harness && f.repo.trim().toLowerCase() !== harness) {
      return fail("i5-repo", "The repository in the block is not the harness repo. Connect GitHub to the harness repo, then ask your Claude to post the report again.");
    }
  } else if (!/^\d+$/.test(f.site_count ?? "") || Number.parseInt(f.site_count as string, 10) < 1) {
    return fail("i6-sites", "The block shows no Atlassian site. Authorise the Atlassian connector, then ask your Claude to post the report again.");
  }
  return { ok: true, item: item as ReportItem };
}
