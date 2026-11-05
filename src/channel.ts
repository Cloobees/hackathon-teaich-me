// The member's private onboarding channel (FR-CH-001, 002, 004, 006, 023, 024). Not yet wired into the app.
import type { Deps } from "./deps.js";
import type { SlackClient } from "./slack.js";
import { getMemberChannel, setMemberChannel, type ChannelState, type Store } from "./store.js";

const PREFIX = "onboarding-copilot-";
const MAX_LENGTH = 80; // Slack's channel name limit
const MAX_RETRIES = 3; // name_taken retries with a suffix; the next try uses the user id (Create and invite errors)
const LOST_CODES = ["is_archived", "channel_not_found", "not_in_channel"];

export type ChannelOutcome = "created" | "existing" | "reinvited" | "create_failed" | "invite_failed";

export interface EnsureResult {
  outcome: ChannelOutcome;
  channelId?: string;
  channelName?: string;
  teamId?: string;
}

/** The channel name for a try: attempts 1 to 3 add `-2` to `-4`; attempt 4 is the lowercase user id. */
export function channelNameFor(profileName: string | undefined, userId: string, attempt = 0): string {
  if (attempt > MAX_RETRIES) return PREFIX + slugOf(userId).slice(0, MAX_LENGTH - PREFIX.length).replace(/-+$/, "");
  const suffix = attempt > 0 ? `-${attempt + 1}` : "";
  const slug = slugOf(profileName ?? "") || slugOf(userId);
  return PREFIX + slug.slice(0, MAX_LENGTH - PREFIX.length - suffix.length).replace(/-+$/, "") + suffix;
}

function slugOf(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The Slack error code: `data.error` on a platform error, else the message. */
function errorCode(error: unknown): string {
  const data = (error as { data?: { error?: unknown } } | null)?.data;
  if (typeof data?.error === "string") return data.error;
  return error instanceof Error ? error.message : String(error);
}

async function profileNameOf(slack: SlackClient, memberId: string): Promise<string | undefined> {
  try {
    const user = (await slack.users.info({ user: memberId })).user;
    return user?.real_name || user?.profile?.real_name || user?.profile?.display_name || undefined;
  } catch {
    return undefined;
  }
}

/** Invites the member; `already_in_channel` is success. Returns the error code on failure. */
async function invite(deps: Deps, channel: string, memberId: string): Promise<string | undefined> {
  try {
    await deps.slack.conversations.invite({ channel, users: memberId });
    return undefined;
  } catch (error) {
    const code = errorCode(error);
    if (code.includes("already_in_channel")) return undefined;
    return code;
  }
}

export async function ensureMemberChannel(deps: Deps, input: { memberId: string; startedBy: "event" | "command" }): Promise<EnsureResult> {
  const { memberId, startedBy } = input;
  const { store } = deps;
  const stored = getMemberChannel(store, memberId);

  if (stored?.id && stored.state === "active") return { outcome: "existing", channelId: stored.id, channelName: stored.name ?? undefined };

  if (stored?.id && (stored.state === "member_left" || stored.state === "invite_failed")) {
    const code = await invite(deps, stored.id, memberId);
    if (code) {
      setMemberChannel(store, memberId, { id: stored.id, name: stored.name, state: "invite_failed" });
      deps.log("channel_invite_failed", { member: memberId, channel: stored.id, error: code });
      return { outcome: "invite_failed", channelId: stored.id, channelName: stored.name ?? undefined };
    }
    setMemberChannel(store, memberId, { id: stored.id, name: stored.name, state: "active" });
    return { outcome: "reinvited", channelId: stored.id, channelName: stored.name ?? undefined };
  }

  // No channel, or a lost one: create.
  const profileName = await profileNameOf(deps.slack, memberId);
  let created: { id: string; name: string; teamId?: string } | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES + 1; attempt++) {
    const name = channelNameFor(profileName, memberId, attempt);
    try {
      const channel = (await deps.slack.conversations.create({ name, is_private: true })).channel;
      if (!channel?.id) throw new Error("no_channel_id");
      created = { id: channel.id, name: channel.name ?? name, teamId: channel.context_team_id };
      break;
    } catch (error) {
      const code = errorCode(error);
      if (code.includes("name_taken") && attempt <= MAX_RETRIES) continue;
      deps.log("channel_create_failed", { member: memberId, error: code });
      return { outcome: "create_failed" };
    }
  }
  if (!created) {
    deps.log("channel_create_failed", { member: memberId, error: "name_taken" });
    return { outcome: "create_failed" };
  }

  store.run("INSERT OR IGNORE INTO member (member_id, started_by) VALUES (?, ?)", memberId, startedBy);
  setMemberChannel(store, memberId, { id: created.id, name: created.name, state: "invite_failed" });
  const code = await invite(deps, created.id, memberId);
  if (code) {
    deps.log("channel_invite_failed", { member: memberId, channel: created.id, error: code });
    return { outcome: "invite_failed", channelId: created.id, channelName: created.name, teamId: created.teamId };
  }
  setMemberChannel(store, memberId, { id: created.id, name: created.name, state: "active" });
  return { outcome: "created", channelId: created.id, channelName: created.name, teamId: created.teamId };
}

export function memberChannel(store: Store, memberId: string): { id: string; name: string; state: ChannelState } | undefined {
  const stored = getMemberChannel(store, memberId);
  if (!stored?.id || !stored.name || !stored.state) return undefined;
  return { id: stored.id, name: stored.name, state: stored.state };
}

export function channelLink(channelId: string, teamId?: string): string {
  return `<#${channelId}>` + (teamId ? ` (slack://channel?team=${teamId}&id=${channelId})` : "");
}

/** Posts to the member's channel. A lost channel sets `channel_state='lost'`, logs once and returns undefined (FR-CH-024). */
export async function channelPost(
  deps: Deps,
  memberId: string,
  args: Parameters<SlackClient["chat"]["postMessage"]>[0],
): Promise<{ ts?: string } | undefined> {
  try {
    return await deps.slack.chat.postMessage(args);
  } catch (error) {
    const code = errorCode(error);
    if (!LOST_CODES.some((lost) => code.includes(lost))) throw error;
    deps.store.run("UPDATE member SET channel_state = 'lost' WHERE member_id = ?", memberId);
    deps.log("channel_lost", { member: memberId, channel: args.channel, error: code });
    return undefined;
  }
}
