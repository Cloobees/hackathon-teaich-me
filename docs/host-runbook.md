# Host runbook

`[yellow]` Drafted 2 November 2026 for BP-063 (FR-EN-012). The architect's machine runs the app, the store and the dashboard. Nothing here has been run; the steps marked MANUAL produce the evidence the plan asks for.

The app replies only while this machine is powered, awake, online and signed in. Every other team machine can be off.

## One-time setup

1. **Sleep off (AC power).** In PowerShell:

   ```powershell
   powercfg /change standby-timeout-ac 0
   powercfg /change hibernate-timeout-ac 0
   powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE
   ```

   The query must show the AC setting index `0x00000000`. Copy that line into `.claude/evidence/BP-063/host-run.md`. Keep the lid open or set the lid-close action to Do nothing.
2. **Claude Code login.** The app calls Claude through the signed-in Claude Code session (`CLAUDE_AUTH=claude-code` in `.env`, A-EN-004). Run `claude` once under the Windows account that will run the app and confirm it is signed in. If the login lapses, every answer fails and the app does not warn at start-up (OQ-EN-012).
3. **`.env`.** `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `OPERATOR_USER_IDS`, `CHECK_CHANNEL_ID` and `CLAUDE_AUTH` are set. Values stay in `.env`, never here.
4. **Seed.** `npm run seed` once, so the dashboard shows the seeded cohort.

## Start and restart

Start by hand: `npm start` from `hackathon-teaich-me`. A healthy start logs a `start_up` line with `socket_mode: true` and a `dashboard` line with `http://127.0.0.1:<port>/`.

For restart after a crash or reboot, register a scheduled task that starts at boot and restarts on failure. Run once in an elevated PowerShell, changing the account name:

```powershell
$action  = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c cd /d `"C:\Cursor Repository\Hackathon\hackathon-teaich-me`" && npm start >> state\host.log 2>&1"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "<your Windows account>"
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName "ToolchainCopilot" -Action $action -Trigger $trigger -Settings $settings
```

The task starts at log-on, not at boot, because the Claude Code login belongs to the signed-in account. Windows must therefore log on after a reboot (set automatic sign-in, or sign in by hand). `pm2` is the alternative the spec names; this runbook uses the scheduled task because it needs no install.

## Pre-recording check

`npm run smoke:gateway` does not cover this route: it needs `GATEWAY_BASE_URL`, which is empty, so it exits with `Set GATEWAY_BASE_URL and AZURE_TENANT_ID in .env`. Use this instead; it calls Claude through the same `claude-code` client the app uses:

```powershell
npm run ask -- "How do I connect Claude to Context Builder?"
```

A reply (or the no-answer line) means the login works. An error means the login has lapsed: run `claude` and sign in again.

## Evidence (MANUAL)

Write `.claude/evidence/BP-063/host-run.md` and keep the app log as `.claude/evidence/BP-063/host.log`:

1. With every other team machine off, a test account sends `/onboard` in the sandbox and receives the first message in its DM (Scenario 7).
2. Kill the app process (Task Manager, end `node.exe`). The task restarts it with no one acting. Send `/onboard` again and note the reply.
3. Reboot the machine, sign in, and send `/onboard` again.
4. After the reboot, `curl http://127.0.0.1:<port>/api/metrics` on this machine still shows the seeded count (A-EN-007).
5. List the times and the account's display name in `host-run.md`. `rg -c '"event":"start"' .claude/evidence/BP-063/host.log` must equal the number of starts listed there (first start, after the kill, after the reboot), and `rg -c '"event":"command"'` the number of test commands.
6. `npm run check:secrets` exits 0 over `host.log`.
