---
title: Connect Claude to Context Builder
roles: all
item: I2
action: |
  1. In Claude, open *Settings*, then *Connectors*, and choose *Add custom connector*.
  2. Name it *Context Builder*, use the URL `https://contextbuilder.synechron.com/mcp/v1`, and sign in with your Synechron account.
  3. Open a new chat, switch the Context Builder connector on, and ask: _"In Context Builder, create a note titled Onboarding test in my personal workspace."_
  4. In the same chat, give your Claude the prompt below. It reads your Personal Workspace and tells me what it found, in {channelName}.
     ```
     Using your Context Builder connector, list my scopes and find my Personal Workspace, the scope that belongs to me alone. Read its slug and the UTC time of its latest activity (use null if there is none). Fill them into this block:
     COPILOT-REPORT v1
     item: I2
     scope_slug: <slug of my Personal Workspace>
     last_knowledge_activity: <UTC time of the latest activity>
     Then, using your Slack connector, post the block unchanged to {channelName}. Post only the block.
     ```
check: I will tick this step when I read that report in your channel and it shows activity in your Personal Workspace since you started. If I do not, click I did it and confirm.
---
<!-- trust-marker: yellow - 2026-11-03 - claude-session-2026-11-03 - proposed content, awaiting author approval. The URL is the one in the workspace .mcp.json. -->
<!-- [TO CONFIRM: exact menu names for adding a custom connector] -->
Connect Claude to Context Builder in four steps. Add Context Builder as a custom connector in Claude (Settings, then Connectors, then Add custom connector). Sign in with your Synechron account. Ask Claude to create a note in your personal workspace, so there is activity to see. Then ask your own Claude to report your Personal Workspace to me in your channel. I tick the step when the report shows activity since you started. If I do not, click I did it and confirm. The exact prompt and the channel name are in the step message I send you.
