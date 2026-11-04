import { fileURLToPath } from "node:url";
import { loadItems } from "../src/checklist.js";
import type { Deps } from "../src/deps.js";
import type { Block, SlackClient } from "../src/slack.js";
import { openStore } from "../src/store.js";
import { handleRole, startOnboarding } from "../src/start.js";
import type { Role } from "../src/store.js";

export const FIXTURE_LIBRARY = fileURLToPath(new URL("./fixtures/library", import.meta.url));
export const SKILL_ZIP = fileURLToPath(new URL("../library-files/copilot-check.zip", import.meta.url));

export interface Call {
  method: string;
  args: Record<string, unknown>;
}

/** A Slack client that records every call and fails nothing unless told to. */
export class FakeSlack {
  calls: Call[] = [];
  emails: Record<string, string> = {};
  /** users.info names by user id: `real_name` is the top-level field, the other two sit under `profile`. */
  profiles: Record<string, { real_name?: string; profile_real_name?: string; display_name?: string }> = {};
  /** conversations.info results by channel id. */
  channels: Record<string, { name: string; is_private?: boolean }> = {};
  members: { id?: string; name?: string; real_name?: string; is_bot?: boolean; deleted?: boolean }[] = [];
  failOpen = false;
  failList = false;
  failUpload = false;
  failPin = false;
  private ts = 0;

  client: SlackClient = {
    conversations: {
      open: async (args) => {
        this.calls.push({ method: "conversations.open", args });
        if (this.failOpen) throw new Error("cannot_dm_bot");
        return { channel: { id: `D-${args.users}` } };
      },
      info: async (args) => {
        this.calls.push({ method: "conversations.info", args });
        const channel = this.channels[args.channel];
        if (!channel) throw new Error("channel_not_found");
        return { channel: { id: args.channel, name: channel.name, is_private: channel.is_private } };
      },
    },
    chat: {
      postMessage: async (args) => {
        this.calls.push({ method: "chat.postMessage", args });
        return { ts: `100.${String(++this.ts).padStart(3, "0")}` };
      },
      update: async (args) => {
        this.calls.push({ method: "chat.update", args });
        return {};
      },
    },
    pins: {
      add: async (args) => {
        this.calls.push({ method: "pins.add", args });
        if (this.failPin) throw new Error("channel_not_found");
        return {};
      },
    },
    views: {
      publish: async (args) => {
        this.calls.push({ method: "views.publish", args });
        return {};
      },
    },
    files: {
      uploadV2: async (args) => {
        this.calls.push({ method: "files.uploadV2", args });
        if (this.failUpload) throw new Error("upload_failed");
        return {};
      },
    },
    users: {
      info: async (args) => {
        const names = this.profiles[args.user] ?? {};
        return {
          user: {
            real_name: names.real_name,
            profile: { email: this.emails[args.user], real_name: names.profile_real_name, display_name: names.display_name },
          },
        };
      },
      list: async () => {
        if (this.failList) throw new Error("ratelimited");
        return { members: this.members };
      },
    },
  };

  of = (method: string) => this.calls.filter((c) => c.method === method);
  last = (method: string) => this.of(method).at(-1)?.args as { channel: string; ts?: string; text: string; blocks?: Block[] };
}

export interface Clock {
  t: number;
  now: () => string;
  advance: (ms: number) => void;
}
export const makeClock = (start = "2026-10-26T10:00:00.000Z"): Clock => {
  const clock: Clock = { t: Date.parse(start), now: () => new Date(clock.t).toISOString(), advance: (ms) => (clock.t += ms) };
  return clock;
};

export function makeDeps(overrides: Partial<Deps> = {}): Deps & { fake: FakeSlack; clock: Clock; logs: string[] } {
  const fake = new FakeSlack();
  const clock = makeClock();
  const logs: string[] = [];
  return {
    store: openStore(":memory:"),
    slack: fake.client,
    items: loadItems(),
    libraryDir: FIXTURE_LIBRARY,
    skillZipPath: SKILL_ZIP,
    now: clock.now,
    log: (event, fields) => logs.push(JSON.stringify({ event, ...fields })),
    operators: ["UOP1"],
    ...overrides,
    fake,
    clock,
    logs,
  };
}

/** Runs the real start and role flow, so the member has a role, a DM and a posted checklist. */
export async function onboard(deps: Deps, memberId: string, role: Role): Promise<void> {
  await startOnboarding(deps, { memberId, startedBy: "command" });
  await handleRole(deps, { memberId, role, channel: `D-${memberId}`, messageTs: "100.001" });
}

export const itemStatuses = (deps: Deps, memberId: string) =>
  Object.fromEntries(
    deps.store
      .all<{ item_id: string; status: string }>("SELECT item_id, status FROM checklist_item WHERE member_id = ? ORDER BY item_id", memberId)
      .map((r) => [r.item_id, r.status]),
  );
