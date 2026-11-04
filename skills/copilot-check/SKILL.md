---
name: copilot-check
description: Checks that Claude can reach the member's Context Builder Personal Workspace from the Claude Project, then posts the COPILOT-REPORT block the Onboarding Copilot reads in the "add a skill to the Project" step. Use when the user asks to run copilot-check.
---
<!-- trust-marker: yellow - 2026-11-03 - claude-session-2026-11-03 - simplified per D15, BP-081: no code to take; needs a technical member to review the wording -->
# copilot-check

The Onboarding Copilot asks a member to run this skill in their Claude Project. The skill checks Context Builder access through the member's Personal Workspace and posts one short report to the member's Slack channel. The member gives no code.

## Steps

1. Check Context Builder access through the member's Personal Workspace: list the scopes with the Context Builder connector and confirm the member's personal scope is there. Run this in the member's Claude Project.
2. If the check fails, tell the member what failed and stop. Do not post anything.
3. If the check passes, post exactly these three lines, with nothing else, to the Slack channel the member names. Do not add commentary, a code fence, or any other line, and do not change the lines.

```
COPILOT-REPORT v1
item: I4
skill: copilot-check
```

4. Do not ask the member for a code. If the member has not named a Slack channel, ask which channel and stop.

## Example

User: "Run the copilot-check skill and post the report to onboarding-copilot-ada-lovelace"

Post to that channel:

COPILOT-REPORT v1
item: I4
skill: copilot-check
