import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { loadLibrary } from "../src/library.js";
import { issueNonce, validateReport } from "../src/report.js";
import { openStore } from "../src/store.js";

const skillPath = fileURLToPath(new URL("../skills/copilot-check/SKILL.md", import.meta.url));
const libraryDir = fileURLToPath(new URL("../library", import.meta.url));

describe("copilot-check skill (BP-017)", () => {
  const text = readFileSync(skillPath, "utf8");

  it("has front matter naming the skill", () => {
    const front = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, "\n"))?.[1] ?? "";
    expect(parse(front)).toMatchObject({ name: "copilot-check" });
  });

  it("its block, with a test nonce substituted, passes validate_report for I4", () => {
    const store = openStore(":memory:");
    const nonce = issueNonce(store, "U1", "I4", () => "2026-10-26T10:00:00Z");
    const block = ["COPILOT-REPORT v1", "item: I4", "nonce: <code>", "skill: copilot-check"].join("\n").replace("<code>", nonce);
    expect(text).toContain("COPILOT-REPORT v1\nitem: I4\nnonce: <code>\nskill: copilot-check".replace(/\n/g, text.includes("\r\n") ? "\r\n" : "\n"));
    expect(validateReport(store, block, { memberId: "U1", roleChosenAt: null, now: () => "2026-10-26T10:05:00Z" })).toMatchObject({ ok: true, item: "I4" });
  });

  it("the I4 library file is for all roles and names copilot-check", () => {
    const file = loadLibrary(libraryDir).find((f) => f.item === "I4");
    expect(file?.roles).toContain("all");
    expect(file?.body).toContain("copilot-check");
  });
});
