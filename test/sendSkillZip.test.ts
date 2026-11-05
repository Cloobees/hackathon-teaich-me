import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sendSkillZip } from "../src/sendSkillZip.js";
import { makeDeps, onboard, slackError } from "./helpers.js";

const realZip = fileURLToPath(new URL("../library-files/copilot-check.zip", import.meta.url));

/** Reads one entry's text out of a zip by walking its local file headers. Handles stored and deflated entries. */
function zipEntryText(zip: Buffer, name: string): string | undefined {
  for (let at = 0; at + 30 <= zip.length && zip.readUInt32LE(at) === 0x04034b50; ) {
    const method = zip.readUInt16LE(at + 8);
    const size = zip.readUInt32LE(at + 18);
    const nameLength = zip.readUInt16LE(at + 26);
    const extraLength = zip.readUInt16LE(at + 28);
    const start = at + 30 + nameLength + extraLength;
    const data = zip.subarray(start, start + size);
    if (zip.toString("utf8", at + 30, at + 30 + nameLength) === name) return (method === 0 ? data : inflateRawSync(data)).toString("utf8");
    at = start + size;
  }
  return undefined;
}

/** A non-technical member who has chosen a role, so the store holds their channel_id. */
async function setup(overrides: Parameters<typeof makeDeps>[0] = {}) {
  const deps = makeDeps({ skillZipPath: realZip, ...overrides });
  await onboard(deps, "UNT1", "non-technical");
  deps.fake.calls.length = 0;
  deps.logs.length = 0;
  return deps;
}

const channelOf = (deps: Awaited<ReturnType<typeof setup>>, memberId: string) =>
  deps.store.get<{ channel_id: string }>("SELECT channel_id FROM member WHERE member_id = ?", memberId)!.channel_id;

describe("sendSkillZip (BP-049, BP-101)", () => {
  it("uploads the zip into the member's channel as copilot-check.zip and sends no repository link", async () => {
    const deps = await setup();
    const channel = channelOf(deps, "UNT1");
    expect(channel).not.toBe("D-UNT1");
    await sendSkillZip(deps, "UNT1");
    const uploads = deps.fake.of("files.uploadV2");
    expect(uploads).toHaveLength(1);
    const args = uploads[0]!.args as { channel_id: string; filename: string; file: Buffer; initial_comment?: string };
    expect(args.channel_id).toBe(channel);
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

  it("the zip's copilot-check/SKILL.md matches skills/copilot-check/SKILL.md and holds no nonce (BP-081)", () => {
    const folderText = readFileSync(fileURLToPath(new URL("../skills/copilot-check/SKILL.md", import.meta.url)), "utf8");
    const zipText = zipEntryText(readFileSync(realZip), "copilot-check/SKILL.md");
    expect(zipText).toBe(folderText);
    expect(zipText).not.toMatch(/nonce/i);
  });

  it("a missing file attaches nothing, posts one fallback in the channel naming I did it, logs skill_zip_missing and does not throw", async () => {
    const deps = await setup({ skillZipPath: "library-files/does-not-exist.zip" });
    await expect(sendSkillZip(deps, "UNT1")).resolves.toBeUndefined();
    expect(deps.fake.of("files.uploadV2")).toHaveLength(0);
    const posts = deps.fake.of("chat.postMessage");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.args).toMatchObject({ channel: channelOf(deps, "UNT1") });
    expect((posts[0]!.args as { text: string }).text).toMatch(/help channel/);
    expect((posts[0]!.args as { text: string }).text).toContain("I did it");
    expect(deps.logs.some((l) => l.includes('"event":"skill_zip_missing"'))).toBe(true);
  });

  it("an unset path is treated as missing", async () => {
    const deps = await setup({ skillZipPath: undefined });
    await sendSkillZip(deps, "UNT1");
    expect(deps.fake.of("files.uploadV2")).toHaveLength(0);
    expect(deps.fake.of("chat.postMessage")).toHaveLength(1);
    expect(deps.logs.some((l) => l.includes("skill_zip_missing"))).toBe(true);
  });

  it("a failing upload posts exactly one fallback in the channel, logs skill_zip_missing and does not throw", async () => {
    const deps = await setup();
    deps.fake.failUpload = true;
    await expect(sendSkillZip(deps, "UNT1")).resolves.toBeUndefined();
    expect(deps.fake.of("files.uploadV2")).toHaveLength(1);
    const posts = deps.fake.of("chat.postMessage");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.args).toMatchObject({ channel: channelOf(deps, "UNT1") });
    expect((posts[0]!.args as { text: string }).text).toMatch(/help channel/);
    expect(deps.logs.some((l) => l.includes("skill_zip_missing"))).toBe(true);
  });

  it("a gone channel on upload marks the channel lost, posts nothing and does not throw", async () => {
    const deps = await setup();
    const channel = channelOf(deps, "UNT1");
    deps.slack.files.uploadV2 = async () => {
      throw slackError("channel_not_found");
    };
    deps.slack.chat.postMessage = async () => {
      throw slackError("channel_not_found");
    };
    await expect(sendSkillZip(deps, "UNT1")).resolves.toBeUndefined();
    expect(deps.store.get<{ channel_state: string }>("SELECT channel_state FROM member WHERE member_id = ?", "UNT1")?.channel_state).toBe("lost");
    expect(deps.logs.some((l) => l.includes('"event":"channel_lost"') && l.includes(channel))).toBe(true);
  });

  it("a member with no channel on record logs skill_zip_no_channel and sends nothing", async () => {
    const deps = await setup();
    await sendSkillZip(deps, "UNKNOWN");
    expect(deps.fake.calls).toHaveLength(0);
    expect(deps.logs.some((l) => l.includes('"event":"skill_zip_no_channel"'))).toBe(true);
  });
});
