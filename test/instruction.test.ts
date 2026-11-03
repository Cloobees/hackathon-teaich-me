import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyTick } from "../src/checklistMessage.js";
import { loadLibrary } from "../src/library.js";
import type { Role } from "../src/store.js";
import { FIXTURE_LIBRARY, makeDeps, onboard, type Call } from "./helpers.js";

type Button = { action_id: string; confirm?: unknown };
type Blocks = { type: string; elements?: Button[] }[];

/** The messages that carry an I did it button: the instruction messages. */
const instructions = (deps: ReturnType<typeof makeDeps>): Call[] =>
  deps.fake.of("chat.postMessage").filter((c) => JSON.stringify(c.args.blocks ?? []).includes("attest_"));
const buttons = (call: Call | undefined) =>
  ((call?.args.blocks ?? []) as Blocks).filter((b) => b.type === "actions").flatMap((b) => b.elements ?? []);
const actionIds = (call: Call | undefined) => buttons(call).map((b) => b.action_id);
const body = (call: Call | undefined) => `${call?.args.text} ${JSON.stringify(call?.args.blocks)}`;
/** The lines of the instruction message text, as a member reads them. */
const linesOf = (call: Call | undefined) => String(call?.args.text).split("\n");
const ACTION = "*Do this:* ";
const CHECK = "*I check:* ";
const CONFIRM = "*You confirm:* I cannot check this step, so click *I did it* when you have done it.";
const copyFixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "lib-"));
  cpSync(FIXTURE_LIBRARY, dir, { recursive: true });
  return dir;
};

