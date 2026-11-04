import { describe, expect, it } from "vitest";
import { checkWrite, writeGuard } from "./writeGuard.js";

describe("checkWrite", () => {
  it("allows the personal scope under onboarding/", () => {
    expect(checkWrite({ scopeType: "USER", path: "onboarding/hello.txt", content: "x" })).toBeUndefined();
  });
  it("denies shared scopes", () => {
    for (const scopeType of ["WORKSPACE", "PROJECT", "GLOBAL", undefined]) {
      expect(checkWrite({ scopeType, path: "onboarding/hello.txt" })).toMatch(/personal workspace/);
    }
  });
  it("denies paths outside onboarding/ or with ..", () => {
    expect(checkWrite({ scopeType: "USER", path: "notes/hello.txt" })).toMatch(/onboarding\//);
    expect(checkWrite({ scopeType: "USER", path: "onboarding/../secrets.txt" })).toMatch(/onboarding\//);
    expect(checkWrite({ scopeType: "USER" })).toMatch(/onboarding\//);
  });
});

describe("writeGuard hook", () => {
  const call = (tool_input: unknown) =>
    writeGuard({ hook_event_name: "PreToolUse", tool_name: "mcp__context-builder__write_file", tool_input } as never, "t", {
      signal: new AbortController().signal,
    });
  it("returns {} when allowed and a deny decision otherwise", async () => {
    expect(await call({ scopeType: "USER", path: "onboarding/a.txt" })).toEqual({});
    expect(await call({ scopeType: "WORKSPACE", path: "onboarding/a.txt" })).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
  });
});
