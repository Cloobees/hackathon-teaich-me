---
title: Connect Claude to Slack
roles: all
item: I1
action: |
  1. In Claude: *Settings* > *Connectors* > *Slack* > *Connect*.
  2. Ask your Claude:
     ```
     Using your Slack connector, create a private Slack channel named {channelName}. If it exists, use it.
     ```
  3. In that channel, send:
     ```
     /invite {botMention}
     ```
     No match? Channel name > *Integrations* > *Add apps*.
  4. When I confirm I am in, ask your Claude to send a welcome message to {channelName}.
check: I tick this when I see Claude's message.
---
<!-- trust-marker: yellow - 2026-11-03 - claude-session-2026-11-03 - proposed content, awaiting author approval -->
<!-- [TO CONFIRM: exact menu names in the practice's Claude plan] -->
<!-- [TO CONFIRM: whether /invite finds the app by its display name when the name has a space (SP-4)] -->
Connect Claude to Slack so that I can see the steps you finish. There are four steps. First connect the Slack connector in Claude (Settings, then Connectors). Then ask your own Claude to create a private channel for you and me. Then invite me to that channel with the /invite command. Last, once I have said I am in the channel, ask your Claude to send a welcome message there. I tick the step when I see that message. If I do not, click I did it and confirm. The exact prompt and the channel name are in the step message I send you.
