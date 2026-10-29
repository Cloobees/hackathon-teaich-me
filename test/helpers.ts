import { fileURLToPath } from "node:url";
import { loadItems } from "../src/checklist.js";
import type { Deps } from "../src/deps.js";
import type { Block, SlackClient } from "../src/slack.js";
import { openStore } from "../src/store.js";
import { handleRole, startOnboarding } from "../src/start.js";
import type { Role } from "../src/store.js";

export const FIXTURE_LIBRARY = fileURLToPath(new URL("./fixtures/library", import.meta.url));

export interface Call {
  method: string;
  args: Record<string, unknown>;
}

/** A Slack client that records every call and fails nothing unless told to. */
export class FakeSlack {
  calls: Call[] = [];
  emails: Record<string, string> = {};
  members: { id?: string; name?: string; real_name?: string; is_bot?: boolean; deleted?: boolean }[] = [];
  failOpen = false;
  failList = false;
  private ts = 0;

  client: SlackClient = {
    conversations: {
      open: async (args) => {
        this.calls.push({ method: "conversations.open", args });
        if (this.failOpen) throw new Error("cannot_dm_bot");
        return { channel: { id: `D-${args.users}` } };
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
    users: {
      info: async (args) => ({ user: { profile: { email: this.emails[args.user] } } }),
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
