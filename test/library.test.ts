import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkLibrary, instructionFor, loadLibrary, parseLibraryFile, roleDefinitions } from "../src/library.js";
import { FIXTURE_LIBRARY } from "./helpers.js";

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
      nonTechnical: "non-technical: You work in any other consulting role.",
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
  it("passes once I6 exists", () => {
    const dir = copyFixture();
    writeFileSync(join(dir, "i6.md"), "---\ntitle: Connect Atlassian\nroles: technical\nitem: I6\n---\nConnect it.");
    expect(checkLibrary(dir)).toEqual([]);
  });
});
