import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { resetMember } from "../src/checklist.js";
import { applyTick } from "../src/checklistMessage.js";
import { instructionText, sendInstruction } from "../src/instruction.js";
import { handleRole, startOnboarding } from "../src/start.js";
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
    expect(first?.args.channel).toBe("C-1");
  });

  it("sendInstruction posts to the channel it is given (FR-CH-011)", async () => {
    const deps = makeDeps();
    await onboard(deps, "U1", "technical");
    await sendInstruction(deps, "U1", "C-ELSEWHERE", "technical");
    expect(deps.fake.of("chat.postMessage").at(-1)?.args.channel).toBe("C-ELSEWHERE");
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
    expect(actionIds(next)).toEqual(["attest_I2"]);
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

  it("every instruction message carries the one I did it button and no check button, on I2, I4 and I6 too (FR-VF-001)", async () => {
    const deps = makeDeps();
    await onboard(deps, "U1", "technical");
    const seen: Record<string, string[]> = {};
    for (const id of ["I1", "I2", "I3", "I4", "I5"]) {
      await applyTick(deps, "U1", id, "self-attested", null);
      const ids = actionIds(deps.fake.of("chat.postMessage").at(-1));
      seen[(ids[0] as string).slice("attest_".length)] = ids;
    }
    expect(seen).toEqual({ I2: ["attest_I2"], I3: ["attest_I3"], I4: ["attest_I4"], I5: ["attest_I5"], I6: ["attest_I6"] });
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

  it("the I4 instruction is followed by one zip upload into the member's channel, and no other item uploads (FR-VF-013)", async () => {
    const deps = makeDeps();
    await onboard(deps, "U1", "technical");
    for (const id of ["I1", "I2"]) await applyTick(deps, "U1", id, "self-attested", null);
    expect(deps.fake.of("files.uploadV2")).toHaveLength(0);

    await applyTick(deps, "U1", "I3", "self-attested", null);
    const channel = deps.store.get<{ channel_id: string }>("SELECT channel_id FROM member WHERE member_id = ?", "U1")!.channel_id;
    const order = deps.fake.calls.map((c) => c.method);
    expect(deps.fake.of("files.uploadV2")).toHaveLength(1);
    expect(deps.fake.of("files.uploadV2")[0]?.args).toMatchObject({ channel_id: channel, filename: "copilot-check.zip" });
    expect(order.at(-1)).toBe("files.uploadV2");
    expect(order.at(-2)).toBe("chat.postMessage");
    expect(actionIds(deps.fake.of("chat.postMessage").at(-1))).toEqual(["attest_I4"]);

    await applyTick(deps, "U1", "I4", "self-attested", null);
    expect(deps.fake.of("files.uploadV2")).toHaveLength(1);
  });

  it("with no zip path or a missing file the I4 instruction still posts and the member gets the one I did it fallback in the channel", async () => {
    for (const skillZipPath of [undefined, "library-files/does-not-exist.zip"]) {
      const deps = makeDeps({ skillZipPath });
      await onboard(deps, "U1", "technical");
      for (const id of ["I1", "I2"]) await applyTick(deps, "U1", id, "self-attested", null);
      const posts = deps.fake.of("chat.postMessage").length;
      await applyTick(deps, "U1", "I3", "self-attested", null);

      const added = deps.fake.of("chat.postMessage").slice(posts);
      expect(added).toHaveLength(2);
      expect(actionIds(added[0])).toEqual(["attest_I4"]);
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

describe("instruction placeholders and the stored channel id (FR-CL-013, FR-CH-013)", () => {
  const instructionCall = (deps: ReturnType<typeof makeDeps>) => deps.fake.of("chat.postMessage").find((c) => String(c.args.text).includes("Do this"));
  const first = (deps: ReturnType<typeof makeDeps>) => String(instructionCall(deps)?.args.text);

  it("replaces the placeholders in the I1 message with the channel id and keeps the steps and the fenced prompt in order", async () => {
    const deps = makeDeps({ botMention: "Copilot Dev" });
    await onboard(deps, "U1", "technical");

    const text = first(deps);
    expect(text).not.toContain("{");
    expect(text).toContain("named C-1. If a channel");
    expect(text).toContain("/invite Copilot Dev");
    expect(text).toContain("welcome message to C-1.");
    const parts = ["1. Open Claude", "2. Give your own Claude", "```", "Using your Slack connector", "```", "3. In that channel", "4. Once the copilot", "*I check:*"];
    const at: number[] = [];
    for (const part of parts) at.push(text.indexOf(part, (at.at(-1) ?? -1) + 1));
    expect(at.every((n) => n >= 0)).toBe(true);
    expect(linesOf(instructionCall(deps)).at(-1)).toBe(
      "*I check:* I tick this step when I see the message from Claude. If I do not, click I did it and confirm.",
    );
    expect(actionIds(instructionCall(deps))).toEqual(["attest_I1"]);
  });

  it("uses the default mention when the deps carry none", async () => {
    const deps = makeDeps();
    await onboard(deps, "U1", "technical");
    expect(first(deps)).toContain("/invite @onboarding-copilot");
  });

  it("{channelName} in the I1 message is the member's stored channel id, whatever the profile name is (no I1 exception)", async () => {
    const deps = makeDeps();
    deps.fake.profiles.U1 = { real_name: "José Núñez-Smith" };
    await onboard(deps, "U1", "technical");
    expect(first(deps)).toContain("named C-1.");
    expect(first(deps)).not.toMatch(/onboarding-copilot-|jose/i);
  });

  it("no profile lookup, no channel name build and no report channel write happen when an instruction is sent", async () => {
    const deps = makeDeps();
    await startOnboarding(deps, { memberId: "U1", startedBy: "command" });
    const lookups = vi.spyOn(deps.slack.users, "info");
    await handleRole(deps, { memberId: "U1", role: "technical", channel: "C-1", messageTs: "100.001" });
    await applyTick(deps, "U1", "I1", "self-attested", null);
    expect(lookups).not.toHaveBeenCalled();
    expect(deps.logs.some((l) => l.includes("users_info_failed"))).toBe(false);
    expect(deps.store.get("SELECT report_channel_name, report_channel_id FROM member WHERE member_id = 'U1'")).toEqual({ report_channel_name: null, report_channel_id: null });
  });

  it("the id filled in is the stored one, not the channel the message is posted to", async () => {
    const deps = makeDeps();
    await onboard(deps, "U1", "technical");
    await sendInstruction(deps, "U1", "C-ELSEWHERE", "technical");
    const text = String(deps.fake.of("chat.postMessage").at(-1)?.args.text);
    expect(text).toContain("named C-1.");
    expect(text).not.toContain("C-ELSEWHERE");
  });

  it("two members get their own channel ids, and a reset keeps the stored id for the next instruction", async () => {
    const deps = makeDeps();
    await onboard(deps, "U1", "technical");
    await onboard(deps, "U2", "technical");
    const texts = instructions(deps).map((c) => String(c.args.text));
    expect(texts[0]).toContain("named C-1.");
    expect(texts[1]).toContain("named C-2.");
    resetMember(deps.store, "U1");
    expect(deps.store.get("SELECT channel_id FROM member WHERE member_id = 'U1'")).toEqual({ channel_id: "C-1" });
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
        const text = String(deps.fake.of("chat.postMessage").at(-1)?.args.text);
        const lines = linesOf(deps.fake.of("chat.postMessage").at(-1));
        const action = file.action?.replaceAll("{channelName}", "C-1").replaceAll("{botMention}", "@onboarding-copilot");
        expect(text).toContain(`${ACTION}${action}\n`);
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

describe("long instructions are split to fit Slack's 3000-character section limit (BP-078)", () => {
  const SLACK_LIMIT = 3000;
  /** A library whose I1 file has the given action lines. */
  const libraryWithAction = (lines: string[]) => {
    const dir = copyFixture();
    const indented = lines.map((l) => `  ${l}`).join("\n");
    writeFileSync(join(dir, "i1.md"), `---\ntitle: Connect Claude to Slack\nroles: all\nitem: I1\naction: |\n${indented}\ncheck: I tick this step when I see the message.\n---\nBody.`);
    return dir;
  };
  const numbered = (count: number, width: number) => Array.from({ length: count }, (_, i) => `Line ${String(i).padStart(3, "0")} `.padEnd(width, "x"));
  const sections = (deps: ReturnType<typeof makeDeps>) =>
    ((instructions(deps)[0]?.args.blocks ?? []) as { type: string; text?: { type: string; text: string } }[]).filter((b) => b.type === "section");
  const sectionTexts = (deps: ReturnType<typeof makeDeps>) => sections(deps).map((b) => b.text?.text ?? "");

  it("an action of about 7000 characters posts only blocks of 3000 characters or fewer, with every line in order", async () => {
    const lines = numbered(140, 50);
    const deps = makeDeps({ libraryDir: libraryWithAction(lines) });
    await onboard(deps, "U1", "technical");

    const texts = sectionTexts(deps);
    expect(texts.length).toBeGreaterThan(2);
    for (const text of texts) expect(text.length).toBeLessThanOrEqual(SLACK_LIMIT);
    const joined = texts.join("\n");
    let at = -1;
    for (const line of lines) {
      const found = joined.indexOf(line, at + 1);
      expect(found, line).toBeGreaterThan(at);
      at = found;
    }
    expect(joined).toContain("*I check:* I tick this step when I see the message.");
    expect(actionIds(instructions(deps)[0])).toEqual(["attest_I1"]);
  });

  it("a code fence that spans a split stays balanced in every block", async () => {
    const deps = makeDeps({ libraryDir: libraryWithAction(["Before the prompt.", "```", ...numbered(100, 60), "```", "After the prompt."]) });
    await onboard(deps, "U1", "technical");

    const texts = sectionTexts(deps);
    expect(texts.length).toBeGreaterThan(2);
    for (const text of texts) {
      expect(text.length).toBeLessThanOrEqual(SLACK_LIMIT);
      expect(text.match(/```/g)?.length ?? 0, text.slice(0, 40)).toSatisfy((n: number) => n % 2 === 0);
    }
    const joined = texts.join("\n");
    expect(joined).toContain("After the prompt.");
    expect(joined.indexOf("Before the prompt.")).toBeLessThan(joined.indexOf("Line 099"));
  });

  it("a single line over the limit is split too, and nothing is lost", async () => {
    const long = "y".repeat(7000);
    const deps = makeDeps({ libraryDir: libraryWithAction([long]) });
    await onboard(deps, "U1", "technical");

    const texts = sectionTexts(deps);
    for (const text of texts) expect(text.length).toBeLessThanOrEqual(SLACK_LIMIT);
    expect(texts.join("").replaceAll(/[^y]/g, "").length).toBe(7000);
  });

  it("placeholders are filled before splitting: a 2799-character action with two {channelName} and an 80-character id stays within 3000", async () => {
    const lines = ["Create {channelName} then tell Claude to write to {channelName}.", ...numbered(26, 107)];
    const deps = makeDeps({ libraryDir: libraryWithAction(lines) });
    const id = `C${"A".repeat(79)}`;
    await startOnboarding(deps, { memberId: "U1", startedBy: "command" });
    deps.store.run("UPDATE member SET channel_id = ? WHERE member_id = 'U1'", id);
    await handleRole(deps, { memberId: "U1", role: "technical", channel: id, messageTs: "100.001" });

    const texts = sectionTexts(deps);
    for (const text of texts) expect(text.length).toBeLessThanOrEqual(SLACK_LIMIT);
    const joined = texts.join("\n");
    expect(joined).not.toContain("{channelName}");
    expect(joined).toContain(`Create ${id} then tell Claude to write to ${id}.`);
  });

  it("a short instruction is still one section block", async () => {
    const deps = makeDeps();
    await onboard(deps, "U1", "technical");
    expect(sections(deps)).toHaveLength(1);
  });
});

const REAL_LIBRARY = fileURLToPath(new URL("../library", import.meta.url));

describe("channel reference in the real library (FR-CH-013)", () => {
  const item = (id: string, name: string, order: number) => ({ id, name, roles: "all", order }) as never;
  it("fills {channelName} with the channel id alone for I3 and for I1, with no 'channel ID' suffix", () => {
    const deps = makeDeps({ libraryDir: REAL_LIBRARY });
    for (const i of [item("I3", "Set up a Claude Project", 3), item("I1", "Connect Claude to Slack", 1)]) {
      const text = instructionText(deps, i, "technical", "C0BOUND01");
      expect(text).toContain("C0BOUND01");
      expect(text).not.toContain("channel ID");
      expect(text).not.toContain("{channelName}");
    }
  });
});
