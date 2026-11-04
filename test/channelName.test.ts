import { describe, expect, it } from "vitest";
import { channelName } from "../src/channelName.js";

describe("channelName (FR-VF-018, Scenario 13)", () => {
  it("lower-cases a name and turns spaces into single hyphens", () => {
    expect(channelName("Harry Fox  Holroyd", "U1")).toBe("onboarding-copilot-harry-fox-holroyd");
  });
  it("strips accents (the Scenario 13 worked example)", () => {
    expect(channelName("José Núñez-Smith", "U0ABC123")).toBe("onboarding-copilot-jose-nunez-smith");
  });
  it("turns an apostrophe and a run of punctuation into one hyphen", () => {
    expect(channelName("Siobhan O'Neill", "U1")).toBe("onboarding-copilot-siobhan-o-neill");
    expect(channelName("a . , ! b", "U1")).toBe("onboarding-copilot-a-b");
  });
  it("trims leading and trailing punctuation", () => {
    expect(channelName("  --Ann--  ", "U1")).toBe("onboarding-copilot-ann");
  });
  it("lower-cases mixed case and keeps digits", () => {
    expect(channelName("aLiCe B2", "U1")).toBe("onboarding-copilot-alice-b2");
  });
  it("truncates a long name in the slug, not the prefix, and does not end in a hyphen", () => {
    const name = channelName("x".repeat(100), "U1");
    expect(name).toHaveLength(80);
    expect(name.startsWith("onboarding-copilot-")).toBe(true);
    const cut = channelName(`${"a".repeat(60)} ${"b".repeat(40)}`, "U1"); // the hyphen lands on the cut
    expect(cut.length).toBeLessThanOrEqual(80);
    expect(cut.endsWith("-")).toBe(false);
    expect(cut).toBe(`onboarding-copilot-${"a".repeat(60)}`);
  });
  it("falls back to the lower-cased user id for an empty, missing or all-symbol name", () => {
    expect(channelName("", "U0ABC123")).toBe("onboarding-copilot-u0abc123");
    expect(channelName(undefined, "U0ABC123")).toBe("onboarding-copilot-u0abc123");
    expect(channelName("!!! 🙂", "U0ABC123")).toBe("onboarding-copilot-u0abc123");
  });
});
