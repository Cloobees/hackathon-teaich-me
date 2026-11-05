---
title: Connect Claude to Context Builder
roles: all
item: I2
action: |
  1. In Claude: *Settings* > *Connectors*, find *Context Builder* in the list and click *Connect*. Sign in with your Synechron account. It is a standard connector, so you add no URL.
  2. New chat, switch it on, and ask your Claude:
     ```
     Using your Context Builder connector, save a markdown file named onboarding-test.md in my personal USER scope with the content "Onboarding test". Save it as a file, not a node, and do not ask me anything.
     ```
  3. Same chat, ask your Claude:
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
<!-- trust-marker: yellow - 2026-11-05 - claude-session - proposed content, awaiting author approval. Context Builder is a standard connector (architect, 2026-11-05), so no custom connector or URL. -->
<!-- [TO CONFIRM: exact menu names for connecting a standard connector] -->
Connect Claude to Context Builder in three steps. Connect the standard Context Builder connector in Claude (Settings, then Connectors, then Connect). Sign in with your Synechron account. Ask Claude to save a small markdown file in your personal space, so there is activity to see. Then ask your own Claude to report your Context Builder account to me in your channel. I tick the step when the report shows activity since you started. If I do not, click I did it and confirm. The exact prompt and the channel name are in the step message I send you.
