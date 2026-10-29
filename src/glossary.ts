import { loadLibrary, titleOf } from "./library.js";

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
