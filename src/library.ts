import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { Role } from "./store.js";

export interface LibraryFile {
  file: string;
  title: string;
  roles: ("all" | Role)[];
  item?: string;
  /** What the member does (one or more lines, newlines kept: steps and a fenced prompt) and what the copilot checks (one sentence) (FR-AS-012). */
  action?: string;
  check?: string;
  body: string;
}

const oneLine = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Parses one file. Throws naming the file when the front matter or the title is missing. */
export function parseLibraryFile(file: string, text: string): LibraryFile {
  const match = FRONT_MATTER.exec(text);
  if (!match) throw new Error(`${file}: no front matter`);
  const meta = (parse(match[1] as string) ?? {}) as Record<string, unknown>;
  if (typeof meta.title !== "string" || !meta.title.trim()) throw new Error(`${file}: front matter has no title`);
  const roles = [meta.roles ?? "all"].flat().map(String) as LibraryFile["roles"];
  return {
    file,
    title: meta.title.trim(),
    roles: roles.length ? roles : ["all"],
    item: meta.item ? String(meta.item) : undefined,
    action: oneLine(meta.action),
    check: oneLine(meta.check),
    // HTML comments hold the trust marker and review notes; they never reach the model or the member.
    body: (match[2] as string).replace(/<!--[\s\S]*?-->/g, "").trim(),
  };
}

const markdownFiles = (dir: string) => readdirSync(dir).filter((name) => name.endsWith(".md")).sort();

/** Reads every file on each call (no cache, DD-AS-002). With a role, keeps the files for that role or `all`. */
export function loadLibrary(dir: string, role?: Role): LibraryFile[] {
  const files = markdownFiles(dir).map((name) => parseLibraryFile(name, readFileSync(join(dir, name), "utf8")));
  return role === undefined ? files : files.filter((f) => f.roles.includes("all") || f.roles.includes(role));
}

export const titleOf = (files: LibraryFile[], title: string) => files.find((f) => f.title.toLowerCase() === title.toLowerCase());

/** The library instruction for an item, for a role. */
export const instructionFor = (dir: string, itemId: string, role: Role): LibraryFile | undefined =>
  loadLibrary(dir, role).find((f) => f.item === itemId);

/** The two lines shown beside the role buttons (DD-ST-006). */
export function roleDefinitions(dir: string): { technical: string; nonTechnical: string } {
  const file = titleOf(loadLibrary(dir), "role-definitions");
  const lines = file?.body.split(/\r?\n/).map((l) => l.trim()) ?? [];
  return {
    technical: lines.find((l) => l.startsWith("technical:")) ?? "technical:",
    nonTechnical: lines.find((l) => l.startsWith("non-technical:")) ?? "non-technical:",
  };
}

/** The glossary link line, as it appears in the first message and in the reply to a where-is-the-glossary question. */
export const glossaryLine = (url: string) => `The glossary canvas: ${url}`;

/**
 * The first message: the glossary link line (omitted when no URL is set), then the body of `first-message.md`
 * (omitted when the file is absent). Read on each call, so an edit shows at the next start (FR-AS-008).
 */
export function firstMessageText(dir: string, glossaryUrl?: string): string {
  const path = join(dir, "first-message.md");
  const body = existsSync(path) ? parseLibraryFile("first-message.md", readFileSync(path, "utf8")).body : "";
  return [glossaryUrl ? glossaryLine(glossaryUrl) : "", body].filter(Boolean).join("\n\n");
}

const SECRET_SHAPES = /xoxb-|xapp-|eyJ/;

/** Lint for BP-011 and BP-010. Returns problems; empty means the library passes. */
export function checkLibrary(dir: string): string[] {
  const problems: string[] = [];
  const files: LibraryFile[] = [];
  for (const name of readdirSync(dir).filter((n) => !n.endsWith(".md")).sort()) {
    problems.push(`${name}: only .md files belong in the library folder (other files go in library-files/)`);
  }
  for (const name of markdownFiles(dir)) {
    const text = readFileSync(join(dir, name), "utf8");
    if (SECRET_SHAPES.test(text)) problems.push(`${name}: holds a token-shaped string (xoxb-, xapp- or eyJ)`);
    try {
      files.push(parseLibraryFile(name, text));
    } catch (error) {
      problems.push((error as Error).message);
    }
  }
  const roleDefs = files.find((f) => f.title === "role-definitions");
  if (!roleDefs) problems.push("missing required file: role-definitions");
  else {
    const lines = roleDefs.body.split(/\r?\n/).map((l) => l.trim());
    if (!lines.some((l) => l.startsWith("technical:"))) problems.push("role-definitions: no line starting 'technical:'");
    if (!lines.some((l) => l.startsWith("non-technical:"))) problems.push("role-definitions: no line starting 'non-technical:'");
  }
  for (const id of ["I1", "I2", "I3", "I4", "I7"]) {
    if (!files.some((f) => f.item === id && f.roles.includes("all"))) problems.push(`missing required file: item ${id} for all roles`);
  }
  for (const id of ["I5", "I6"]) {
    if (!files.some((f) => f.item === id && f.roles.includes("technical"))) problems.push(`missing required file: item ${id} for technical`);
  }
  for (const f of files) if (f.item && /^I[1-7]$/.test(f.item)) problems.push(...itemShapeProblems(f, f.item));
  return problems;
}

/** Slack's section limit is 3000 characters; `action` and `check` are posted in one section (FR-AS-012, D12). */
const ACTION_CHECK_LIMIT = 2800;

/** The item-file shape rules (FR-AS-012, D12), one message per broken rule, each naming the file. */
function itemShapeProblems(f: LibraryFile, id: string): string[] {
  const problems: string[] = [];
  const action = f.action ?? "";
  if (!f.action) problems.push(`${f.file}: item ${id} has no action`);
  if (!f.check) problems.push(`${f.file}: item ${id} has no check`);
  else if (f.check.includes("\n")) problems.push(`${f.file}: item ${id} check is not one line`);
  if (f.action && f.check && action.length + f.check.length >= ACTION_CHECK_LIMIT) {
    problems.push(`${f.file}: item ${id} action and check are ${action.length + f.check.length} characters, the limit is under ${ACTION_CHECK_LIMIT}`);
  }
  if (!f.action) return problems;
  const has = (text: string) => action.includes(text);
  const reportLine = /^\s*item:\s*(\S+)\s*$/m.exec(action)?.[1];
  const hasReport = /COPILOT-REPORT v1/.test(action);
  if (id !== "I7" && !has("{channelName}")) problems.push(`${f.file}: item ${id} action has no {channelName}`);
  if (id === "I1" && !has("{botMention}")) problems.push(`${f.file}: item ${id} action has no {botMention}`);
  if (id !== "I1" && id !== "I7" && !(hasReport && reportLine === id)) {
    problems.push(`${f.file}: item ${id} action has no COPILOT-REPORT v1 block with 'item: ${id}'`);
  }
  if (id === "I7") {
    for (const bad of ["{channelName}", "{botMention}", "COPILOT-REPORT"]) {
      if (has(bad)) problems.push(`${f.file}: item ${id} action must not hold ${bad}`);
    }
  }
  return problems;
}
