import { describe, expect, it } from "vitest";
import { applyTick, instructionButtons } from "../src/checklistMessage.js";
import { makeDeps, onboard } from "./helpers.js";

type Button = { type: string; action_id: string; value: string; confirm?: Record<string, unknown>; text: { text: string } };
const ITEMS = makeDeps().items.items;
const ids = (item: (typeof ITEMS)[number]) => (instructionButtons(item) as Button[]).map((b) => b.action_id);

describe("instructionButtons (FR-VF-001, FR-VF-002, FR-VF-011)", () => {
  it("gives every item I1 to I7 an I did it button with a confirm object and action_id attest_<id>", () => {
    expect(ITEMS.map((i) => i.id)).toEqual(["I1", "I2", "I3", "I4", "I5", "I6", "I7"]);
    for (const item of ITEMS) {
      const attest = (instructionButtons(item) as Button[]).find((b) => b.action_id === `attest_${item.id}`);
      expect(attest, item.id).toMatchObject({ type: "button", value: item.id, text: { text: "I did it" } });
      expect(attest?.confirm).toMatchObject({ confirm: { text: "Yes, I did it" }, deny: { text: "Cancel" } });
    }
  });

  it("gives every item exactly one button, I did it, and no check button on I2, I4 or I6 (FR-VF-001)", () => {
    for (const item of ITEMS) expect(ids(item), item.id).toEqual([`attest_${item.id}`]);
  });

  it("a posted instruction message carries the buttons for its item, in an actions block", async () => {
    const deps = makeDeps();
    await onboard(deps, "U1", "technical");
    for (const item of ITEMS.slice(0, 6)) {
      const posted = deps.fake.of("chat.postMessage").at(-1)?.args.blocks as { type: string; elements?: unknown[] }[];
      expect(posted.filter((b) => b.type === "actions")).toEqual([{ type: "actions", elements: instructionButtons(item) }]);
      await applyTick(deps, "U1", item.id, "self-attested", null);
    }
  });
});
