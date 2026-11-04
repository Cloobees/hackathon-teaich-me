import { describe, expect, it } from "vitest";
import { loadCopilotConfig } from "../src/config.js";

const full = { SLACK_BOT_TOKEN: "t1", SLACK_APP_TOKEN: "t2", OPERATOR_USER_IDS: "U1, U2" };

describe("loadCopilotConfig", () => {
  it("throws `missing <NAME>` for each required variable removed in turn", () => {
    for (const name of Object.keys(full)) {
      const env = { ...full, [name]: undefined } as NodeJS.ProcessEnv;
      expect(() => loadCopilotConfig(env)).toThrow(`missing ${name}`);
    }
  });
  it("splits operator ids on commas, semicolons or spaces", () => {
    expect(loadCopilotConfig({ ...full, OPERATOR_USER_IDS: "U1;U2; U3 ,U4" }).operatorIds).toEqual(["U1", "U2", "U3", "U4"]);
  });
  it("splits the operator list and applies defaults", () => {
    const config = loadCopilotConfig(full);
    expect(config.operatorIds).toEqual(["U1", "U2"]);
    expect(config.dbPath).toBe("state/copilot.db");
    expect(config.glossaryUrl).toBeUndefined();
    expect(config.botMention).toBe("Onboarding Copilot");
  });
  it("reads BOT_MENTION", () => {
    expect(loadCopilotConfig({ ...full, BOT_MENTION: "Copilot Dev" }).botMention).toBe("Copilot Dev");
  });
});

describe("HARNESS_REPO", () => {
  it("is optional, with no default, and is read trimmed when set", () => {
    expect(loadCopilotConfig(full).harnessRepo).toBeUndefined();
    expect(loadCopilotConfig({ ...full, HARNESS_REPO: "" }).harnessRepo).toBeUndefined();
    expect(loadCopilotConfig({ ...full, HARNESS_REPO: " synechron/harness " }).harnessRepo).toBe("synechron/harness");
  });
});
