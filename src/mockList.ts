import { readFileSync } from "node:fs";

export const MOCK_STATUSES = ["replaced", "hidden", "open"] as const;
export type MockStatus = (typeof MOCK_STATUSES)[number];

export interface MockEntry {
  title: string;
  what: string;
  /** The member-visible text; a transcript that contains it shows the mock. */
  text: string;
  status: MockStatus;
}

/** Entries are `## <title>` sections holding `- what:`, `- text:` (in backticks) and `- status:` lines. Throws on a missing text or an unknown status (FR-EN-013). */
export function parseMockList(markdown: string): MockEntry[] {
  const entries = markdown
    .split(/^## /m)
    .slice(1)
    .map((section): MockEntry => {
      const [title = "", ...lines] = section.split("\n");
      const field = (name: string) => lines.find((l) => l.startsWith(`- ${name}:`))?.slice(name.length + 3).trim();
      const need = (name: string) => {
        const value = field(name);
        if (!value) throw new Error(`mock entry "${title.trim()}" has no ${name}`);
        return value;
      };
      const status = need("status");
      if (!(MOCK_STATUSES as readonly string[]).includes(status)) throw new Error(`mock entry "${title.trim()}" has unknown status "${status}"`);
      return { title: title.trim(), what: need("what"), text: need("text").replace(/^`(.*)`$/, "$1"), status: status as MockStatus };
    });
  if (!entries.length) throw new Error("mock list has no entries");
  return entries;
}

export const loadMockList = (path: string): MockEntry[] => parseMockList(readFileSync(path, "utf8"));

/** The entries whose member-visible text occurs in the transcript. */
export const findMock = (transcript: string, list: MockEntry[]): MockEntry[] => list.filter((e) => transcript.includes(e.text));
