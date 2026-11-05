import { describe, expect, it } from "vitest";
import { createRows, getRows, type ItemDef } from "../src/checklist.js";
import { selectSurface } from "../src/checklistSurface.js";
import { canvasLabel, canvasSurface, makeCanvasSurface } from "../src/checklistSurfaceCanvas.js";
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

  it("a failing pins.add is logged as pin_failed, the checklist stays, no Home view", async () => {
    const deps = member();
    deps.fake.failPin = true;
    await expect(messageSurface.create(deps, "U1", getRows(deps.store, "U1"))).resolves.toBe("message");

    expect(deps.logs.filter((l) => l.includes("pin_failed"))).toHaveLength(1);
    expect(checklistTs(deps)).toBe("100.001");
    expect(deps.fake.of("views.publish")).toHaveLength(0);
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

  it("with no checklist_ts but a channel it posts and pins the checklist from the store's rows, stores checklist_ts and edits nothing (BP-098 review finding 2)", async () => {
    const deps = member();
    deps.store.run("UPDATE checklist_item SET status = 'ticked', method = 'observed' WHERE member_id = 'U1' AND item_id = 'I1'");
    await messageSurface.update(deps, "U1", getRows(deps.store, "U1"));

    expect(deps.logs.some((l) => l.includes("checklist_no_message"))).toBe(false);
    const posts = deps.fake.of("chat.postMessage");
    expect(posts).toHaveLength(1);
    expect((posts[0]?.args as { channel: string; text: string }).channel).toBe("C-1");
    expect((posts[0]?.args as { text: string }).text).toContain("1 of 7");
    expect(JSON.stringify(posts[0]?.args)).toContain("~1. Connect Claude to Slack~");
    expect(checklistTs(deps)).toBe("100.001");
    expect(deps.fake.of("pins.add")).toEqual([{ method: "pins.add", args: { channel: "C-1", timestamp: "100.001" } }]);
    expect(deps.fake.of("chat.update")).toHaveLength(0);

    await messageSurface.update(deps, "U1", getRows(deps.store, "U1"));
    expect(deps.fake.of("chat.postMessage")).toHaveLength(1);
    expect(deps.fake.of("chat.update")).toHaveLength(1);
  });

  it("with no checklist_ts and no role it logs checklist_no_message and posts nothing", async () => {
    const deps = member();
    deps.store.run("UPDATE member SET role = NULL WHERE member_id = 'U1'");
    await messageSurface.update(deps, "U1", getRows(deps.store, "U1"));
    expect(deps.logs.some((l) => l.includes("checklist_no_message"))).toBe(true);
    expect(deps.fake.of("chat.postMessage")).toHaveLength(0);
    expect(deps.fake.of("chat.update")).toHaveLength(0);
  });

  it.each(["is_archived", "channel_not_found", "not_in_channel"])("a %s error on the recreate marks the channel lost once and does not throw", async (code) => {
    const deps = member();
    deps.slack.chat.postMessage = async () => {
      throw slackError(code);
    };
    await expect(messageSurface.update(deps, "U1", getRows(deps.store, "U1"))).resolves.toBeUndefined();
    await expect(messageSurface.update(deps, "U1", getRows(deps.store, "U1"))).resolves.toBeUndefined();
    expect(deps.store.get("SELECT channel_state FROM member WHERE member_id = 'U1'")).toEqual({ channel_state: "lost" });
    expect(deps.logs.filter((l) => l.includes('"event":"channel_lost"'))).toHaveLength(1);
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
    expect(deps.store.get("SELECT channel_state FROM member WHERE member_id = 'U1'")).toEqual({ channel_state: "lost" });
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

describe("selectSurface: canvas and message", () => {
  const withSurface = (stored: string | null, config?: "canvas" | "message") => {
    const deps = makeDeps({ checklistSurface: config });
    deps.store.run("INSERT INTO member (member_id, started_by, channel_id, role, canvas_surface) VALUES ('U1', 'command', 'C-1', 'technical', ?)", stored);
    return selectSurface(deps, "U1");
  };
  it("follows the config when canvas_surface is null", () => {
    expect(withSurface(null, "canvas")).toBe(canvasSurface);
    expect(withSurface(null, "message")).toBe(messageSurface);
    expect(withSurface(null)).toBe(messageSurface);
  });
  it("a member with a message checklist (checklist_ts set, canvas_surface null) keeps the message surface after the config switches to canvas", () => {
    const deps = makeDeps({ checklistSurface: "canvas" });
    deps.store.run("INSERT INTO member (member_id, started_by, channel_id, role, checklist_ts) VALUES ('U1', 'command', 'C-1', 'technical', '100.001')");
    expect(selectSurface(deps, "U1")).toBe(messageSurface);
  });
  it("a null canvas_surface with no checklist_ts and config canvas chooses canvas", () => {
    expect(withSurface(null, "canvas")).toBe(canvasSurface);
  });
  it("a stored canvas_surface wins over the config", () => {
    expect(withSurface("canvas", "message")).toBe(canvasSurface);
    expect(withSurface("message", "canvas")).toBe(messageSurface);
  });
  it("an unknown member follows the config", () => {
    expect(selectSurface(makeDeps({ checklistSurface: "canvas" }), "UNKNOWN")).toBe(canvasSurface);
    expect(selectSurface(makeDeps(), "UNKNOWN")).toBe(messageSurface);
  });
});

describe("canvas surface", () => {
  const surface = makeCanvasSurface({ lockDelayMs: 0 });
  type TestDeps = ReturnType<typeof makeDeps>;
  const canvasMember = () => {
    const deps = member({ glossaryUrl: GLOSSARY });
    deps.checklistSurface = "canvas";
    return deps;
  };
  const rows = (deps: TestDeps) => getRows(deps.store, "U1");
  const tickRow = (deps: TestDeps, id: string) =>
    deps.store.run("UPDATE checklist_item SET status = 'ticked', method = 'observed' WHERE member_id = 'U1' AND item_id = ?", id);
  const stored = (deps: TestDeps) =>
    deps.store.get<{ checklist_canvas_id: string | null; canvas_surface: string | null }>("SELECT checklist_canvas_id, canvas_surface FROM member WHERE member_id = 'U1'");
  const degraded = (deps: TestDeps) => deps.logs.filter((l) => l.includes("canvas_degraded"));
  const canvasCalls = (deps: TestDeps) => deps.fake.calls.filter((c) => c.method.includes("canvas"));
  const label = (deps: TestDeps, id: string) => canvasLabel(deps, "technical", deps.items.items.find((i) => i.id === id) as ItemDef);
  const body = (deps: TestDeps) => (deps.fake.canvasBodies["F-1"] ?? "").split("\n");

  describe("create", () => {
    it("creates the canvas once with the glossary line first and one unticked line per item, stores id and surface, posts one pointer message, no pin", async () => {
      const deps = canvasMember();
      await expect(surface.create(deps, "U1", rows(deps))).resolves.toBe("canvas");

      expect(deps.fake.of("conversations.canvases.create")).toHaveLength(1);
      expect(stored(deps)).toEqual({ checklist_canvas_id: "F-1", canvas_surface: "canvas" });
      const lines = body(deps);
      expect(lines[0]).toBe(`The glossary canvas: ${GLOSSARY}`);
      expect(lines[1]).toBe("- [ ] Step 1: Connect Claude to Slack");
      expect(lines).toHaveLength(8);
      expect(lines.slice(1).every((l) => /^- \[ \] Step \d: /.test(l))).toBe(true);
      const posts = deps.fake.of("chat.postMessage");
      expect(posts).toHaveLength(1);
      expect((posts[0]?.args as { channel: string }).channel).toBe("C-1");
      expect((posts[0]?.args as { text: string }).text).toContain("Canvas tab");
      expect(deps.fake.of("pins.add")).toHaveLength(0);
      expect(checklistTs(deps)).toBeNull();
    });

    it("a re-role reuses the stored canvas id: no second create, one whole-body rewrite, no second pointer message", async () => {
      const deps = canvasMember();
      await surface.create(deps, "U1", rows(deps));
      await surface.reset(deps, "U1");
      await surface.create(deps, "U1", rows(deps));

      expect(deps.fake.of("conversations.canvases.create")).toHaveLength(1);
      const edits = deps.fake.of("canvases.edit").map((c) => c.args as { changes: Record<string, unknown>[] });
      expect(edits).toHaveLength(2);
      expect(edits.at(-1)?.changes[0]).not.toHaveProperty("section_id");
      expect(body(deps)).toHaveLength(8);
      expect(body(deps)[1]).toBe("- [ ] Step 1: Connect Claude to Slack");
      expect(deps.fake.of("chat.postMessage")).toHaveLength(1);
      expect(degraded(deps)).toHaveLength(0);
    });

    it("failCanvas at create degrades to the message surface: one canvas_degraded line, a pinned message, no canvas id", async () => {
      const deps = canvasMember();
      deps.fake.failCanvas = true;
      await expect(surface.create(deps, "U1", rows(deps))).resolves.toBe("message");

      expect(degraded(deps)).toHaveLength(1);
      expect(degraded(deps)[0]).toContain("canvas_disabled_for_team");
      expect(stored(deps)).toEqual({ checklist_canvas_id: null, canvas_surface: "message" });
      expect(checklistTs(deps)).toBe("100.001");
      expect(deps.fake.of("pins.add")).toHaveLength(1);
      expect(deps.fake.of("chat.postMessage")).toHaveLength(1);
    });

    it("Scenario 11: after the degrade a tick makes no canvas call and writes no second log line", async () => {
      const deps = canvasMember();
      deps.fake.failCanvas = true;
      await surface.create(deps, "U1", rows(deps));
      const before = canvasCalls(deps).length;
      tickRow(deps, "I1");
      await selectSurface(deps, "U1").update(deps, "U1", rows(deps));
      await surface.update(deps, "U1", rows(deps));

      expect(canvasCalls(deps)).toHaveLength(before);
      expect(degraded(deps)).toHaveLength(1);
      expect(deps.fake.of("chat.update")).toHaveLength(2);
    });

    it("channel_canvas_already_exists with no stored id degrades the same way", async () => {
      const deps = canvasMember();
      deps.fake.canvases["C-1"] = "F-existing";
      await expect(surface.create(deps, "U1", rows(deps))).resolves.toBe("message");
      expect(degraded(deps)).toHaveLength(1);
      expect(degraded(deps)[0]).toContain("channel_canvas_already_exists");
      expect(stored(deps)?.canvas_surface).toBe("message");
      expect(checklistTs(deps)).toBe("100.001");
    });

    it("a gone-channel error is logged, not thrown, and does not degrade", async () => {
      const deps = canvasMember();
      deps.slack.conversations.canvases.create = async () => {
        throw slackError("channel_not_found");
      };
      await expect(surface.create(deps, "U1", rows(deps))).resolves.toBe("message");
      expect(degraded(deps)).toHaveLength(0);
      expect(deps.logs.some((l) => l.includes("channel_not_found"))).toBe(true);
      expect(stored(deps)?.canvas_surface).toBeNull();
    });

    it("a member with no channel posts and creates nothing", async () => {
      const deps = makeDeps({ checklistSurface: "canvas" });
      deps.store.run("INSERT INTO member (member_id, started_by, role) VALUES ('U1', 'command', 'technical')");
      await expect(surface.create(deps, "U1", [])).resolves.toBe("message");
      expect(deps.fake.calls).toHaveLength(0);
      expect(deps.logs.some((l) => l.includes("checklist_no_channel"))).toBe(true);
    });
  });

  describe("update", () => {
    it("Scenario 10: with changed ids only those items are looked up and replaced, one lookup and one edit each, however many are already ticked", async () => {
      const deps = canvasMember();
      await surface.create(deps, "U1", rows(deps));
      for (const id of ["I1", "I2", "I3", "I4", "I5", "I6"]) tickRow(deps, id);
      await surface.update(deps, "U1", rows(deps), ["I1", "I2", "I3", "I4", "I5", "I6"]);
      const lookups = deps.fake.of("canvases.sections.lookup").length;
      const edits = deps.fake.of("canvases.edit").length;

      tickRow(deps, "I7");
      await surface.update(deps, "U1", rows(deps), ["I7"]);

      expect(deps.fake.of("canvases.sections.lookup")).toHaveLength(lookups + 1);
      expect(deps.fake.of("canvases.edit")).toHaveLength(edits + 1);
      expect(deps.fake.last("canvases.sections.lookup")).toEqual({ canvas_id: "F-1", criteria: { contains_text: label(deps, "I7") } });
      expect(body(deps).at(-1)).toBe(`- [x] ${label(deps, "I7")}`);
    });

    it("a tick that changes two items (I3 and I4) looks up and replaces exactly those two", async () => {
      const deps = canvasMember();
      await surface.create(deps, "U1", rows(deps));
      tickRow(deps, "I3");
      tickRow(deps, "I4");
      await surface.update(deps, "U1", rows(deps), ["I3", "I4"]);
      expect(deps.fake.of("canvases.sections.lookup")).toHaveLength(2);
      expect(deps.fake.of("canvases.edit")).toHaveLength(2);
      expect(body(deps).slice(3, 5).every((l) => l.startsWith("- [x] "))).toBe(true);
    });

    it("a changed id that is not ticked in the rows is skipped", async () => {
      const deps = canvasMember();
      await surface.create(deps, "U1", rows(deps));
      await surface.update(deps, "U1", rows(deps), ["I1"]);
      expect(deps.fake.of("canvases.edit")).toHaveLength(0);
    });

    it("with no changed list it falls back to every ticked item (lookup then replace each); the canvas shows [x] for ticked and [ ] for others; getContent is never used", async () => {
      const deps = canvasMember();
      await surface.create(deps, "U1", rows(deps));
      tickRow(deps, "I1");
      tickRow(deps, "I2");
      await surface.update(deps, "U1", rows(deps));

      expect(canvasCalls(deps).map((c) => c.method)).toEqual([
        "conversations.canvases.create",
        "canvases.sections.lookup",
        "canvases.edit",
        "canvases.sections.lookup",
        "canvases.edit",
      ]);
      const lookups = deps.fake.of("canvases.sections.lookup").map((c) => c.args);
      expect(lookups[0]).toEqual({ canvas_id: "F-1", criteria: { contains_text: "Step 1: Connect Claude to Slack" } });
      const edits = deps.fake.of("canvases.edit").map((c) => c.args as { canvas_id: string; changes: Record<string, unknown>[] });
      for (const e of edits) expect(e.changes).toHaveLength(1);
      expect(edits[0]?.changes[0]).toEqual({
        operation: "replace",
        section_id: "temp:F-1:1",
        document_content: { type: "markdown", markdown: "- [x] Step 1: Connect Claude to Slack" },
      });
      const lines = body(deps);
      expect(lines.slice(1, 3)).toEqual(["- [x] Step 1: Connect Claude to Slack", "- [x] Step 2: Connect Claude to Context Builder"]);
      expect(lines.slice(3).every((l) => l.startsWith("- [ ] "))).toBe(true);
      expect(lines[0]).toBe(`The glossary canvas: ${GLOSSARY}`);
      expect(deps.fake.calls.some((c) => /getContent|files\.info|bookmarks/.test(c.method))).toBe(false);
      expect(Object.keys(deps.slack.canvases)).not.toContain("getContent");
      expect(deps.fake.of("chat.update")).toHaveLength(0);
    });

    it("an update with nothing ticked makes no canvas call", async () => {
      const deps = canvasMember();
      await surface.create(deps, "U1", rows(deps));
      await surface.update(deps, "U1", rows(deps));
      expect(deps.fake.of("canvases.edit")).toHaveLength(0);
      expect(deps.fake.of("canvases.sections.lookup")).toHaveLength(0);
    });

    it("a lookup miss rewrites the whole canvas once from the store, ignoring what the canvas holds, and stops", async () => {
      const deps = canvasMember();
      await surface.create(deps, "U1", rows(deps));
      deps.fake.canvasBodies["F-1"] = "someone replaced everything";
      tickRow(deps, "I1");
      tickRow(deps, "I2");
      await surface.update(deps, "U1", rows(deps));

      expect(deps.fake.of("canvases.sections.lookup")).toHaveLength(1);
      const edits = deps.fake.of("canvases.edit").map((c) => c.args as { changes: Record<string, unknown>[] });
      expect(edits).toHaveLength(1);
      expect(edits[0]?.changes[0]).not.toHaveProperty("section_id");
      const lines = body(deps);
      expect(lines[0]).toBe(`The glossary canvas: ${GLOSSARY}`);
      expect(lines.slice(1, 3)).toEqual(["- [x] Step 1: Connect Claude to Slack", "- [x] Step 2: Connect Claude to Context Builder"]);
      expect(lines[3]).toBe("- [ ] Step 3: Set up a Claude Project");
      expect(degraded(deps)).toHaveLength(0);
    });

    it("canvas_editing_locked once: waits, retries the same change and succeeds without degrading", async () => {
      const deps = canvasMember();
      await surface.create(deps, "U1", rows(deps));
      tickRow(deps, "I1");
      deps.fake.lockOnce = true;
      await surface.update(deps, "U1", rows(deps));

      const edits = deps.fake.of("canvases.edit");
      expect(edits).toHaveLength(2);
      expect(edits[1]?.args).toEqual(edits[0]?.args);
      expect(body(deps)[1]).toBe("- [x] Step 1: Connect Claude to Slack");
      expect(degraded(deps)).toHaveLength(0);
    });

    it("a lock that persists is retried 3 times, does not degrade, logs canvas_locked once and does not throw; later updates retry the pending item", async () => {
      const deps = canvasMember();
      await surface.create(deps, "U1", rows(deps));
      tickRow(deps, "I1");
      const realEdit = deps.slack.canvases.edit;
      let locked = true;
      deps.slack.canvases.edit = async (args) => {
        if (locked) {
          deps.fake.calls.push({ method: "canvases.edit", args });
          throw slackError("canvas_editing_locked");
        }
        return realEdit(args);
      };
      await expect(surface.update(deps, "U1", rows(deps), ["I1"])).resolves.toBeUndefined();

      expect(deps.fake.of("canvases.edit")).toHaveLength(4);
      expect(degraded(deps)).toHaveLength(0);
      expect(deps.logs.filter((l) => l.includes("canvas_locked"))).toHaveLength(1);
      expect(stored(deps)?.canvas_surface).toBe("canvas");
      expect(body(deps)[1]).toBe("- [ ] Step 1: Connect Claude to Slack");

      locked = false;
      tickRow(deps, "I2");
      await surface.update(deps, "U1", rows(deps), ["I2"]);
      expect(body(deps).slice(1, 3)).toEqual(["- [x] Step 1: Connect Claude to Slack", "- [x] Step 2: Connect Claude to Context Builder"]);
      expect(degraded(deps)).toHaveLength(0);

      const before = deps.fake.of("canvases.edit").length;
      tickRow(deps, "I3");
      await surface.update(deps, "U1", rows(deps), ["I3"]);
      expect(deps.fake.of("canvases.edit")).toHaveLength(before + 1);
    });

    it("the lock backoff doubles between the 3 retries", async () => {
      const waits: number[] = [];
      const realSetTimeout = globalThis.setTimeout;
      const deps = canvasMember();
      const slow = makeCanvasSurface({ lockDelayMs: 10 });
      await slow.create(deps, "U1", rows(deps));
      tickRow(deps, "I1");
      deps.slack.canvases.edit = async () => {
        throw slackError("canvas_editing_locked");
      };
      globalThis.setTimeout = ((fn: () => void, ms?: number) => {
        waits.push(ms ?? 0);
        return realSetTimeout(fn, 0);
      }) as typeof setTimeout;
      try {
        await slow.update(deps, "U1", rows(deps), ["I1"]);
      } finally {
        globalThis.setTimeout = realSetTimeout;
      }
      expect(waits).toEqual([10, 20, 40]);
    });

    it("a lock on the first of two changed items leaves both pending, one canvas_locked line, and the next update writes both", async () => {
      const deps = canvasMember();
      await surface.create(deps, "U1", rows(deps));
      tickRow(deps, "I3");
      tickRow(deps, "I4");
      const realEdit = deps.slack.canvases.edit;
      deps.slack.canvases.edit = async () => {
        throw slackError("canvas_editing_locked");
      };
      await surface.update(deps, "U1", rows(deps), ["I3", "I4"]);
      expect(deps.logs.filter((l) => l.includes("canvas_locked"))).toHaveLength(1);
      expect(degraded(deps)).toHaveLength(0);

      deps.slack.canvases.edit = realEdit;
      tickRow(deps, "I5");
      await surface.update(deps, "U1", rows(deps), ["I5"]);
      expect(body(deps).slice(3, 6).every((l) => l.startsWith("- [x] "))).toBe(true);
    });

    it("an edit failure part-way degrades once: the message surface posts and pins the checklist from the store, later ticks make no canvas call", async () => {
      const deps = canvasMember();
      await surface.create(deps, "U1", rows(deps));
      tickRow(deps, "I1");
      tickRow(deps, "I2");
      const realEdit = deps.slack.canvases.edit;
      let n = 0;
      deps.slack.canvases.edit = async (args) => {
        if (++n === 2) throw slackError("canvas_editing_failed");
        return realEdit(args);
      };
      await expect(surface.update(deps, "U1", rows(deps))).resolves.toBeUndefined();

      expect(degraded(deps)).toHaveLength(1);
      expect(degraded(deps)[0]).toContain("canvas_editing_failed");
      expect(stored(deps)?.canvas_surface).toBe("message");
      expect(checklistTs(deps)).not.toBeNull();
      expect(deps.fake.of("pins.add")).toHaveLength(1);
      expect(JSON.stringify(deps.fake.last("chat.postMessage").blocks)).toContain("~1. Connect Claude to Slack~");

      const before = canvasCalls(deps).length;
      tickRow(deps, "I3");
      await selectSurface(deps, "U1").update(deps, "U1", rows(deps));
      expect(canvasCalls(deps)).toHaveLength(before);
      expect(degraded(deps)).toHaveLength(1);
      expect(deps.fake.of("chat.update")).toHaveLength(1);
    });

    it.each(["canvas_not_found", "canvas_deleted"])("a canvas deleted by a human (%s) degrades and does not throw", async (code) => {
      const deps = canvasMember();
      await surface.create(deps, "U1", rows(deps));
      tickRow(deps, "I1");
      deps.slack.canvases.sections.lookup = async () => {
        throw slackError(code);
      };
      await expect(surface.update(deps, "U1", rows(deps))).resolves.toBeUndefined();
      expect(degraded(deps)).toHaveLength(1);
      expect(degraded(deps)[0]).toContain(code);
      expect(checklistTs(deps)).not.toBeNull();
    });

    it("a gone-channel error is logged and swallowed without degrading", async () => {
      const deps = canvasMember();
      await surface.create(deps, "U1", rows(deps));
      tickRow(deps, "I1");
      deps.slack.canvases.sections.lookup = async () => {
        throw slackError("is_archived");
      };
      await expect(surface.update(deps, "U1", rows(deps))).resolves.toBeUndefined();
      expect(degraded(deps)).toHaveLength(0);
      expect(stored(deps)?.canvas_surface).toBe("canvas");
    });

    it("with no stored canvas id (and not degraded) it logs checklist_no_canvas and calls nothing", async () => {
      const deps = canvasMember();
      tickRow(deps, "I1");
      await expect(surface.update(deps, "U1", rows(deps))).resolves.toBeUndefined();
      expect(deps.fake.calls).toHaveLength(0);
      expect(deps.logs.some((l) => l.includes("checklist_no_canvas"))).toBe(true);
    });

    it("item titles with markdown characters go into contains_text unchanged", async () => {
      const deps = canvasMember();
      const first = deps.items.items.find((i) => i.id === "I1");
      if (first) first.name = "Connect *Claude* (to) [Slack] _now_";
      await surface.create(deps, "U1", rows(deps));
      tickRow(deps, "I1");
      await surface.update(deps, "U1", rows(deps));
      const args = deps.fake.of("canvases.sections.lookup")[0]?.args as { criteria: { contains_text: string } };
      expect(args.criteria.contains_text).toBe("Step 1: Connect *Claude* (to) [Slack] _now_");
      expect(body(deps)[1]).toBe("- [x] Step 1: Connect *Claude* (to) [Slack] _now_");
    });

    it("two ticks racing run one after the other: no call of the second starts before the first finishes", async () => {
      const deps = canvasMember();
      await surface.create(deps, "U1", rows(deps));
      tickRow(deps, "I1");
      const first = rows(deps);
      tickRow(deps, "I2");
      const second = rows(deps);
      const start = deps.fake.calls.length;
      const slowLookup = deps.slack.canvases.sections.lookup;
      deps.slack.canvases.sections.lookup = async (args) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return slowLookup(args);
      };
      await Promise.all([surface.update(deps, "U1", first, ["I1"]), surface.update(deps, "U1", second, ["I2"])]);

      expect(deps.fake.calls.slice(start).map((c) => c.method)).toEqual([
        "canvases.sections.lookup",
        "canvases.edit",
        "canvases.sections.lookup",
        "canvases.edit",
      ]);
      expect(body(deps).slice(1, 3)).toEqual(["- [x] Step 1: Connect Claude to Slack", "- [x] Step 2: Connect Claude to Context Builder"]);
    });
  });

  describe("reset", () => {
    it("replaces the whole canvas with the reset text and keeps the canvas id", async () => {
      const deps = canvasMember();
      await surface.create(deps, "U1", rows(deps));
      await surface.reset(deps, "U1");
      const args = deps.fake.last("canvases.edit") as unknown as { changes: Record<string, unknown>[] };
      expect(args.changes).toEqual([
        { operation: "replace", document_content: { type: "markdown", markdown: "Checklist reset. A new one follows when you choose your role." } },
      ]);
      expect(deps.fake.canvasBodies["F-1"]).toBe("Checklist reset. A new one follows when you choose your role.");
      expect(stored(deps)).toEqual({ checklist_canvas_id: "F-1", canvas_surface: "canvas" });
    });

    it("with no canvas it logs checklist_no_canvas and edits nothing", async () => {
      const deps = canvasMember();
      await surface.reset(deps, "U1");
      expect(deps.fake.calls).toHaveLength(0);
      expect(deps.logs.some((l) => l.includes("checklist_no_canvas"))).toBe(true);
    });

    it("on a degraded member it edits the message in place", async () => {
      const deps = canvasMember();
      deps.fake.failCanvas = true;
      await surface.create(deps, "U1", rows(deps));
      const before = canvasCalls(deps).length;
      await surface.reset(deps, "U1");
      expect(canvasCalls(deps)).toHaveLength(before);
      expect(deps.fake.last("chat.update").text).toContain("Checklist reset");
    });
  });
});

describe("both surface: the pinned message and the canvas together (CHECKLIST_SURFACE=both)", () => {
  const both = () => {
    const deps = makeDeps({ glossaryUrl: GLOSSARY, checklistSurface: "both" });
    deps.store.run("INSERT INTO member (member_id, started_by, dm_channel_id, channel_id, role) VALUES ('U1', 'command', 'D-U1', 'C-1', 'technical')");
    createRows(deps.store, deps.items, "U1", "technical");
    return deps;
  };
  const rows = (deps: ReturnType<typeof makeDeps>) => getRows(deps.store, "U1");
  const stored = (deps: ReturnType<typeof makeDeps>) =>
    deps.store.get<{ checklist_ts: string | null; checklist_canvas_id: string | null; canvas_surface: string | null }>(
      "SELECT checklist_ts, checklist_canvas_id, canvas_surface FROM member WHERE member_id = 'U1'",
    );

  it("selects the both surface for a new member, and for one stored as both; a member with a message checklist keeps it", () => {
    const deps = both();
    expect(selectSurface(deps, "U1")).not.toBe(messageSurface);
    deps.store.run("UPDATE member SET canvas_surface = 'both' WHERE member_id = 'U1'");
    expect(selectSurface(deps, "U1")).not.toBe(messageSurface);
    deps.store.run("UPDATE member SET canvas_surface = NULL, checklist_ts = '1.1' WHERE member_id = 'U1'");
    expect(selectSurface(deps, "U1")).toBe(messageSurface);
  });

  it("create posts and pins the message AND creates a titled canvas, with no pointer message, and stores both references", async () => {
    const deps = both();
    await expect(selectSurface(deps, "U1").create(deps, "U1", rows(deps))).resolves.toBe("canvas");
    expect(deps.fake.of("chat.postMessage")).toHaveLength(1); // the checklist only, no "Canvas tab" pointer
    expect(deps.fake.of("pins.add")).toHaveLength(1);
    expect(deps.fake.of("conversations.canvases.create")).toHaveLength(1);
    expect(deps.fake.of("conversations.canvases.create")[0]?.args).toMatchObject({ channel_id: "C-1", title: "Onboarding checklist" });
    expect(stored(deps)).toEqual({ checklist_ts: "100.001", checklist_canvas_id: "F-1", canvas_surface: "both" });
  });

  it("a tick updates the message and ticks the canvas line; reset resets both", async () => {
    const deps = both();
    await selectSurface(deps, "U1").create(deps, "U1", rows(deps));
    deps.store.run("UPDATE checklist_item SET status = 'ticked', method = 'observed' WHERE member_id = 'U1' AND item_id = 'I1'");
    await selectSurface(deps, "U1").update(deps, "U1", rows(deps), ["I1"]);
    expect(deps.fake.of("chat.update")).toHaveLength(1);
    expect(deps.fake.canvasBodies["F-1"]).toContain("- [x] Step 1: Connect Claude to Slack");
    await selectSurface(deps, "U1").reset(deps, "U1");
    expect(deps.fake.of("chat.update")).toHaveLength(2);
    expect(deps.fake.canvasBodies["F-1"]).toContain("Checklist reset");
  });

  it("a canvas failure drops only the canvas: one message, the member becomes message, later ticks still update the message", async () => {
    const deps = both();
    deps.fake.failCanvas = true;
    deps.slack.conversations.canvases.create = async () => {
      throw slackError("canvas_disabled_for_team");
    };
    await selectSurface(deps, "U1").create(deps, "U1", rows(deps));
    expect(deps.fake.of("chat.postMessage")).toHaveLength(1);
    expect(deps.fake.of("pins.add")).toHaveLength(1);
    expect(stored(deps)).toMatchObject({ checklist_ts: "100.001", canvas_surface: "message" });
    expect(deps.logs.filter((l) => l.includes("canvas_degraded"))).toHaveLength(1);
    await selectSurface(deps, "U1").update(deps, "U1", rows(deps), ["I1"]);
    expect(deps.fake.of("chat.update")).toHaveLength(1);
    expect(deps.fake.of("chat.postMessage")).toHaveLength(1); // no second message built
  });

  it("a message failure does not stop the canvas", async () => {
    const deps = both();
    deps.slack.chat.postMessage = async () => {
      throw slackError("ratelimited");
    };
    await expect(selectSurface(deps, "U1").create(deps, "U1", rows(deps))).rejects.toThrow();
    expect(stored(deps)).toMatchObject({ checklist_canvas_id: "F-1", canvas_surface: "both" });
  });
});

describe("canvas fallback: no channel canvas on this plan (both mode)", () => {
  const setup = (code?: string) => {
    const deps = makeDeps({ glossaryUrl: GLOSSARY, checklistSurface: "both", canvasUrl: (id) => `https://acme.slack.com/docs/T1/${id}` });
    deps.store.run("INSERT INTO member (member_id, started_by, dm_channel_id, channel_id, role) VALUES ('U1', 'command', 'D-U1', 'C-1', 'technical')");
    createRows(deps.store, deps.items, "U1", "technical");
    deps.fake.channelCanvasError = code;
    return deps;
  };
  const rows = (deps: ReturnType<typeof makeDeps>) => getRows(deps.store, "U1");
  const stored = (deps: ReturnType<typeof makeDeps>) =>
    deps.store.get<{ checklist_canvas_id: string | null; canvas_surface: string | null }>("SELECT checklist_canvas_id, canvas_surface FROM member WHERE member_id = 'U1'");

  it.each(["team_tier_cannot_create_channel_canvases", "free_team_canvas_tab_already_exists", "channel_canvas_already_exists"])(
    "%s: a standalone canvas is made, shared read-only to the channel, linked by a message and a bookmark, and stored",
    async (code) => {
      const deps = setup(code);
      await expect(selectSurface(deps, "U1").create(deps, "U1", rows(deps))).resolves.toBe("canvas");
      expect(deps.fake.of("canvases.create")).toHaveLength(1);
      expect(deps.fake.of("canvases.create")[0]?.args).toMatchObject({ title: "Onboarding checklist" });
      expect(deps.fake.of("canvases.access.set")[0]?.args).toEqual({ canvas_id: "F-S1", access_level: "read", channel_ids: ["C-1"] });
      const link = "https://acme.slack.com/docs/T1/F-S1";
      expect(deps.fake.of("chat.postMessage").some((c) => String(c.args.text).includes(link))).toBe(true);
      expect(deps.fake.of("bookmarks.add")[0]?.args).toMatchObject({ channel_id: "C-1", link, type: "link" });
      expect(stored(deps)).toEqual({ checklist_canvas_id: "F-S1", canvas_surface: "both" });
      expect(deps.logs.some((l) => l.includes("canvas_standalone") && l.includes(code))).toBe(true);
      expect(deps.fake.of("pins.add")).toHaveLength(1); // the pinned message is still there
    },
  );

  it("a tick then edits the standalone canvas by its id", async () => {
    const deps = setup("team_tier_cannot_create_channel_canvases");
    await selectSurface(deps, "U1").create(deps, "U1", rows(deps));
    deps.store.run("UPDATE checklist_item SET status = 'ticked', method = 'observed' WHERE member_id = 'U1' AND item_id = 'I1'");
    await selectSurface(deps, "U1").update(deps, "U1", rows(deps), ["I1"]);
    expect(deps.fake.canvasBodies["F-S1"]).toContain("- [x] Step 1: Connect Claude to Slack");
  });

  it("with no workspace link known the fallback is not tried: the canvas degrades and the message stays", async () => {
    const deps = setup("team_tier_cannot_create_channel_canvases");
    deps.canvasUrl = undefined;
    await selectSurface(deps, "U1").create(deps, "U1", rows(deps));
    expect(deps.fake.of("canvases.create")).toHaveLength(0);
    expect(stored(deps)).toMatchObject({ canvas_surface: "message" });
  });

  it("when the standalone canvas fails too, only the canvas degrades, once, with Slack's detail in the log", async () => {
    const deps = setup("team_tier_cannot_create_channel_canvases");
    deps.fake.failCanvas = true;
    deps.slack.canvases.create = async () => {
      throw Object.assign(new Error("An API error occurred: missing_scope"), { data: { error: "missing_scope", needed: "canvases:write", provided: "chat:write" } });
    };
    await selectSurface(deps, "U1").create(deps, "U1", rows(deps));
    const degraded = deps.logs.filter((l) => l.includes("canvas_degraded"));
    expect(degraded).toHaveLength(1);
    expect(degraded[0]).toContain("missing_scope");
    expect(degraded[0]).toContain("needed=canvases:write");
    expect(stored(deps)).toMatchObject({ canvas_surface: "message" });
    expect(deps.fake.of("pins.add")).toHaveLength(1);
  });
});

describe("canvas creation retries (canvas_creation_failed from Slack)", () => {
  const setup = () => {
    const deps = makeDeps({ glossaryUrl: GLOSSARY, checklistSurface: "both", canvasUrl: (id) => `https://acme.slack.com/docs/T1/${id}` });
    deps.store.run("INSERT INTO member (member_id, started_by, dm_channel_id, channel_id, role) VALUES ('U1', 'command', 'D-U1', 'C-1', 'technical')");
    createRows(deps.store, deps.items, "U1", "technical");
    return deps;
  };
  const rows = (deps: ReturnType<typeof makeDeps>) => getRows(deps.store, "U1");

  it("no canvas line starts a nested numbered list: each is `- [ ] Step N: name`", async () => {
    const deps = setup();
    await selectSurface(deps, "U1").create(deps, "U1", rows(deps));
    const lines = (deps.fake.canvasBodies["F-1"] ?? "").split("\n").slice(1);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(/^- \[ \] Step \d: \S/);
  });

  it("a refused title is retried once without it, and the canvas is made as a channel canvas", async () => {
    const deps = setup();
    const create = deps.slack.conversations.canvases.create;
    deps.slack.conversations.canvases.create = async (args) => {
      if (args.title) throw slackError("canvas_creation_failed");
      return create(args);
    };
    await selectSurface(deps, "U1").create(deps, "U1", rows(deps));
    expect(deps.fake.of("canvases.create")).toHaveLength(0); // no standalone fallback needed
    expect(deps.logs.some((l) => l.includes("canvas_retry_untitled"))).toBe(true);
    expect(deps.store.get("SELECT canvas_surface FROM member WHERE member_id = 'U1'")).toEqual({ canvas_surface: "both" });
  });
});
