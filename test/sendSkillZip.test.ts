import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sendSkillZip } from "../src/sendSkillZip.js";
import { makeDeps, onboard } from "./helpers.js";

const realZip = fileURLToPath(new URL("../library-files/copilot-check.zip", import.meta.url));

/** A non-technical member who has chosen a role, so the store holds their dm_channel_id. */
async function setup(overrides: Parameters<typeof makeDeps>[0] = {}) {
  const deps = makeDeps({ skillZipPath: realZip, ...overrides });
  await onboard(deps, "UNT1", "non-technical");
  deps.fake.calls.length = 0;
  deps.logs.length = 0;
  return deps;
}

describe("sendSkillZip (BP-049)", () => {
  it("attaches the zip to the member's DM as copilot-check.zip and sends no repository link", async () => {
    const deps = await setup();
    await sendSkillZip(deps, "UNT1");
    const uploads = deps.fake.of("files.uploadV2");
    expect(uploads).toHaveLength(1);
    const args = uploads[0]!.args as { channel_id: string; filename: string; file: Buffer; initial_comment?: string };
    expect(args.channel_id).toBe("D-UNT1");
    expect(args.filename).toBe("copilot-check.zip");
    expect(Buffer.compare(args.file, readFileSync(realZip))).toBe(0);
    expect(args.initial_comment ?? "").not.toMatch(/github\.com|repository/i);
    expect(deps.fake.of("chat.postMessage")).toHaveLength(0);
  });

  it("the real zip holds the entry copilot-check/SKILL.md with a forward slash", () => {
    const bytes = readFileSync(realZip).toString("latin1");
    expect(bytes.startsWith("PK")).toBe(true);
    expect(bytes).toContain("copilot-check/SKILL.md");
    expect(bytes).not.toContain("copilot-check\SKILL.md");
  });

  it("a missing file attaches nothing, sends one DM naming I did it, logs skill_zip_missing and does not throw", async () => {
    const deps = await setup({ skillZipPath: "library-files/does-not-exist.zip" });
    await expect(sendSkillZip(deps, "UNT1")).resolves.toBeUndefined();
    expect(deps.fake.of("files.uploadV2")).toHaveLength(0);
    const dms = deps.fake.of("chat.postMessage");
    expect(dms).toHaveLength(1);
    expect(dms[0]!.args).toMatchObject({ channel: "D-UNT1" });
    expect((dms[0]!.args as { text: string }).text).toContain("I did it");
    expect(deps.logs.some((l) => l.includes('"event":"skill_zip_missing"'))).toBe(true);
  });

  it("an unset path is treated as missing", async () => {
    const deps = await setup({ skillZipPath: undefined });
    await sendSkillZip(deps, "UNT1");
    expect(deps.fake.of("files.uploadV2")).toHaveLength(0);
    expect(deps.fake.of("chat.postMessage")).toHaveLength(1);
    expect(deps.logs.some((l) => l.includes("skill_zip_missing"))).toBe(true);
  });

  it("a failing upload sends one DM naming I did it, logs skill_zip_missing and does not throw", async () => {
    const deps = await setup();
    deps.fake.failUpload = true;
    await expect(sendSkillZip(deps, "UNT1")).resolves.toBeUndefined();
    expect(deps.fake.of("files.uploadV2")).toHaveLength(1);
    const dms = deps.fake.of("chat.postMessage");
    expect(dms).toHaveLength(1);
    expect((dms[0]!.args as { text: string }).text).toContain("I did it");
    expect(deps.logs.some((l) => l.includes("skill_zip_missing"))).toBe(true);
  });

  it("does nothing for a member with no DM on record", async () => {
    const deps = await setup();
    await sendSkillZip(deps, "UNKNOWN");
    expect(deps.fake.calls).toHaveLength(0);
  });
});
