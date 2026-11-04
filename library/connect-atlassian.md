---
title: Connect Atlassian
roles: technical
item: I6
action: |
  1. In Claude, open *Settings*, then *Connectors*, and choose *Atlassian*. Click *Connect* and sign in. Approve access to the Atlassian site when asked.
  2. In a chat with the Atlassian connector switched on, give your Claude the prompt below. It counts the Atlassian sites it can reach and tells me, in {channelName}.
     ```
     Using your Atlassian connector, list the Atlassian sites I can reach and count them. Fill the count into this block:
     COPILOT-REPORT v1
     item: I6
     site_count: <number of sites>
     Then, using your Slack connector, post the block unchanged to {channelName}. Post only the block.
     ```
check: I will tick this step when I read that report in your channel and it shows at least one site. If it shows none, authorise the connector and ask again.
---
<!-- trust-marker: yellow - 2026-11-03 - claude-session-2026-11-03 - proposed content, awaiting author approval -->
<!-- [TO CONFIRM: exact menu names and the test site, OQ-VF-004] -->
Connect Atlassian in two steps. In Claude, connect the Atlassian connector (Settings, then Connectors), sign in and approve access to the Atlassian site. Then ask your own Claude to count the Atlassian sites it can reach and tell me in your channel. I tick the step when the report shows at least one site. If it shows none, authorise the connector and ask again. The exact prompt and the channel name are in the step message I send you.
