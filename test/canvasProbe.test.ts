import { describe, expect, it } from "vitest";
import { handleOnboard } from "../src/start.js";
import { makeDeps } from "./helpers.js";

describe("/onboard-ch canvas-probe", () => {
  it("is for operators: a member gets a refusal and no Slack call", async () => {
    const deps = makeDeps();
    const reply = await handleOnboard(deps, { callerId: "U9", text: "canvas-probe" });
    expect(reply).toContain("for operators");
    expect(deps.fake.calls).toHaveLength(0);
  });

  it("makes one standalone canvas per variant, deletes each, and says Slack accepts all", async () => {
    const deps = makeDeps();
    const reply = await handleOnboard(deps, { callerId: "UOP1", text: "canvas-probe" });
    expect(deps.fake.of("canvases.create")).toHaveLength(6);
    expect(deps.fake.of("canvases.delete")).toHaveLength(6);
    expect(reply).toContain("the content is not the problem");
    expect(reply.match(/:white_check_mark:/g)).toHaveLength(6);
  });

  it("names the variants Slack refuses and says which to change", async () => {
    const deps = makeDeps();
    deps.fake.refuseCanvasContaining = ["- [ ] 1. Test"];
    const reply = await handleOnboard(deps, { callerId: "UOP1", text: "canvas-probe" });
    expect(reply).toContain(":x: task list with `1.` labels: *canvas_creation_failed*");
    expect(reply).toContain("accepts some variants");
    expect(reply.match(/:x:/g)).toHaveLength(1);
  });

  it("says canvases are unavailable when even the empty canvas is refused, and touches no member or channel", async () => {
    const deps = makeDeps();
    deps.fake.failCanvas = true;
    const reply = await handleOnboard(deps, { callerId: "UOP1", text: "canvas-probe" });
    expect(reply).toContain("canvases are not available");
    expect(deps.fake.of("canvases.delete")).toHaveLength(0);
    expect(deps.fake.of("chat.postMessage")).toHaveLength(0);
    expect(deps.fake.of("conversations.create")).toHaveLength(0);
  });

  it("reports a canvas it could not delete without failing the probe", async () => {
    const deps = makeDeps();
    deps.fake.failCanvasDelete = true;
    const reply = await handleOnboard(deps, { callerId: "UOP1", text: "canvas-probe" });
    expect(reply).toContain("not deleted (no_permission)");
  });
});
