---
title: Connect Claude to Context Builder
roles: all
item: I2
action: |
  1. In Claude: *Settings* > *Connectors* > *Add custom connector*.
  2. Name: *Context Builder*. URL: `https://contextbuilder.synechron.com/mcp/v1`. Sign in with your Synechron account.
  3. New chat, switch it on, and ask your Claude:
     ```
     Using your Context Builder connector, save a markdown file named onboarding-test.md in my personal USER scope with the content "Onboarding test". Save it as a file, not a node, and do not ask me anything.
     ```
  4. Same chat, ask your Claude:
     ```
     Using your Context Builder connector, list my scopes. In my USER scope (scopeType USER, the one that is mine alone), read its email and the latest of its lastActivityAt times (knowledge, schemas, files) as a UTC time (null if all are null). Fill in this block:
     COPILOT-REPORT v1
     item: I2
     email: <email of my USER scope>
     last_activity: <UTC time of the latest activity>
     Then, using your Slack connector, post the block unchanged to {channelName}. Post only the block.
     ```
check: I tick this when your report shows activity since you started.
---
<!-- trust-marker: yellow - 2026-11-03 - claude-session-2026-11-03 - proposed content, awaiting author approval. The URL is the one in the workspace .mcp.json. -->
<!-- [TO CONFIRM: exact menu names for adding a custom connector] -->
Connect Claude to Context Builder in four steps. Add Context Builder as a custom connector in Claude (Settings, then Connectors, then Add custom connector). Sign in with your Synechron account. Ask Claude to save a small markdown file in your personal space, so there is activity to see. Then ask your own Claude to report your Context Builder account to me in your channel. I tick the step when the report shows activity since you started. If I do not, click I did it and confirm. The exact prompt and the channel name are in the step message I send you.
