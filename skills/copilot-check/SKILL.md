---
name: copilot-check
description: Prints the COPILOT-REPORT block the Toolchain Copilot asks for in the "add a skill" onboarding step. Use when the user says to run copilot-check with a code.
---
<!-- trust-marker: yellow - 2026-10-23 - claude-session-2026-10-23 - drafted by Claude per DD-VF-007, needs a technical member to review the wording (BP-017) -->
# copilot-check

The Toolchain Copilot gives a member a one-time code. When the member runs this skill with that code, print the block below and nothing else.

## Steps

1. Take the code the user gave you. It is a short string of letters, digits, `-` and `_`. If the user gave no code, ask for it and stop.
2. Print exactly these four lines, with the code in place of `<code>`. Do not add commentary, a code fence, or any other line.

```
COPILOT-REPORT v1
item: I4
nonce: <code>
skill: copilot-check
```

3. Do not change, shorten or reformat the code. Do not invent a code.

## Example

User: "Run the copilot-check skill with the code Qx7-aB_92k"

Reply:

COPILOT-REPORT v1
item: I4
nonce: Qx7-aB_92k
skill: copilot-check
