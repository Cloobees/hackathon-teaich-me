import { glossaryLine, loadLibrary, titleOf } from "./library.js";
import type { Block } from "./slack.js";

/** The fixed list of 14 terms (assist requirement; the authors may change it, OQ-AS-002). */
export const GLOSSARY_TERMS = [
  "model", "effort", "context window", "prompt", "Project", "skill", "connector", "MCP", "memory", "agent", "token",
  "Personal Workspace", "scope", "node",
];

/** `library/glossary.md` holds one `## Term` heading per term, then its definition (DD-AS-003). */
export function parseGlossary(body: string): Map<string, string> {
  const terms = new Map<string, string>();
  for (const part of body.split(/^## /m).slice(1)) {
    const [heading, ...rest] = part.split(/\r?\n/);
    terms.set((heading as string).trim().toLowerCase(), rest.join("\n").trim());
  }
  return terms;
}

export function lookupTerm(libraryDir: string, term: string): string {
  const glossary = titleOf(loadLibrary(libraryDir), "Glossary");
  const definition = glossary ? parseGlossary(glossary.body).get(term.trim().toLowerCase()) : undefined;
  return definition ? `*${term.trim()}*: ${definition}` : `"${term.trim()}" is not defined in the glossary.`;
}

const ASKING = /^\s*(what\s+(is|are|does)|what's|whats|define|explain|meaning of)\b/i;

/**
 * A question that asks for a listed term ("What is an MCP?") is answered from the file with no Claude call.
 * A how-to question that merely contains a word like "skill" is not a definition request and returns undefined.
 */
export function definitionFor(libraryDir: string, question: string): string | undefined {
  if (!ASKING.test(question)) return undefined;
  const lower = question.toLowerCase();
  const term = [...GLOSSARY_TERMS]
    .sort((a, b) => b.length - a.length)
    .find((t) => new RegExp(`\\b${t.toLowerCase()}s?\\b`).test(lower));
  return term ? lookupTerm(libraryDir, term) : undefined;
}

/** The reply to a where-is-the-glossary question; the first message opens with the same line (FR-AS-006, FR-AS-009). */
export const glossaryLink = (url?: string) => (url ? glossaryLine(url) : "No glossary link is set yet.");

/** The glossary as a section with an "Open glossary" link button, for the welcome and the checklist (the plain-text line stays as the fallback). */
export const glossaryBlock = (url: string): Block => ({
  type: "section",
  text: { type: "mrkdwn", text: ":book: *Onboarding Glossary*\nThe Claude terms you will meet, in one place." },
  accessory: { type: "button", action_id: "open_glossary", url, text: { type: "plain_text", text: "Open glossary" } },
});

const LOCATION = /\b(where|link|find|what\s+is|what's|whats|show|open)\b/i;

/** A question about the glossary itself rather than a term. Checked after the term path, so it needs no Claude call. */
export const isGlossaryLocationQuestion = (question: string) => /\bglossary\b/i.test(question) && LOCATION.test(question);
