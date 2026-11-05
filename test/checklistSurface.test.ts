import { describe, expect, it } from "vitest";
import { createRows, getRows } from "../src/checklist.js";
import { selectSurface } from "../src/checklistSurface.js";
import { messageSurface } from "../src/checklistSurfaceMessage.js";
import { makeDeps, slackError } from "./helpers.js";

const GLOSSARY = "https://example.slack.com/canvas/F1";

/** A member with a channel and a role, rows inserted, nothing posted yet. */
function member(overrides: { glossaryUrl?: string } = {}) {
  const deps = makeDeps(overrides);
  deps.store.run("INSERT INTO member (member_id, started_by, dm_channel_id, channel_id, role) VALUES ('U1', 'command', 'D-U1', 'C-1', 'technical')");
  createRows(deps.store, deps.items, "U1", "technical");
  return deps;
}
const checklistTs = (deps: ReturnType<typeof makeDeps>) =>
  deps.store.get<{ checklist_ts: string | null }>("SELECT checklist_ts FROM member WHERE member_id = 'U1'")?.checklist_ts;

describe("message surface: create", () => {
  it("posts one message to channel_id, glossary link first, no instruction text, stores checklist_ts and pins it", async () => {
    const deps = member({ glossaryUrl: GLOSSARY });
    const used = await messageSurface.create(deps, "U1", getRows(deps.store, "U1"));

    expect(used).toBe("message");
    const posts = deps.fake.of("chat.postMessage");
    expect(posts).toHaveLength(1);
    const args = posts[0]?.args as { channel: string; text: string; blocks: { accessory?: { url: string; action_id: string } }[] };
    expect(args.channel).toBe("C-1");
    expect(args.blocks[0]?.accessory).toMatchObject({ url: GLOSSARY, action_id: "open_glossary" });
    expect(JSON.stringify(args.blocks)).not.toContain("Open Claude, go to Settings");
    expect(JSON.stringify(args.blocks)).not.toContain("No instruction is in the library");
    const ts = checklistTs(deps);
    expect(ts).toBe("100.001");
    expect(deps.fake.of("pins.add")).toEqual([{ method: "pins.add", args: { channel: "C-1", timestamp: ts } }]);
  });

  it("a failing pins.add is logged as pin_failed, the checklist stays, no Home view, no pin_refused write", async () => {
    const deps = member();
    deps.fake.failPin = true;
    await expect(messageSurface.create(deps, "U1", getRows(deps.store, "U1"))).resolves.toBe("message");

    expect(deps.logs.filter((l) => l.includes("pin_failed"))).toHaveLength(1);
    expect(checklistTs(deps)).toBe("100.001");
    expect(deps.fake.of("views.publish")).toHaveLength(0);
    expect(deps.store.get<{ pin_refused: number | null }>("SELECT pin_refused FROM member WHERE member_id = 'U1'")?.pin_refused).toBeNull();
  });

  it("a member with no channel_id posts nothing, logs checklist_no_channel and does not throw", async () => {
    const deps = makeDeps();
    deps.store.run("INSERT INTO member (member_id, started_by, dm_channel_id, role) VALUES ('U1', 'command', 'D-U1', 'technical')");
    await expect(messageSurface.create(deps, "U1", [])).resolves.toBe("message");
    expect(deps.fake.of("chat.postMessage")).toHaveLength(0);
    expect(deps.logs.some((l) => l.includes("checklist_no_channel"))).toBe(true);
  });

  it.each(["is_archived", "channel_not_found", "not_in_channel"])("a %s error from pins.add is logged and does not throw", async (code) => {
    const deps = member();
    deps.slack.pins.add = async () => {
      throw slackError(code);
    };
    await expect(messageSurface.create(deps, "U1", getRows(deps.store, "U1"))).resolves.toBe("message");
    expect(deps.logs.some((l) => l.includes("pin_failed") && l.includes(code))).toBe(true);
    expect(checklistTs(deps)).toBe("100.001");
  });

  it.each(["is_archived", "channel_not_found", "not_in_channel"])("a %s error from chat.postMessage is logged and does not throw", async (code) => {
    const deps = member();
    deps.slack.chat.postMessage = async () => {
      throw slackError(code);
    };
    await expect(messageSurface.create(deps, "U1", getRows(deps.store, "U1"))).resolves.toBe("message");
    expect(checklistTs(deps)).toBeNull();
    expect(deps.fake.of("pins.add")).toHaveLength(0);
    expect(deps.logs.some((l) => l.includes(code))).toBe(true);
  });
});

