import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { answer } from "../src/assist.js";
import type { ClaudeClient } from "../src/claudeClient.js";
import { checkLibrary, firstMessageText, instructionFor, loadLibrary, parseLibraryFile, roleDefinitions } from "../src/library.js";
import { FIXTURE_LIBRARY, makeDeps } from "./helpers.js";

const copyFixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "lib-"));
  cpSync(FIXTURE_LIBRARY, dir, { recursive: true });
  return dir;
};

describe("loadLibrary", () => {
  it("parses title, roles and item", () => {
    const i4 = loadLibrary(FIXTURE_LIBRARY).find((f) => f.item === "I4");
    expect(i4).toMatchObject({ title: "Add a skill to the Project", roles: ["all"], item: "I4" });
  });
  it("filters by role", () => {
    const technical = loadLibrary(FIXTURE_LIBRARY, "technical").map((f) => f.title);
    expect(technical).toContain("Connect GitHub");
    expect(technical).not.toContain("Tips for non-technical members");
    expect(loadLibrary(FIXTURE_LIBRARY, "non-technical").map((f) => f.title)).not.toContain("Connect GitHub");
  });
  it("reads the action and check front matter keys, and leaves them undefined when absent (FR-AS-012)", () => {
    expect(loadLibrary(FIXTURE_LIBRARY).find((f) => f.item === "I2")).toMatchObject({
      action: "Add the Context Builder connector in Claude, then create a note in your Personal Workspace.",
      check: "I check through your own Claude that your Personal Workspace has activity since you started.",
    });
    expect(loadLibrary(FIXTURE_LIBRARY).find((f) => f.item === "I3")?.check).toBeUndefined();
    const bare = parseLibraryFile("x.md", "---\ntitle: T\n---\nbody");
    expect(bare.action).toBeUndefined();
    expect(bare.check).toBeUndefined();
  });
  it("treats a file with no roles as all", () => {
    expect(parseLibraryFile("x.md", "---\ntitle: T\n---\nbody").roles).toEqual(["all"]);
  });
  it("shows an edit on the next load, with no cache (Scenario 6)", () => {
    const dir = copyFixture();
    expect(instructionFor(dir, "I3", "technical")?.body).toContain("name and instructions");
    writeFileSync(join(dir, "i3.md"), "---\ntitle: Set up a Claude Project\nroles: all\nitem: I3\n---\nCHANGED instruction");
    expect(instructionFor(dir, "I3", "technical")?.body).toBe("CHANGED instruction");
  });
  it("reads the two role definition lines", () => {
    expect(roleDefinitions(FIXTURE_LIBRARY)).toEqual({
      technical: "technical: You work in repositories or build solutions.",
      nonTechnical: "non-technical: You work in any other role, one that does not build solutions or work in repositories.",
    });
  });
});

describe("checkLibrary", () => {
  it("names a file with no front matter", () => {
    const dir = copyFixture();
    writeFileSync(join(dir, "broken.md"), "no front matter here");
    expect(checkLibrary(dir)).toContain("broken.md: no front matter");
  });
  it("names the first missing required file in the fixture library (I6 is absent)", () => {
    expect(checkLibrary(FIXTURE_LIBRARY)).toEqual(["missing required file: item I6 for technical"]);
  });
  it("flags a token-shaped string", () => {
    const dir = copyFixture();
    writeFileSync(join(dir, "leak.md"), "---\ntitle: Leak\n---\nxoxb-123");
    expect(checkLibrary(dir).some((p) => p.startsWith("leak.md"))).toBe(true);
  });
  it("names a missing I7 file (FR-AS-001)", () => {
    const dir = copyFixture();
    rmSync(join(dir, "i7.md"));
    expect(checkLibrary(dir)).toContain("missing required file: item I7 for all roles");
  });
  it("names a non-markdown file in the library folder (FR-AS-011)", () => {
    const dir = copyFixture();
    writeFileSync(join(dir, "copilot-check.zip"), "zip");
    const problems = checkLibrary(dir).filter((p) => p.includes("copilot-check.zip"));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("only .md files belong");
  });
  it("passes with the zip in a sibling library-files folder", () => {
    const root = mkdtempSync(join(tmpdir(), "lib-"));
    mkdirSync(join(root, "library"));
    mkdirSync(join(root, "library-files"));
    cpSync(FIXTURE_LIBRARY, join(root, "library"), { recursive: true });
    writeFileSync(join(root, "library", "i6.md"), "---\ntitle: Connect Atlassian\nroles: technical\nitem: I6\n---\nConnect it.");
    writeFileSync(join(root, "library-files", "copilot-check.zip"), "zip");
    expect(checkLibrary(join(root, "library"))).toEqual([]);
  });
  it("passes once I6 exists", () => {
    const dir = copyFixture();
    writeFileSync(join(dir, "i6.md"), "---\ntitle: Connect Atlassian\nroles: technical\nitem: I6\n---\nConnect it.");
    expect(checkLibrary(dir)).toEqual([]);
  });
});

