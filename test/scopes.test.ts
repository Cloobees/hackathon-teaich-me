import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { missingScopes, REQUIRED_SCOPES } from "../src/scopes.js";

describe("missingScopes", () => {
  it("lists what is absent, and nothing when Slack sent no scope list", () => {
    expect(missingScopes(["chat:write", "groups:write"])).toEqual(["canvases:write", "pins:write", "bookmarks:write"]);
    expect(missingScopes(undefined)).toEqual([]);
    expect(missingScopes([...REQUIRED_SCOPES])).toEqual([]);
  });
  it("every required scope is in manifest.yml", () => {
    const manifest = parse(readFileSync(fileURLToPath(new URL("../manifest.yml", import.meta.url)), "utf8")) as { oauth_config: { scopes: { bot: string[] } } };
    expect(manifest.oauth_config.scopes.bot).toEqual(expect.arrayContaining([...REQUIRED_SCOPES]));
  });
});
