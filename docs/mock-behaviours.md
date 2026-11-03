# Mock behaviours

Text a member could see from a mock path instead of the real copilot (FR-EN-013). `npm run check:mocks -- --strict <transcript-file>`
fails while any entry is `open` or when the transcript holds an entry's text. Status is `replaced` (a real behaviour took its
place), `hidden` (the real app never reaches it) or `open` (a member can still reach it).

`src/index.ts` is started only by `npm run start:mock`. The real app is `src/app.ts` (`npm start`), which imports neither
`src/index.ts` nor `src/echo.ts` and has no `app_home_opened` handler (checked 2026-11-02, `rg` over `src`, `scripts`, `test`), so every entry below is `hidden`.

## M1 Welcome message, fallback text
- what: the text Slack shows for the Messages tab welcome message in `src/index.ts` when blocks are not rendered
- text: `Welcome to TeAIch Me! Click the button to upload a test file to your personal workspace.`
- status: hidden
- why: posted only by the `app_home_opened` handler in `src/index.ts`; `npm start` never loads that file

## M2 Welcome message, block text
- what: the section block of the same welcome message in `src/index.ts`
- text: `I'll upload a small test file to your personal Context Builder workspace.`
- status: hidden
- why: same handler as M1

## M3 Upload test file button
- what: the button label under the welcome message in `src/index.ts`
- text: `Upload a test file to my workspace`
- status: hidden
- why: the `upload_test_file` action exists only in `src/index.ts`, so `npm start` has no handler for it

## M4 Echo reply to the upload button
- what: the `src/echo.ts` reply that pretends to save the test file when the button is clicked
- text: `Echo mode (no agent): pretending I saved`
- status: hidden
- why: `runEchoTurn` is called only from `src/index.ts` and only when `ECHO_MODE=1`; `npm start` does not import it

## M5 Echo reply to a message
- what: the `src/echo.ts` reply that repeats the member's message back
- text: `Echo mode (no agent): you said`
- status: hidden
- why: same as M4
