import { readFileSync } from "node:fs";
import { channelPost } from "./channel.js";
import type { Deps } from "./deps.js";

const FILENAME = "copilot-check.zip";

/**
 * Uploads the copilot-check zip into the member's channel (FR-CH-018). A missing file or a failing upload attaches
 * nothing, posts one fallback message in the channel naming the help channel, logs `skill_zip_missing` and never throws.
 * A member with no channel logs `skill_zip_no_channel` and gets nothing.
 */
export async function sendSkillZip(deps: Deps, memberId: string): Promise<void> {
  const member = deps.store.get<{ channel_id: string | null }>("SELECT channel_id FROM member WHERE member_id = ?", memberId);
  if (!member?.channel_id) {
    deps.log("skill_zip_no_channel", { member: memberId });
    return;
  }
  const channel = member.channel_id;
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
      await channelPost(deps, memberId, {
        channel,
        text: 'I could not attach the skill file. Ask in the help channel for it, then use "I did it" on this step once you have added it.',
      });
    } catch (postError) {
      deps.log("skill_zip_post_failed", { member: memberId, error: (postError as Error).message });
    }
  }
}
