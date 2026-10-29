import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanForSecrets } from "../src/secretScan.js";

// Built at run time so this file holds no token-shaped literal for check:secrets.
const FAKE_TOKEN = "xox" + "b-123456789012-abcdefghijkl";

describe("scanForSecrets", () => {
  it("finds a planted xoxb- token", () => {
    const dir = mkdtempSync(join(tmpdir(), "secrets-"));
    writeFileSync(join(dir, "notes.txt"), `token ${FAKE_TOKEN}`);
    expect(scanForSecrets([dir])).toEqual([{ file: join(dir, "notes.txt"), pattern: "slack-bot-token" }]);
  });
  it("passes a folder with no secret and skips .env", () => {
    const dir = mkdtempSync(join(tmpdir(), "secrets-"));
    writeFileSync(join(dir, "readme.md"), "SLACK_BOT_TOKEN=");
    writeFileSync(join(dir, ".env"), `SLACK_BOT_TOKEN=${FAKE_TOKEN}`);
    expect(scanForSecrets([dir])).toEqual([]);
  });
  it("ignores a path that does not exist", () => {
    expect(scanForSecrets(["/no/such/dir"])).toEqual([]);
  });
});
