import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { loadLibrary } from "../src/library.js";
import { validateReport } from "../src/report.js";

const skillPath = fileURLToPath(new URL("../skills/copilot-check/SKILL.md", import.meta.url));
const libraryDir = fileURLToPath(new URL("../library", import.meta.url));

describe("copilot-check skill (BP-017)", () => {
  const text = readFileSync(skillPath, "utf8");

  it("has front matter naming the skill", () => {
    const front = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, "\n"))?.[1] ?? "";
    expect(parse(front)).toMatchObject({ name: "copilot-check" });
  });

  it("its block, with the connector's mark appended, passes validate_report for I4 and carries no nonce or code (BP-081)", () => {
    const block = ["COPILOT-REPORT v1", "item: I4", "skill: copilot-check"].join("\n") + " *Sent using* <@U0CDESX6B0V>";
    expect(text.replace(/\r\n/g, "\n")).toContain("COPILOT-REPORT v1\nitem: I4\nskill: copilot-check\n");
    expect(text).not.toMatch(/nonce/i);
    expect(text).not.toMatch(/<code>/);
    expect(validateReport(block, { inMemberChannel: true, authorIsMember: true, roleChosenAt: null, claudeAppId: "U0CDESX6B0V" })).toMatchObject({ ok: true, item: "I4" });
  });

  it("its description names the Onboarding Copilot and it checks the Personal Workspace and posts to the channel the member names", () => {
    const front = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, "\n"))?.[1] ?? "";
    expect((parse(front) as { description: string }).description).toContain("Onboarding Copilot");
    expect(text).toContain("Personal Workspace");
    expect(text).toMatch(/Slack channel the member names/);
    expect(text).toMatch(/Do not ask the member for a code/);
  });

  it("the I4 library file is for all roles and names copilot-check", () => {
    const file = loadLibrary(libraryDir).find((f) => f.item === "I4");
    expect(file?.roles).toContain("all");
    expect(file?.body).toContain("copilot-check");
  });
});

describe("skill-zip instruction text (BP-050)", () => {
  const i4 = () => loadLibrary(libraryDir).find((f) => f.item === "I4")?.body ?? "";

  it("the I4 file tells the member to upload the zip the copilot sends", () => {
    expect(i4()).toMatch(/upload/i);
    expect(i4()).toMatch(/\bzip\b/i);
  });

  it("the I4 file holds a dated menu path line", () => {
    expect(i4()).toMatch(/Menu path checked on \d{4}-\d{2}-\d{2}/);
  });

  it("the I4 file sends the member to no repository", () => {
    expect(i4()).not.toContain("github.com");
    expect(i4()).not.toMatch(/repository/i);
    expect(i4()).not.toContain("skills/copilot-check");
  });

  it("I2, I4 and I6 hold no paste text and no Get report prompt (FR-VF-015)", () => {
    for (const name of ["connect-claude-to-context-builder.md", "add-a-skill-to-the-project.md", "connect-atlassian.md"]) {
      const text = readFileSync(join(libraryDir, name), "utf8");
      expect(text, name).not.toMatch(/paste/i);
      expect(text, name).not.toMatch(/Get report prompt/i);
    }
  });
});
