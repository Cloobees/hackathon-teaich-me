---
title: Add a skill to the Project and use it
roles: all
item: I4
---
<!-- trust-marker: yellow - 2026-10-23 - claude-session-2026-10-23 - drafted by Claude per DD-VF-007, needs a technical member to review the wording -->
A skill is a folder with a `SKILL.md` file that tells Claude how to do one job. You add the `copilot-check` skill and run it once.

1. Get the `copilot-check` folder. [TO CONFIRM: where members download it, for example the `skills/copilot-check` folder of the TeAIch Me repository]
2. In Claude, open *Settings*, then *Capabilities*, then *Skills*, and upload the folder, then make it available to your Project. [TO CONFIRM: exact menu names and how a skill is attached to a Project]
3. Click *Get report prompt* under this step. It gives you a one-time code.
4. In a chat inside your Project, tell Claude: _"Run the copilot-check skill with this code."_ and give the code.
5. Paste the block Claude prints (it starts with `COPILOT-REPORT v1`) back here, unchanged.

A valid block ticks this step and the Project step. Each code works once; click *Get report prompt* again for a new one.
