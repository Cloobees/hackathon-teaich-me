import type { HookCallback, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";

export const ALLOWED_WRITE_PREFIX = "onboarding/";

/** Returns a denial reason, or undefined when the write_file call is allowed. */
export function checkWrite(toolInput: unknown): string | undefined {
  const { scopeType, path } = (toolInput ?? {}) as { scopeType?: unknown; path?: unknown };
  if (scopeType !== "USER") {
    return `Writes are only allowed in the user's personal workspace (scopeType USER), not "${String(scopeType)}".`;
  }
  if (typeof path !== "string" || !path.startsWith(ALLOWED_WRITE_PREFIX) || path.includes("..")) {
    return `Writes are only allowed under "${ALLOWED_WRITE_PREFIX}", not "${String(path)}".`;
  }
  return undefined;
}

/** PreToolUse hook for Context Builder write_file: deny anything outside the personal onboarding folder. */
export const writeGuard: HookCallback = async (input) => {
  if (input.hook_event_name !== "PreToolUse") return {};
  const reason = checkWrite((input as PreToolUseHookInput).tool_input);
  if (!reason) return {};
  console.warn(`[write-guard] denied write_file: ${reason}`);
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
};
