export const UPLOAD_TEST_PATH = "onboarding/hello-from-teaich-me.txt";

export const UPLOAD_TEST_SYSTEM_NOTE = `
For this request only, you are allowed to use write_file, exactly once, to save the requested test file in the user's personal workspace (scopeType "USER"). Never write anywhere else and never use any other write tool.`;

export function uploadTestPrompt(slackUserId: string, now = new Date()): string {
  return `Please upload a small text file to my personal Context Builder workspace (scopeType "USER") using write_file.
Path: ${UPLOAD_TEST_PATH}
Content (plain text, exactly these two lines):
Hello from TeAIch Me!
Uploaded for Slack user ${slackUserId} at ${now.toISOString()}
Afterwards, tell me the path you saved and share the preview link from the tool result if there is one.`;
}
