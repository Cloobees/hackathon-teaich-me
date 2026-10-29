import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { Role } from "./store.js";

export interface LibraryFile {
  file: string;
  title: string;
  roles: ("all" | Role)[];
  item?: string;
  body: string;
}

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

const SECRET_SHAPES = /xoxb-|xapp-|eyJ/;

/** Lint for BP-011 and BP-010. Returns problems; empty means the library passes. */
export function checkLibrary(dir: string): string[] {
  const problems: string[] = [];
  const files: LibraryFile[] = [];
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
  for (const id of ["I1", "I2", "I3", "I4"]) {
    if (!files.some((f) => f.item === id && f.roles.includes("all"))) problems.push(`missing required file: item ${id} for all roles`);
  }
  for (const id of ["I5", "I6"]) {
    if (!files.some((f) => f.item === id && f.roles.includes("technical"))) problems.push(`missing required file: item ${id} for technical`);
  }
  return problems;
}