describe("firstMessageText (FR-AS-013)", () => {
  const URL = "https://example.slack.com/docs/glossary";
  const FIRST = "---\ntitle: first-message\nroles: all\n---\n<!-- [yellow] review note -->\nI am the Toolchain Copilot.\nI walk you through a checklist.";
  const dirWithFirstMessage = (text = FIRST) => {
    const dir = mkdtempSync(join(tmpdir(), "lib-"));
    writeFileSync(join(dir, "first-message.md"), text);
    return dir;
  };

  it("puts the glossary URL on the first line, then the body with comments removed", () => {
    const text = firstMessageText(dirWithFirstMessage(), URL);
    expect(text.split("\n")[0]).toContain(URL);
    expect(text.endsWith("I am the Toolchain Copilot.\nI walk you through a checklist.")).toBe(true);
    expect(text).not.toContain("<!--");
  });
  it("starts with the body when the URL is unset", () => {
    const text = firstMessageText(dirWithFirstMessage(), undefined);
    expect(text.split("\n")[0]).toBe("I am the Toolchain Copilot.");
    expect(text).not.toContain("glossary");
  });
  it("returns only the glossary line when the file is absent, and nothing when the URL is also unset", () => {
    const dir = mkdtempSync(join(tmpdir(), "lib-"));
    expect(firstMessageText(dir, URL)).toContain(URL);
    expect(firstMessageText(dir, URL).split("\n")).toHaveLength(1);
    expect(firstMessageText(dir, undefined)).toBe("");
  });
  it("shows a rewrite on the next call, with no cache (FR-AS-008)", () => {
    const dir = dirWithFirstMessage();
    expect(firstMessageText(dir, URL)).toContain("Toolchain Copilot");
    writeFileSync(join(dir, "first-message.md"), "---\ntitle: first-message\nroles: all\n---\nCHANGED text");
    expect(firstMessageText(dir, URL)).toContain("CHANGED text");
    rmSync(join(dir, "first-message.md"));
    expect(firstMessageText(dir, URL)).not.toContain("CHANGED text");
  });
  it("is loaded for both roles, with no item and all roles", () => {
    const dir = dirWithFirstMessage();
    for (const role of ["technical", "non-technical"] as const) {
      expect(loadLibrary(dir, role).find((f) => f.title === "first-message")).toMatchObject({ item: undefined, roles: ["all"] });
    }
  });
  it("reaches the model for a question about what the copilot does", async () => {
    const sent: string[] = [];
    const client: ClaudeClient = { complete: async (args) => (sent.push(args.user), "It walks you through a checklist. [first-message]") };
    const deps = makeDeps({ libraryDir: dirWithFirstMessage() });
    await answer(deps, client, { question: "what does this copilot do?" });
    expect(sent[0]).toContain("I am the Toolchain Copilot.\nI walk you through a checklist.");
  });
});
