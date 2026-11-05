# Host runbook

`[yellow]` Drafted 2 November 2026 for the channel variant (FR-EN-012, copied from the original app runbook of BP-063). The architect's machine runs the app, the store and the dashboard. Nothing here has been run; the steps marked MANUAL produce the evidence the plan asks for.

The app replies only while this machine is powered, awake, online and signed in. Every other team machine can be off.

## One-time setup

1. **Sleep off (AC power).** In PowerShell:

   ```powershell
   powercfg /change standby-timeout-ac 0
   powercfg /change hibernate-timeout-ac 0
   powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE
   ```

   The query must show the AC setting index `0x00000000`. Copy that line into `.claude/evidence/channel-host-run/host-run.md`. Keep the lid open or set the lid-close action to Do nothing.
2. **Claude Code login.** The app calls Claude through the signed-in Claude Code session (`CLAUDE_AUTH=claude-code` in `.env`, A-EN-004). Run `claude` once under the Windows account that will run the app and confirm it is signed in. If the login lapses, every answer fails and the app does not warn at start-up (OQ-EN-012).
3. **`.env`.** `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `OPERATOR_USER_IDS` and `CLAUDE_AUTH` are set. Values stay in `.env`, never here.
4. **Seed.** `npm run seed` once, so the dashboard shows the seeded cohort.

## Slack app setup for the variant

The channel variant needs its own Slack app, with its own `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` in `.env`. Do not reuse the tokens of the original app. Create the app from `manifest.yml`. Against the original manifest it adds the bot scopes `groups:write`, `canvases:read` and `bookmarks:write` (the glossary bookmark in each new channel; without it the bookmark is skipped and logged as `bookmark_failed`) and the bot event `member_left_channel`, and its slash command is `/onboard-ch`, so both apps can share one workspace. Reinstall the app after any scope change. The five MANUAL spikes (SP-C1 to SP-C5, evidence in `.claude/evidence/BP-090` to `BP-094`) gate live use: do not run the variant for real members until each has a dated outcome line.

Two settings in the variant's `.env` fail quietly when blank, so copy them from the original app's `.env` (same workspace, same values; this folder's `.env` starts blank):

- `GLOSSARY_CANVAS_URL`: without it the welcome and the checklist show no glossary section or "Open glossary" button.
- `CLAUDE_APP_ID`: without it, and when the `users.list` lookup does not find the Claude app, step 1 (Claude to Slack) cannot tick from the member's Claude post. The app logs a `config_warning` line at start for each of these, and a `message_seen` line for every post that could be Claude's, saying whether it came from the member's own channel, carried an `app_id` or `bot_id`, and mentioned the Claude app (no message text is logged).

## Start and restart

Start by hand: `npm start` from `hackathon-teaich-me-channel`. A healthy start logs a `start_up` line with `socket_mode: true` and a `dashboard` line with `http://127.0.0.1:<port>/`.

For restart after a crash or reboot, register a scheduled task that starts at boot and restarts on failure. Run once in an elevated PowerShell, changing the account name:

```powershell
$action  = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c cd /d `"C:\Cursor Repository\Hackathon\hackathon-teaich-me-channel`" && npm start >> state\host.log 2>&1"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "<your Windows account>"
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName "OnboardingCopilotChannel" -Action $action -Trigger $trigger -Settings $settings
```

The task starts at log-on, not at boot, because the Claude Code login belongs to the signed-in account. Windows must therefore log on after a reboot (set automatic sign-in, or sign in by hand). `pm2` is the alternative the spec names; this runbook uses the scheduled task because it needs no install.

## Pre-recording check

`npm run smoke:gateway` does not cover this route: it needs `GATEWAY_BASE_URL`, which is empty, so it exits with `Set GATEWAY_BASE_URL and AZURE_TENANT_ID in .env`. Use this instead; it calls Claude through the same `claude-code` client the app uses:

```powershell
npm run ask -- "How do I connect Claude to Context Builder?"
```

A reply (or the no-answer line) means the login works. An error means the login has lapsed: run `claude` and sign in again.

## Evidence (MANUAL)

Write `.claude/evidence/channel-host-run/host-run.md` and keep the app log as `.claude/evidence/channel-host-run/host.log`:

1. With every other team machine off, a test account sends `/onboard-ch` in the sandbox. The bot creates a private channel for that member and invites them. The member receives one DM with a link to the channel, and the welcome and the role question are the first messages in the channel (Scenarios 1, 3 and 6). The checklist is a pinned message (`CHECKLIST_SURFACE=message`, the default) or a channel canvas (`CHECKLIST_SURFACE=canvas`). The member's Claude posts its reports in the same channel.
2. Kill the app process (Task Manager, end `node.exe`). The task restarts it with no one acting. Send `/onboard-ch` again and note the reply (the member already has a channel, so no second channel is created).
3. Reboot the machine, sign in, and send `/onboard-ch` again.
4. After the reboot, `curl http://127.0.0.1:<port>/api/metrics` on this machine still shows the seeded count (A-EN-007).
5. List the times and the account's display name in `host-run.md`. `rg -c '"event":"start"' .claude/evidence/channel-host-run/host.log` must equal the number of starts listed there (first start, after the kill, after the reboot), and `rg -c '"event":"command"'` the number of test commands.
6. `npm run check:secrets` exits 0 over `host.log`.
