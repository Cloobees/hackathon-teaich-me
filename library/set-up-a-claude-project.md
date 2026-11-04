---
title: Set up a Claude Project
roles: all
item: I3
action: |
  1. In Claude, open *Projects* and click *New project*.
  2. Name it *Onboarding sandbox* and add one line of instructions, for example: _"Answer briefly and ask me one question at a time."_
  3. Start a chat inside the Project and give your Claude the prompt below. It tells me which Project you are working in, in {channelName}.
     ```
     Find the name of the Claude Project this chat is in and fill it into this block:
     COPILOT-REPORT v1
     item: I3
     project_name: <name of this Project>
     Then, using your Slack connector, post the block unchanged to {channelName}. Post only the block.
     ```
check: I will tick this step when I read that report in your channel. I also tick it when you finish the next step. If I do not, click I did it and confirm.
---
<!-- trust-marker: yellow - 2026-11-03 - claude-session-2026-11-03 - proposed content, awaiting author approval -->
<!-- [TO CONFIRM: exact menu names for creating a Project] -->
<!-- [TO CONFIRM: whether Claude can read the name of the Project it is in (SP-5); if not, this step is self-attested with I did it] -->
Set up a Claude Project in three steps. Open Projects in Claude and create a new Project. Name it Onboarding sandbox and add one line of instructions. Then start a chat inside the Project and ask your own Claude to tell me the Project's name in your channel. I tick the step when I read that report. If you finish the next step (adding the skill), I tick this one too. If I do not, click I did it and confirm. The exact prompt and the channel name are in the step message I send you.
