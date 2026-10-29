import { randomBytes } from "node:crypto";
import type { Store } from "./store.js";

const SUPPORTED_VERSION = 1;
export type ReportItem = "I2" | "I4" | "I6";

export type Rule =
  | "malformed"
  | "version"
  | "nonce-unknown"
  | "nonce-member"
  | "item-mismatch"
  | "nonce-used"
  | "i2-slug"
  | "i2-activity"
  | "i4-skill"
  | "i6-sites";

export type Validation = { ok: true; item: ReportItem; nonce: string } | { ok: false; rule: Rule; message: string };

export interface ParsedReport {
  version: number;
  fields: Record<string, string>;
}

/** Fixed grammar: a `COPILOT-REPORT v<N>` line, then `key: value` lines. Code fences around the block are ignored. */
export function parseReport(text: string): ParsedReport | undefined {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("```"));
  const start = lines.findIndex((l) => /^COPILOT-REPORT v\d+$/.test(l));
  if (start < 0) return undefined;
  const fields: Record<string, string> = {};
  for (const line of lines.slice(start + 1)) {
    const match = /^([a-z_0-9]+): ?(.*)$/.exec(line);
    if (!match) break;
    fields[match[1] as string] = (match[2] as string).trim();
  }
  return { version: Number((lines[start] as string).slice("COPILOT-REPORT v".length)), fields };
}

const fail = (rule: Rule, message: string): Validation => ({ ok: false, rule, message });

export interface ValidateContext {
  memberId: string;
  memberEmail?: string;
  /** `member.role_chosen_at`: the checklist start for the I2 activity rule (DD-VF-006). */
  roleChosenAt: string | null;
  now: () => string;
}

/**
 * The four rules: nonce, item, version, result. Marks the nonce used only when the block is valid.
 * Rule order is the order the member can fix them in.
 */
export function validateReport(store: Store, text: string, ctx: ValidateContext): Validation {
  const report = parseReport(text);
  const nonce = report?.fields.nonce;
  const item = report?.fields.item;
  if (!report || !nonce || !item) return fail("malformed", "That does not look like a COPILOT-REPORT block. Paste the block your Claude returned, unchanged.");
  if (report.version !== SUPPORTED_VERSION) return fail("version", `This report is version ${report.version}; I only read version ${SUPPORTED_VERSION}.`);

  const row = store.get<{ member_id: string; item_id: string; used_at: string | null }>(
    "SELECT member_id, item_id, used_at FROM report_nonce WHERE nonce = ?",
    nonce,
  );
  if (!row) return fail("nonce-unknown", "I did not issue that code. Click Get report prompt on the item and use the new prompt.");
  if (row.member_id !== ctx.memberId) return fail("nonce-member", "That code was issued to someone else. Click Get report prompt for your own.");
  if (row.item_id !== item) return fail("item-mismatch", `That code is for ${row.item_id}, but the block says ${item}.`);
  if (row.used_at) return fail("nonce-used", "That code was already used. Click Get report prompt for a new one.");

  const f = report.fields;
  if (item === "I2") {
    const expected = ctx.memberEmail ? `my-workspace@${ctx.memberEmail}`.toLowerCase() : undefined;
    if (!expected || f.scope_slug?.toLowerCase() !== expected) {
      return fail("i2-slug", "The scope in the block is not your Personal Workspace (my-workspace@ followed by your email).");
    }
    const activity = Date.parse(f.last_knowledge_activity ?? "");
    const started = Date.parse(ctx.roleChosenAt ?? "");
    if (Number.isNaN(activity) || Number.isNaN(started) || activity <= started) {
      return fail("i2-activity", "I see no Context Builder activity since you started. Create a note in Context Builder, then paste a fresh block.");
    }
  } else if (item === "I4") {
    if (f.skill !== "copilot-check") return fail("i4-skill", "The block does not come from the copilot-check skill.");
  } else if (item === "I6") {
    if (!(Number.parseInt(f.site_count ?? "", 10) >= 1)) return fail("i6-sites", "The block shows no Atlassian site. Authorise the Atlassian connector and run the prompt again.");
  } else {
    return fail("malformed", `${item} has no report block.`);
  }

  const claimed = store.run("UPDATE report_nonce SET used_at = ? WHERE nonce = ? AND used_at IS NULL", ctx.now(), nonce);
  if (!claimed) return fail("nonce-used", "That code was already used. Click Get report prompt for a new one.");
  return { ok: true, item, nonce };
}

/** Creates and stores a single-use nonce bound to a member and an item. Every call issues a new one (DD-VF-005). */
export function issueNonce(store: Store, memberId: string, itemId: string, now: () => string): string {
  const nonce = randomBytes(9).toString("base64url");
  store.run("INSERT INTO report_nonce (nonce, member_id, item_id, issued_at) VALUES (?, ?, ?, ?)", nonce, memberId, itemId, now());
  return nonce;
}

/** The text a member pastes into their own Claude. The block it asks for is the one `parseReport` reads. */
export function promptFor(item: ReportItem, nonce: string): string {
  const head = `COPILOT-REPORT v1\nitem: ${item}\nnonce: ${nonce}`;
  const reply = (extra: string) => `Reply with exactly this block, filled in, and nothing else:\n${head}\n${extra}`;
  switch (item) {
    case "I2":
      return [
        "Use your Context Builder connector. Call list_scopes and find my Personal Workspace: the scope whose slug starts with my-workspace@.",
        reply("scope_slug: <that slug>\nlast_knowledge_activity: <stats.lastActivityAt.knowledge as ISO-8601 UTC, or null>"),
      ].join("\n");
    case "I4":
      return [`Run the copilot-check skill with the nonce ${nonce}.`, "It prints a COPILOT-REPORT block. Give me that block unchanged."].join("\n");
    case "I6":
      return [
        "Use your Atlassian connector. List the Atlassian sites I can access and count them.",
        reply("site_count: <the number of sites>"),
      ].join("\n");
  }
}
