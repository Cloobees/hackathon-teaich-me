import { describe, expect, it } from "vitest";
import { formatLine } from "../src/log.js";

describe("formatLine", () => {
  it("writes one line with the member id and the outcome", () => {
    const line = formatLine("tick", { member: "U123", outcome: "ticked" }, new Date("2026-10-26T10:00:00Z"));
    expect(line.split("\n")).toHaveLength(1);
    expect(JSON.parse(line)).toMatchObject({ event: "tick", member: "U123", outcome: "ticked" });
  });
  it("never prints a token value", () => {
    // Built at run time so this file holds no token-shaped literal for check:secrets.
    const fake = ["xox" + "b-1234567890-abcdef", "xap" + "p-1-A0B1C2-xyz", "ey" + "JhbGciOiJIUzI1NiJ9"].join(" ");
    const line = formatLine("start_up", { note: fake });
    expect(line).not.toMatch(/xoxb-1234|xapp-1-A0|eyJhbGci/);
    expect(line).toContain("[redacted]");
  });
});
