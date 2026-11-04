---
title: Add a skill to the Project and use it
roles: all
item: I4
action: |
  1. Find the file `copilot-check.zip` in this chat. I sent it to you. Save it to your computer. Do not unzip it.
  2. In Claude, open *Customize*, then *Skills*. Click the *+* button, then *+ Create skill*, then *Upload a skill*, and choose `copilot-check.zip`. Switch the skill on.
  3. Open a chat inside your Project and give your Claude the prompt below. It runs the skill and tells me the result, in {channelName}.
     ```
     Run the copilot-check skill in this Project. If it fails, tell me what failed and post nothing. If it passes, using your Slack connector, post this block unchanged to {channelName} and nothing else:
     COPILOT-REPORT v1
     item: I4
     skill: copilot-check
     ```
  If the upload fails, check that code execution is on: *Settings*, then *Capabilities*, then *Code execution and file creation*. The skill folder name must match the skill name, `copilot-check`. Menu path checked on 2026-11-02.
check: I will tick this step, and the Project step, when I read that report in your channel. If I do not, or I could not send the file, click I did it and confirm.
---
<!-- trust-marker: yellow - 2026-11-03 - claude-session-2026-11-03 - proposed content, awaiting author approval -->
A skill is a folder with a `SKILL.md` file that tells Claude how to do one job. You add the `copilot-check` skill to your Claude and run it once.

1. Find the file `copilot-check.zip` in your chat with me. I sent it to you. Save it to your computer. Do not unzip it.
2. In Claude, open *Customize*, then *Skills*. Click the *+* button, then *+ Create skill*, then *Upload a skill*, and choose `copilot-check.zip`. Switch the skill on.
3. Open a chat inside your Project and ask your own Claude to run the copilot-check skill and post its report to your channel. The exact prompt and the channel name are in the step message I send you.

If the upload fails, check that code execution is on: *Settings*, then *Capabilities*, then *Code execution and file creation*. The skill folder name must match the skill name, `copilot-check`. If it still fails, or I could not send the file, use *I did it*.

Menu path checked on 2026-11-02 (Claude help centre, "Using Skills in Claude").
