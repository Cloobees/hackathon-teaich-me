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

/** An error shaped like a Slack platform error: the code is `data.error`, as the code under test reads it. */
export const slackError = (code: string): Error => Object.assign(new Error(code), { data: { error: code } });

/** A Slack client that records every call and fails nothing unless told to. */
export class FakeSlack {
  calls: Call[] = [];
  emails: Record<string, string> = {};
  /** users.info names by user id: `real_name` is the top-level field, the other two sit under `profile`. */
  profiles: Record<string, { real_name?: string; profile_real_name?: string; display_name?: string }> = {};
  /** conversations.info results by channel id. */
  channels: Record<string, { name: string; is_private?: boolean; is_archived?: boolean }> = {};
  members: { id?: string; name?: string; real_name?: string; is_bot?: boolean; deleted?: boolean }[] = [];
  failOpen = false;
  failList = false;
  failUpload = false;
  failPin = false;
  failCreate = false;
  failInvite = false;
  failCanvas = false;
  /** `context_team_id` returned by conversations.create; unset by default. */
  teamId: string | undefined;
  /** Channel names that make conversations.create throw `name_taken` once each. */
  nameTaken: string[] = [];
  /** Channels made by conversations.create, in order. */
  created: { id: string; name: string }[] = [];
  /** Canvas ids by channel id. */
  canvases: Record<string, string> = {};
  /** Canvas markdown by canvas id; one line per task, as the real canvas stores each list item as its own section. */
  canvasBodies: Record<string, string> = {};
  /** Makes the next canvases.edit throw `canvas_editing_locked`, then clears itself. */
  lockOnce = false;
  private channelSeq = 0;
  private canvasSeq = 0;
  private ts = 0;

  client: SlackClient = {
    conversations: {
      open: async (args) => {
        this.calls.push({ method: "conversations.open", args });
        if (this.failOpen) throw slackError("cannot_dm_bot");
        return { channel: { id: `D-${args.users}` } };
      },
      info: async (args) => {
        this.calls.push({ method: "conversations.info", args });
        const channel = this.channels[args.channel];
        if (!channel) throw slackError("channel_not_found");
        return { channel: { id: args.channel, name: channel.name, is_private: channel.is_private, is_archived: channel.is_archived } };
      },
      create: async (args) => {
        this.calls.push({ method: "conversations.create", args });
        if (this.failCreate) throw slackError("restricted_action");
        const taken = this.nameTaken.indexOf(args.name);
        if (taken >= 0) {
          this.nameTaken.splice(taken, 1);
          throw slackError("name_taken");
        }
        const channel = { id: `C-${++this.channelSeq}`, name: args.name, ...(this.teamId ? { context_team_id: this.teamId } : {}) };
        this.created.push(channel);
        return { channel };
      },
      invite: async (args) => {
        this.calls.push({ method: "conversations.invite", args });
        if (this.failInvite) throw slackError("user_is_restricted");
        return {};
      },
      canvases: {
        create: async (args) => {
          this.calls.push({ method: "conversations.canvases.create", args });
          if (this.failCanvas) throw slackError("canvas_disabled_for_team");
          if (this.canvases[args.channel_id]) throw slackError("channel_canvas_already_exists");
          const canvasId = `F-${++this.canvasSeq}`;
          this.canvases[args.channel_id] = canvasId;
          this.canvasBodies[canvasId] = args.document_content?.markdown ?? "";
          return { canvas_id: canvasId };
        },
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
    canvases: {
      sections: {
        lookup: async (args) => {
          this.calls.push({ method: "canvases.sections.lookup", args });
          if (this.failCanvas) throw slackError("canvas_disabled_for_team");
          const body = this.canvasBodies[args.canvas_id];
          if (body === undefined) throw slackError("canvas_not_found");
          const needle = args.criteria.contains_text ?? "";
          const sections = body
            .split("\n")
            .flatMap((line, index) => (line.includes(needle) ? [{ id: `temp:${args.canvas_id}:${index}` }] : []));
          return { sections };
        },
      },
      edit: async (args) => {
        this.calls.push({ method: "canvases.edit", args });
        if (this.failCanvas) throw slackError("canvas_disabled_for_team");
        if (this.lockOnce) {
          this.lockOnce = false;
          throw slackError("canvas_editing_locked");
        }
        const body = this.canvasBodies[args.canvas_id];
        if (body === undefined) throw slackError("canvas_not_found");
        if (args.changes.length !== 1) throw slackError("invalid_arguments");
        const change = args.changes[0] as { operation?: string; section_id?: string; document_content?: { markdown?: string } };
        const markdown = change.document_content?.markdown ?? "";
        if (!change.section_id) {
          this.canvasBodies[args.canvas_id] = markdown;
          return {};
        }
        const lines = body.split("\n");
        const [, canvas, index] = change.section_id.split(":");
        const at = Number(index);
        if (canvas !== args.canvas_id || !Number.isInteger(at) || at < 0 || at >= lines.length) throw slackError("section_not_found");
        lines[at] = markdown;
        this.canvasBodies[args.canvas_id] = lines.join("\n");
        return {};
      },
    },
    pins: {
      add: async (args) => {
        this.calls.push({ method: "pins.add", args });
        if (this.failPin) throw slackError("channel_not_found");
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
        if (this.failUpload) throw slackError("upload_failed");
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
        if (this.failList) throw slackError("ratelimited");
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

/** Runs the real channel start and role flow, so the member has a role, a channel, a link DM and a posted checklist. */
export async function onboard(deps: Deps, memberId: string, role: Role): Promise<void> {
  await startOnboarding(deps, { memberId, startedBy: "command" });
  const channel = deps.store.get<{ channel_id: string | null }>("SELECT channel_id FROM member WHERE member_id = ?", memberId)?.channel_id ?? `D-${memberId}`;
  await handleRole(deps, { memberId, role, channel, messageTs: "100.001" });
}

export const itemStatuses = (deps: Deps, memberId: string) =>
  Object.fromEntries(
    deps.store
      .all<{ item_id: string; status: string }>("SELECT item_id, status FROM checklist_item WHERE member_id = ? ORDER BY item_id", memberId)
      .map((r) => [r.item_id, r.status]),
  );