describe("message surface: update", () => {
  it("sends text and blocks together on checklist_ts, edits in place, posts no second checklist", async () => {
    const deps = member();
    await messageSurface.create(deps, "U1", getRows(deps.store, "U1"));
    deps.store.run("UPDATE checklist_item SET status = 'ticked', method = 'observed' WHERE member_id = 'U1' AND item_id = 'I1'");
    await messageSurface.update(deps, "U1", getRows(deps.store, "U1"));

    expect(deps.fake.of("chat.postMessage")).toHaveLength(1);
    const updates = deps.fake.of("chat.update");
    expect(updates).toHaveLength(1);
    const args = updates[0]?.args as { channel: string; ts: string; text: string; blocks: unknown[] };
    expect(args.channel).toBe("C-1");
    expect(args.ts).toBe(checklistTs(deps));
    expect(args.text).toContain("1 of 7");
    expect(args.blocks.length).toBeGreaterThan(0);
    expect(JSON.stringify(args.blocks)).toContain("~1. Connect Claude to Slack~");
  });

  it("with no checklist_ts it logs checklist_no_message and posts and updates nothing", async () => {
    const deps = member();
    await messageSurface.update(deps, "U1", getRows(deps.store, "U1"));
    expect(deps.logs.some((l) => l.includes("checklist_no_message"))).toBe(true);
    expect(deps.fake.of("chat.postMessage")).toHaveLength(0);
    expect(deps.fake.of("chat.update")).toHaveLength(0);
  });

  it("with no channel it logs checklist_no_message and does not throw", async () => {
    const deps = makeDeps();
    deps.store.run("INSERT INTO member (member_id, started_by, role, checklist_ts) VALUES ('U1', 'command', 'technical', '100.9')");
    await expect(messageSurface.update(deps, "U1", [])).resolves.toBeUndefined();
    expect(deps.logs.some((l) => l.includes("checklist_no_message"))).toBe(true);
    expect(deps.fake.of("chat.update")).toHaveLength(0);
  });

  it.each(["is_archived", "channel_not_found", "not_in_channel"])("a %s error from chat.update is logged and does not throw", async (code) => {
    const deps = member();
    await messageSurface.create(deps, "U1", getRows(deps.store, "U1"));
    deps.slack.chat.update = async () => {
      throw slackError(code);
    };
    await expect(messageSurface.update(deps, "U1", getRows(deps.store, "U1"))).resolves.toBeUndefined();
    expect(deps.logs.some((l) => l.includes(code))).toBe(true);
  });

  it("an error that is not a gone-channel code still throws", async () => {
    const deps = member();
    await messageSurface.create(deps, "U1", getRows(deps.store, "U1"));
    deps.slack.chat.update = async () => {
      throw slackError("ratelimited");
    };
    await expect(messageSurface.update(deps, "U1", getRows(deps.store, "U1"))).rejects.toThrow("ratelimited");
  });
});

describe("message surface: reset", () => {
  it("edits the stored checklist message to the reset text with a matching block and clears nothing", async () => {
    const deps = member();
    await messageSurface.create(deps, "U1", getRows(deps.store, "U1"));
    const ts = checklistTs(deps);
    await messageSurface.reset(deps, "U1");

    const args = deps.fake.last("chat.update") as { channel: string; ts: string; text: string; blocks: { type: string; text: { text: string } }[] };
    expect(args).toMatchObject({ channel: "C-1", ts, text: "Checklist reset. A new one follows when you choose your role." });
    expect(args.blocks).toEqual([{ type: "section", text: { type: "mrkdwn", text: args.text } }]);
    expect(checklistTs(deps)).toBe(ts);
    expect(deps.store.get<{ role: string }>("SELECT role FROM member WHERE member_id = 'U1'")?.role).toBe("technical");
    expect(getRows(deps.store, "U1")).toHaveLength(7);
    expect(deps.fake.of("chat.postMessage")).toHaveLength(1);
  });

  it("with no checklist message it logs checklist_no_message and edits nothing", async () => {
    const deps = member();
    await messageSurface.reset(deps, "U1");
    expect(deps.logs.some((l) => l.includes("checklist_no_message"))).toBe(true);
    expect(deps.fake.of("chat.update")).toHaveLength(0);
  });
});

describe("selectSurface", () => {
  it("returns an object with create, update and reset", () => {
    const surface = selectSurface(makeDeps(), "U1");
    expect(typeof surface.create).toBe("function");
    expect(typeof surface.update).toBe("function");
    expect(typeof surface.reset).toBe("function");
  });
});