describe("instruction message", () => {
  it("after a role is stored there is one checklist message and one instruction message, for position 1 only (Scenario 10)", async () => {
    const deps = makeDeps();
    await onboard(deps, "U1", "technical");

    const checklists = deps.fake.of("chat.postMessage").filter((c) => String(c.args.text).includes("onboarding checklist"));
    expect(checklists).toHaveLength(1);
    expect(instructions(deps)).toHaveLength(1);
    const first = instructions(deps)[0];
    expect(actionIds(first)).toEqual(["attest_I1"]);
    expect(buttons(first)[0]?.confirm).toMatchObject({ confirm: { text: "Yes, I did it" }, deny: { text: "Cancel" } });
    expect(body(first)).toContain("1. Connect Claude to Slack");
    expect(body(first)).toContain("Open Claude, go to Settings");
    expect(body(first)).not.toContain("Add the Context Builder connector");
  });

  it("a tick makes one chat.update and one new message naming the ticked item and giving the next instruction (Scenario 11)", async () => {
    const deps = makeDeps();
    await onboard(deps, "U1", "technical");
    const posts = deps.fake.of("chat.postMessage").length;
    const updates = deps.fake.of("chat.update").length;
    await applyTick(deps, "U1", "I1", "observed", "100.5");

    expect(deps.fake.of("chat.update")).toHaveLength(updates + 1);
    expect(deps.fake.of("chat.postMessage")).toHaveLength(posts + 1);
    const next = deps.fake.of("chat.postMessage").at(-1);
    expect(body(next)).toContain("1. Connect Claude to Slack");
    expect(body(next)).toContain("2. Connect Claude to Context Builder");
    expect(body(next)).toContain("Add the Context Builder connector");
    expect(actionIds(next)).toEqual(["attest_I2", "report_prompt_I2"]);
  });

  it("position 2 ticked first names 2 as done and gives the instruction for 1 (Scenario 11)", async () => {
    const deps = makeDeps();
    await onboard(deps, "U1", "technical");
    const posts = deps.fake.of("chat.postMessage").length;
    await applyTick(deps, "U1", "I2", "self-attested", null);

    expect(deps.fake.of("chat.postMessage")).toHaveLength(posts + 1);
    const next = deps.fake.of("chat.postMessage").at(-1);
    expect(body(next)).toContain("2. Connect Claude to Context Builder");
    expect(body(next)).toContain("Open Claude, go to Settings");
    expect(actionIds(next)).toEqual(["attest_I1"]);
  });

  it("a validated I4 with I3 pending names both items in one message", async () => {
    const deps = makeDeps();
    await onboard(deps, "U1", "technical");
    const posts = deps.fake.of("chat.postMessage").length;
    await applyTick(deps, "U1", "I4", "validated", "n1");

    expect(deps.fake.of("chat.postMessage")).toHaveLength(posts + 1);
    const next = deps.fake.of("chat.postMessage").at(-1);
    expect(body(next)).toContain("3. Set up a Claude Project");
    expect(body(next)).toContain("4. Add a skill to the Project and use it");
    expect(actionIds(next)).toEqual(["attest_I1"]);
  });

  it("Get report prompt sits on the instruction message for positions of I2, I4 and I6, and for no other item (FR-VF-004)", async () => {
    const deps = makeDeps();
    await onboard(deps, "U1", "technical");
    const seen: Record<string, string[]> = {};
    for (const id of ["I1", "I2", "I3", "I4", "I5"]) {
      await applyTick(deps, "U1", id, "self-attested", null);
      const next = deps.fake.of("chat.postMessage").at(-1);
      const attest = actionIds(next).find((a) => a.startsWith("attest_")) as string;
      seen[attest.slice("attest_".length)] = actionIds(next).filter((a) => a.startsWith("report_prompt_"));
    }
    expect(seen).toEqual({ I2: ["report_prompt_I2"], I3: [], I4: ["report_prompt_I4"], I5: [], I6: ["report_prompt_I6"] });
  });

  it("an item with no library file still gets a button and says so", async () => {
    const deps = makeDeps();
    await onboard(deps, "U1", "technical");
    for (const id of ["I1", "I2", "I3", "I4", "I5"]) await applyTick(deps, "U1", id, "self-attested", null);
    const next = deps.fake.of("chat.postMessage").at(-1);
    expect(body(next)).toContain("6. Connect Atlassian");
    expect(body(next)).toContain("No instruction is in the library for this step yet.");
  });

  it("the last tick posts the completion message and no instruction message", async () => {
    const deps = makeDeps();
    await onboard(deps, "N1", "non-technical");
    for (const id of ["I1", "I2", "I3", "I4"]) await applyTick(deps, "N1", id, "self-attested", null);
    const instructionsBefore = instructions(deps).length;
    const posts = deps.fake.of("chat.postMessage").length;
    await applyTick(deps, "N1", "I7", "self-attested", null);

    expect(deps.fake.of("chat.postMessage")).toHaveLength(posts + 1);
    expect(String(deps.fake.last("chat.postMessage").text)).toContain("finished onboarding");
    expect(instructions(deps)).toHaveLength(instructionsBefore);
  });

  it("the I4 instruction is followed by one zip upload to the member's DM, and no other item uploads (FR-VF-013)", async () => {
    const deps = makeDeps();
    await onboard(deps, "U1", "technical");
    for (const id of ["I1", "I2"]) await applyTick(deps, "U1", id, "self-attested", null);
    expect(deps.fake.of("files.uploadV2")).toHaveLength(0);

    await applyTick(deps, "U1", "I3", "self-attested", null);
    const order = deps.fake.calls.map((c) => c.method);
    expect(deps.fake.of("files.uploadV2")).toHaveLength(1);
    expect(deps.fake.of("files.uploadV2")[0]?.args).toMatchObject({ channel_id: "D-U1", filename: "copilot-check.zip" });
    expect(order.at(-1)).toBe("files.uploadV2");
    expect(order.at(-2)).toBe("chat.postMessage");
    expect(actionIds(deps.fake.of("chat.postMessage").at(-1))).toEqual(["attest_I4", "report_prompt_I4"]);

    await applyTick(deps, "U1", "I4", "self-attested", null);
    expect(deps.fake.of("files.uploadV2")).toHaveLength(1);
  });

  it("with no zip path or a missing file the I4 instruction still posts and the member gets the one I did it DM", async () => {
    for (const skillZipPath of [undefined, "library-files/does-not-exist.zip"]) {
      const deps = makeDeps({ skillZipPath });
      await onboard(deps, "U1", "technical");
      for (const id of ["I1", "I2"]) await applyTick(deps, "U1", id, "self-attested", null);
      const posts = deps.fake.of("chat.postMessage").length;
      await applyTick(deps, "U1", "I3", "self-attested", null);

      const added = deps.fake.of("chat.postMessage").slice(posts);
      expect(added).toHaveLength(2);
      expect(actionIds(added[0])).toEqual(["attest_I4", "report_prompt_I4"]);
      expect(String(added[1]?.args.text)).toContain("I did it");
      expect(deps.fake.of("files.uploadV2")).toHaveLength(0);
    }
  });

  it("an unchanged tick sends no message", async () => {
    const deps = makeDeps();
    await onboard(deps, "U1", "technical");
    await applyTick(deps, "U1", "I1", "self-attested", null);
    const posts = deps.fake.of("chat.postMessage").length;
    await applyTick(deps, "U1", "I1", "self-attested", null);
    expect(deps.fake.of("chat.postMessage")).toHaveLength(posts);
  });
});

