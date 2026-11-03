import { readFileSync } from "node:fs";
import type { Deps } from "./deps.js";

const FILENAME = "copilot-check.zip";

/**
 * Attaches the copilot-check zip to the member's DM (FR-VF-013). A missing file or a failing upload attaches nothing,
 * sends one DM pointing at "I did it", logs `skill_zip_missing` and never throws.
 */
export async function sendSkillZip(deps: Deps, memberId: string): Promise<void> {
  const member = deps.store.get<{ dm_channel_id: string | null }>("SELECT dm_channel_id FROM member WHERE member_id = ?", memberId);
  if (!member?.dm_channel_id) return;
  const channel = member.dm_channel_id;
  try {
    if (!deps.skillZipPath) throw new Error("SKILL_ZIP_PATH is not set");
    const file = readFileSync(deps.skillZipPath);
    await deps.slack.files.uploadV2({
      channel_id: channel,
      file,
      filename: FILENAME,
      initial_comment: "Here is the copilot-check skill. Upload this file in Claude as the step above says.",
    });
    deps.log("skill_zip_sent", { member: memberId });
  } catch (error) {
    deps.log("skill_zip_missing", { member: memberId, error: (error as Error).message });
    try {
      await deps.slack.chat.postMessage({
        channel,
        text: 'I could not attach the skill file. Ask in the help channel for it, then use "I did it" on this step once you have added it.',
      });
    } catch (dmError) {
      deps.log("skill_zip_dm_failed", { member: memberId, error: (dmError as Error).message });
    }
  }
}
