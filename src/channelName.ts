// The name of a member's private report channel (FR-VF-018): built from the Slack profile name so the member's own
// Claude can create it, and so the app can find it again when it is invited.
const PREFIX = "onboarding-copilot-";
const MAX_LENGTH = 80; // Slack's channel name limit

export function channelName(profileName: string | undefined, userId: string): string {
  const slug = slugOf(profileName ?? "") || slugOf(userId);
  return PREFIX + slug.slice(0, MAX_LENGTH - PREFIX.length).replace(/-+$/, "");
}

function slugOf(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
