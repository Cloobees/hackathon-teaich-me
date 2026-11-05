import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface Manifest {
  display_information: { name: string };
  features: { bot_user: { display_name: string }; slash_commands: { command: string }[] };
  oauth_config: { scopes: { bot: string[] } };
  settings: { event_subscriptions: { bot_events: string[] }; interactivity: { is_enabled: boolean }; socket_mode_enabled: boolean };
}

const manifest = parse(readFileSync(fileURLToPath(new URL("../manifest.yml", import.meta.url)), "utf8")) as Manifest;

/** The 16 bot scopes and 7 bot events of the original app's manifest (Manifest delta, baseline). */
const ORIGINAL_SCOPES = [
  "chat:write", "im:write", "im:history", "im:read", "users:read", "users:read.email", "commands", "channels:read",
  "channels:history", "channels:join", "groups:read", "groups:history", "app_mentions:read", "canvases:write", "pins:write", "files:write",
];
const ORIGINAL_EVENTS = ["team_join", "message.im", "message.channels", "message.groups", "member_joined_channel", "app_mention", "app_home_opened"];

describe("manifest.yml carries the channel variant delta (Scenario 29)", () => {
  const scopes = manifest.oauth_config.scopes.bot;
  const events = manifest.settings.event_subscriptions.bot_events;

  it("adds the scopes groups:write and canvases:read and keeps all 16 original scopes", () => {
    expect(ORIGINAL_SCOPES).toHaveLength(16);
    expect(scopes).toEqual(expect.arrayContaining(["groups:write", "canvases:read", ...ORIGINAL_SCOPES]));
  });
  it("adds no scope the variant does not use", () => {
    expect(scopes).not.toContain("bookmarks:write");
    expect(scopes).not.toContain("files:read");
    expect(scopes).not.toContain("pins:read");
    expect([...scopes].sort()).toEqual([...ORIGINAL_SCOPES, "groups:write", "canvases:read"].sort());
  });
  it("adds the event member_left_channel and keeps the 7 original events", () => {
    expect(ORIGINAL_EVENTS).toHaveLength(7);
    expect(events).toEqual(expect.arrayContaining(["member_left_channel", ...ORIGINAL_EVENTS]));
    expect([...events].sort()).toEqual([...ORIGINAL_EVENTS, "member_left_channel"].sort());
  });
  it("has the slash command /onboard-ch and no /onboard", () => {
    expect(manifest.features.slash_commands.map((c) => c.command)).toEqual(["/onboard-ch"]);
  });
  it("names the app and the bot so both apps can share a workspace", () => {
    expect(manifest.display_information.name).toBe("Onboarding Copilot Channel");
    expect(manifest.features.bot_user.display_name).toBe("onboarding-copilot-channel");
  });
  it("keeps socket mode and interactivity on", () => {
    expect(manifest.settings.socket_mode_enabled).toBe(true);
    expect(manifest.settings.interactivity.is_enabled).toBe(true);
  });
});
