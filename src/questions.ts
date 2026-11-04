import { answer } from "./assist.js";
import type { ClaudeClient } from "./claudeClient.js";
import type { Deps } from "./deps.js";
import { definitionFor, glossaryLink, isGlossaryLocationQuestion } from "./glossary.js";

/**
 * Free text in the bot DM. Report blocks belong to the verification listener and are not routed here.
 * A glossary term is answered from the file, a where-is-the-glossary question with the link; anything else goes to the library answer. Never calls `tick`.
 */
export async function handleQuestion(deps: Deps, claude: ClaudeClient, input: { memberId: string; channel: string; text: string }): Promise<void> {
  const question = input.text.replace(/<@[A-Z0-9]+>/g, "").trim();
  if (!question || question.includes("COPILOT-REPORT")) return;
  let reply: string | undefined;
  try {
    reply = definitionFor(deps.libraryDir, question);
  } catch (error) {
    deps.log("library_error", { error: (error as Error).message });
  }
  if (reply === undefined && isGlossaryLocationQuestion(question)) reply = glossaryLink(deps.glossaryUrl);
  reply ??= await answer(deps, claude, { memberId: input.memberId, question });
  await deps.slack.chat.postMessage({ channel: input.channel, text: reply });
  deps.log("question", { member: input.memberId, outcome: "answered" });
}
