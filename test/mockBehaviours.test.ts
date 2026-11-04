import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findMock, loadMockList, parseMockList } from "../src/mockList.js";

const LIST = fileURLToPath(new URL("../docs/mock-behaviours.md", import.meta.url));
const entry = (status: string, text = "`Some mock text`", title = "M1 Thing") => `## ${title}\n- what: a mocked thing\n- text: ${text}\n- status: ${status}\n`;

describe("parseMockList", () => {
  it("reads each entry's what, text and status", () => {
    expect(parseMockList(entry("hidden"))[0]).toEqual({ title: "M1 Thing", what: "a mocked thing", text: "Some mock text", status: "hidden" });
  });
  it("accepts replaced, hidden and open", () => {
    for (const status of ["replaced", "hidden", "open"]) expect(parseMockList(entry(status))[0]?.status).toBe(status);
  });
  it("throws on a missing text, an unknown status or an empty list", () => {
    expect(() => parseMockList("## M1 Thing\n- what: x\n- status: hidden\n")).toThrow(/no text/);
    expect(() => parseMockList(entry("gone"))).toThrow(/unknown status "gone"/);
    expect(() => parseMockList("# Nothing here\n")).toThrow(/no entries/);
  });
});

describe("findMock", () => {
  const list = parseMockList(entry("hidden") + "\n" + entry("open", "`Other text`", "M2 Other"));
  it("returns the entries whose text occurs in the transcript", () => {
    expect(findMock("a line\nSome mock text appeared", list).map((e) => e.title)).toEqual(["M1 Thing"]);
    expect(findMock("nothing here", list)).toEqual([]);
  });
});

describe("docs/mock-behaviours.md", () => {
  const list = loadMockList(LIST);
  it("holds the member-visible text of src/index.ts and src/echo.ts", () => {
    const texts = list.map((e) => e.text);
    for (const t of [
      "Welcome to TeAIch Me! Click the button to upload a test file to your personal workspace.",
      "Upload a test file to my workspace",
      "Echo mode (no agent): pretending I saved",
      "Echo mode (no agent): you said",
    ]) {
      expect(texts).toContain(t);
    }
  });
  it("is found in a transcript that contains one of its texts", () => {
    expect(findMock(`bot: ${list[0]?.text}`, list)).toHaveLength(1);
  });
});

describe("check:mocks", () => {
  const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "scripts/checkMocks.ts", ...args], { encoding: "utf8" });
  it("exits 1 in strict mode when a transcript holds an entry's text, 0 when it does not", () => {
    const dir = mkdtempSync(join(tmpdir(), "mocks-"));
    const dirty = join(dir, "dirty.txt");
    const clean = join(dir, "clean.txt");
    writeFileSync(dirty, 'Echo mode (no agent): you said "hi"');
    writeFileSync(clean, "Here is your next step.");
    expect(run("--strict", dirty).status).toBe(1);
    expect(run("--strict", clean).status).toBe(0);
    expect(run().status).toBe(0);
  }, 30_000);
});
