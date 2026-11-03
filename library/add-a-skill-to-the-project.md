---
title: Add a skill to the Project and use it
roles: all
item: I4
---
<!-- trust-marker: yellow - 2026-10-23 - claude-session-2026-10-23 - drafted by Claude per DD-VF-007, needs a technical member to review the wording -->
A skill is a folder with a `SKILL.md` file that tells Claude how to do one job. You add the `copilot-check` skill and run it once.

1. Find the file `copilot-check.zip` in this chat. I sent it to you. Save it to your computer. Do not unzip it.
2. In Claude, open *Customize*, then *Skills*. Click the *+* button, then *+ Create skill*, then *Upload a skill*, and choose `copilot-check.zip`. Switch the skill on.
3. Open a chat inside your Project and tell Claude: _"Run the copilot-check skill with the one-time code the copilot gave me."_
4. Claude prints a short report. I read it for you through your own Claude, so you do not need to send it anywhere.

If the upload fails, check that code execution is on: *Settings*, then *Capabilities*, then *Code execution and file creation*. The skill folder name must match the skill name, `copilot-check`. If it still fails, or I could not send the file, use *I did it*.

Menu path checked on 2026-11-02 (Claude help centre, "Using Skills in Claude").
