import { describe, expect, it } from "vitest";
import { answer, API_ERROR } from "../src/assist.js";
import type { ClaudeClient } from "../src/claudeClient.js";
import { definitionFor, GLOSSARY_TERMS, lookupTerm } from "../src/glossary.js";
import { handleQuestion } from "../src/questions.js";
import { applyTick } from "../src/checklistMessage.js";
import { FIXTURE_LIBRARY, makeDeps, onboard } from "./helpers.js";

/** A fake model behind the one interface. Records what it was sent. */
const fake = (reply: string | Error) => {
  const sent: { system: string; user: string }[] = [];
  const client: ClaudeClient = {
    complete: async (args) => {
      sent.push(args);
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  return { client, sent };
};

describe("answer", () => {
  it("sends only the role-filtered files, the question and the rule (FR-AS-001)", async () => {
    const deps = makeDeps();
    await onboard(deps, "U1", "technical");
    const { client, sent } = fake("Do X. [Connect Claude to Slack]");
    await answer(deps, client, { memberId: "U1", question: "How do I connect Slack?" });
    const user = sent[0]?.user as string;
    expect(user).toContain("Connect GitHub");
    expect(user).not.toContain("Tips for non-technical members");
    expect(user).toContain("How do I connect Slack?");
    expect(sent[0]?.system).toContain("NO_ANSWER");
    expect(user).not.toContain("U1");
  });

  it("posts a cited answer with its sources (FR-AS-002)", async () => {
    const deps = makeDeps();
    const { client } = fake("Open Settings, then Connectors. [Connect Claude to Slack]");
    const reply = await answer(deps, client, { question: "How do I connect Slack?" });
    expect(reply).toContain("Open Settings");
    expect(reply).toContain("_Sources: Connect Claude to Slack_");
  });

  it("NO_ANSWER gives the refusal and the closest title and nothing else (Scenario 3)", async () => {
    const deps = makeDeps();
    const { client } = fake("NO_ANSWER: Set up a Claude Project");
    const reply = await answer(deps, client, { question: "What is the capital of France?" });
    expect(reply).toBe("I do not have an answer to that in the onboarding library. The closest topic is *Set up a Claude Project*.");
  });

  it("an answer that cites no library title is treated as no answer", async () => {
    const deps = makeDeps();
    const { client } = fake("Paris is the capital of France.");
    expect(await answer(deps, client, { question: "capital of France?" })).toContain("do not have an answer");
  });

  it("an API error gives exactly the error text", async () => {
    const deps = makeDeps();
    const { client } = fake(new Error("HTTP 500"));
    expect(await answer(deps, client, { question: "anything" })).toBe(API_ERROR);
    expect(API_ERROR).toBe("I could not answer that just now");
  });

  it("ends with the next unticked item and its instruction for the role (Scenario 2)", async () => {
    const deps = makeDeps();
    await onboard(deps, "U1", "technical");
    await applyTick(deps, "U1", "I1", "self-attested", null);
    await applyTick(deps, "U1", "I2", "self-attested", null);
    const { client } = fake("Do X. [Connect Claude to Slack]");
    const reply = await answer(deps, client, { memberId: "U1", question: "How?" });
    expect(reply.endsWith("Create a Project in Claude and give it a name and instructions.")).toBe(true);
    expect(reply).toContain("I3 Set up a Claude Project");
  });

  it("asking changes no checklist row (Scenario 4)", async () => {
    const deps = makeDeps();
    await onboard(deps, "U1", "technical");
    const before = deps.store.all("SELECT * FROM checklist_item ORDER BY item_id");
    const { client } = fake("Say it is done. [Connect Claude to Slack]");
    await answer(deps, client, { memberId: "U1", question: "How do I do I1?" });
    expect(deps.store.all("SELECT * FROM checklist_item ORDER BY item_id")).toEqual(before);
  });
});

describe("question listener", () => {
  it("does not route COPILOT-REPORT text or empty text", async () => {
    const deps = makeDeps();
    const { client, sent } = fake("x");
    await handleQuestion(deps, client, { memberId: "U1", channel: "D1", text: "COPILOT-REPORT v1\nitem: I2" });
    await handleQuestion(deps, client, { memberId: "U1", channel: "D1", text: "   " });
    expect(sent).toHaveLength(0);
    expect(deps.fake.calls).toHaveLength(0);
  });
  it("answers a glossary term from the file with no Claude call", async () => {
    const deps = makeDeps();
    const { client, sent } = fake("x");
    await handleQuestion(deps, client, { memberId: "U1", channel: "D1", text: "What is an MCP?" });
    expect(sent).toHaveLength(0);
    expect(deps.fake.last("chat.postMessage").text).toContain("Model Context Protocol");
  });
  it("posts the library answer for any other question", async () => {
    const deps = makeDeps();
    const { client } = fake("Do X. [Connect Claude to Slack]");
    await handleQuestion(deps, client, { memberId: "U1", channel: "D1", text: "How do I connect Slack?" });
    expect(deps.fake.last("chat.postMessage").text).toContain("Do X.");
  });
});

describe("glossary (FR-AS-007)", () => {
  it("holds all 14 terms with a definition each", () => {
    expect(GLOSSARY_TERMS).toHaveLength(14);
    for (const term of GLOSSARY_TERMS) expect(lookupTerm(FIXTURE_LIBRARY, term)).not.toContain("is not defined");
  });
  it("a term outside the list is not defined", () => {
    expect(lookupTerm(FIXTURE_LIBRARY, "blockchain")).toBe('"blockchain" is not defined in the glossary.');
  });
  it("a how-to question that contains a term word is not a definition request", () => {
    expect(definitionFor(FIXTURE_LIBRARY, "How do I add a skill to my Project?")).toBeUndefined();
    expect(definitionFor(FIXTURE_LIBRARY, "What is the capital of France?")).toBeUndefined();
  });
  it("prefers the longer term", () => {
    expect(definitionFor(FIXTURE_LIBRARY, "What is a context window?")).toContain("How much text");
  });
});
