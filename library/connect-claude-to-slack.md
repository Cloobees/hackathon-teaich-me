---
title: Connect Claude to Slack
roles: all
item: I1
action: |
  1. In Claude, open *Settings*, then *Connectors*, and choose *Slack*. Click *Connect* and allow access to the workspace.
  2. Once connected, give your Claude (from your own Claude instance) the prompt below. It creates a channel for you and the Onboarding Copilot, which the copilot uses to see the steps you finish.
     ```
     Using your Slack connector, create a private Slack channel named {channelName}. If a channel with that name already exists, use it.
     ```
  3. In that channel in Slack, send this message: /invite {botMention}
  4. Once the Onboarding Copilot has confirmed it is in the channel, tell your Claude to send a welcome message to {channelName}.
check: I will tick this step when I see the message from Claude. If I do not, click I did it and confirm.
---
<!-- trust-marker: yellow - 2026-11-03 - claude-session-2026-11-03 - proposed content, awaiting author approval -->
<!-- [TO CONFIRM: exact menu names in the practice's Claude plan] -->
<!-- [TO CONFIRM: whether /invite finds the app by its display name when the name has a space (SP-4)] -->
Connect Claude to Slack so that I can see the steps you finish. There are four steps. First connect the Slack connector in Claude (Settings, then Connectors). Then ask your own Claude to create a private channel for you and me. Then invite me to that channel with the /invite command. Last, once I have said I am in the channel, ask your Claude to send a welcome message there. I tick the step when I see that message. If I do not, click I did it and confirm. The exact prompt and the channel name are in the step message I send you.
