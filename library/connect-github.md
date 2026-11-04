---
title: Connect GitHub
roles: technical
item: I5
action: |
  1. In Claude: *Settings* > *Connectors* > *GitHub* > *Connect*. Give it the harness repo.
  2. In a chat with GitHub on, ask your Claude:
     ```
     Using your GitHub connector, list the files in the root of the harness repository I use for onboarding. If you can read them, fill in this block:
     COPILOT-REPORT v1
     item: I5
     repo: <owner/name of the repository>
     Then, using your Slack connector, post the block unchanged to {channelName}. Post only the block. If you cannot read it, say why and post nothing.
     ```
check: I tick this on that report.
---
<!-- trust-marker: yellow - 2026-11-03 - claude-session-2026-11-03 - proposed content, awaiting author approval -->
<!-- [TO CONFIRM: exact menu names, and whether the practice uses the GitHub connector or Claude Code] -->
<!-- [TO CONFIRM: harness repository name and URL (OQ-VF-015); the step does not name it yet] -->
<!-- [TO CONFIRM: whether Claude can report a repository through its GitHub connector (SP-5); if not, this step is self-attested with I did it] -->
Connect GitHub in three steps. In Claude, connect the GitHub connector (Settings, then Connectors) and authorise your account. Give it access to the harness repository. Then ask your own Claude to list the files in the repository and tell me in your channel. I tick the step when I read that report. If I do not, click I did it and confirm. The exact prompt and the channel name are in the step message I send you.