describe("instruction action and check lines (FR-CL-013, Scenario 13)", () => {
  const ROLE_ITEMS: [Role, string[]][] = [
    ["non-technical", ["I1", "I2", "I3", "I4", "I7"]],
    ["technical", ["I1", "I2", "I3", "I4", "I5", "I6", "I7"]],
  ];

  it("for every item of each role the message holds the file's action line and its check line, or a confirm line, and not the body", async () => {
    const library = loadLibrary(FIXTURE_LIBRARY);
    for (const [role, ids] of ROLE_ITEMS) {
      const deps = makeDeps();
      await onboard(deps, "U1", role);
      for (const id of ids) {
        const file = library.find((f) => f.item === id);
        if (!file) {
          // The fixture library has no I6 file, so there are no lines to read.
          expect(body(deps.fake.of("chat.postMessage").at(-1))).toContain("No instruction is in the library for this step yet.");
          await applyTick(deps, "U1", id, "self-attested", null);
          continue;
        }
        expect(file.action, `${id} fixture has an action`).toBeTruthy();
        const lines = linesOf(deps.fake.of("chat.postMessage").at(-1));
        expect(lines).toContain(`${ACTION}${file.action}`);
        if (file.check) {
          expect(lines).toContain(`${CHECK}${file.check}`);
          expect(lines).not.toContain(CONFIRM);
        } else {
          expect(lines).toContain(CONFIRM);
          expect(lines.some((l) => l.startsWith(CHECK))).toBe(false);
        }
        expect(body(deps.fake.of("chat.postMessage").at(-1))).not.toContain(file.body);
        await applyTick(deps, "U1", id, "self-attested", null);
      }
    }
  });

  it("a fixture with the action and check values swapped swaps the two lines", async () => {
    const dir = copyFixture();
    const i2 = loadLibrary(FIXTURE_LIBRARY).find((f) => f.item === "I2");
    writeFileSync(
      join(dir, "i2.md"),
      `---
title: Connect Claude to Context Builder
roles: all
item: I2
action: ${i2?.check}
check: ${i2?.action}
---
Body.`,
    );
    const deps = makeDeps({ libraryDir: dir });
    await onboard(deps, "U1", "non-technical");
    await applyTick(deps, "U1", "I1", "self-attested", null);
    const lines = linesOf(deps.fake.of("chat.postMessage").at(-1));
    expect(lines).toContain(`${ACTION}${i2?.check}`);
    expect(lines).toContain(`${CHECK}${i2?.action}`);
    expect(lines.indexOf(`${ACTION}${i2?.check}`)).toBeLessThan(lines.indexOf(`${CHECK}${i2?.action}`));
  });

  it("an item file with no action falls back to its body, so a library without the keys still works", async () => {
    const dir = copyFixture();
    writeFileSync(join(dir, "i1.md"), "---\ntitle: Connect Claude to Slack\nroles: all\nitem: I1\n---\nBody only instruction for the first step.");
    const deps = makeDeps({ libraryDir: dir });
    await onboard(deps, "U1", "non-technical");
    const first = deps.fake.of("chat.postMessage").at(-1);
    expect(body(first)).toContain("Body only instruction for the first step.");
    expect(body(first)).not.toContain(ACTION);
    expect(body(first)).not.toContain(CONFIRM);
    expect(actionIds(first)).toEqual(["attest_I1"]);
  });

  it("items.yaml holds no action or check key", async () => {
    const { readFileSync } = await import("node:fs");
    const yaml = readFileSync(new URL("../src/items.yaml", import.meta.url), "utf8");
    expect(yaml).not.toMatch(/^\s*-?\s*\{?.*(action|check)\s*:/m);
  });
});
