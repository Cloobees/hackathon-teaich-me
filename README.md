# hackathon-teaich-me
Repository for hackathon's TeAIch Me team

Slack onboarding bot built on the Claude Agent SDK. POC: the agent can read from Context Builder
(read-only MCP tools) and a `PostToolUse` hook posts a progress note in the Slack thread.

## Run
1. `npm install`
2. Copy `.env.example` to `.env` and fill it in.
3. `npm run smoke -- "Which scopes do I have?"` checks the Context Builder connection and the hook without Slack.
4. `npm start` runs the Slack bot (Socket Mode). `npm test` runs the hook tests.

## Slack app setup (once, in a dev workspace first)
- Enable Socket Mode and create an app-level token (`SLACK_APP_TOKEN`).
- Bot token scopes: `app_mentions:read`, `chat:write`, `im:history`, `im:read`, `im:write`.
- Subscribe to bot events `app_mention`, `message.im` and `app_home_opened`; enable the App Home messages tab.
- Turn on Interactivity & Shortcuts (no request URL needed in Socket Mode) so the button works.
- Install to the workspace and copy the bot token (`SLACK_BOT_TOKEN`).
(Scope and event names are from memory; confirm at docs.slack.dev.)

## Upload-test-file button
Opening the app's Messages tab posts a message with a button. Clicking it makes the agent write
`onboarding/hello-from-teaich-me.txt` to your *personal* Context Builder workspace. Writes are only
allowed for that action, and `src/hooks/writeGuard.ts` denies anything outside the personal scope
and the `onboarding/` folder.
