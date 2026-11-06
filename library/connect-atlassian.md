---
title: Connect Atlassian
roles: technical
item: I5
action: |
  1. In Claude: *Settings* > *Connectors* > *Atlassian* > *Connect*. Sign in and approve the site.
  2. In a chat with Atlassian on, ask your Claude:
     ```
     Using your Atlassian connector, list the Atlassian sites I can reach and count them. Fill in this block:
     COPILOT-REPORT v1
     item: I5
     site_count: <number of sites>
     Then, using your Slack connector, post the block unchanged to {channelName}. Post only the block.
     ```
check: I tick this when the report shows at least one site.
---
<!-- trust-marker: yellow - 2026-11-03 - claude-session-2026-11-03 - proposed content, awaiting author approval -->
<!-- [TO CONFIRM: exact menu names and the test site, OQ-VF-004] -->
Connect Atlassian in two steps. In Claude, connect the Atlassian connector (Settings, then Connectors), sign in and approve access to the Atlassian site. Then ask your own Claude to count the Atlassian sites it can reach and tell me in your channel. I tick the step when the report shows at least one site. If it shows none, authorise the connector and ask again. The exact prompt and the channel name are in the step message I send you.
