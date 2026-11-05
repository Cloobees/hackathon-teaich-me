import { errorCode } from "./channel.js";
import { detailOf } from "./checklistSurfaceCanvas.js";
import type { Deps } from "./deps.js";

export const PROBE_OPERATOR_ONLY = "The canvas probe is for operators.";

interface Variant {
  name: string;
  args: { title?: string; document_content?: { type: "markdown"; markdown: string } };
}

const md = (markdown: string) => ({ type: "markdown" as const, markdown });

/** From the plainest canvas to the one the checklist builds, so the first failure names what Slack refuses. */
const VARIANTS: Variant[] = [
  { name: "empty canvas, no title", args: {} },
  { name: "title only", args: { title: "Probe" } },
  { name: "title and plain text", args: { title: "Probe", document_content: md("Hello") } },
  { name: "title and a task list", args: { title: "Probe", document_content: md("- [ ] Step 1: Test\n- [ ] Step 2: Test") } },
  { name: "task list with `1.` labels", args: { title: "Probe", document_content: md("- [ ] 1. Test\n- [ ] 2. Test") } },
  { name: "link line then task list (the checklist's shape)", args: { title: "Probe", document_content: md("The glossary canvas: https://example.com/g\n- [ ] Step 1: Test\n- [ ] Step 2: Test") } },
];

/**
 * `/onboard-ch canvas-probe` (operators): makes one standalone canvas per variant with `canvases.create`, records whether Slack
 * accepted it, and deletes each canvas it made. The reply lists every variant with its result, so one run shows whether canvases
 * work here at all and which content or title Slack refuses. It touches no member, channel or checklist.
 */
export async function runCanvasProbe(deps: Deps, callerId: string): Promise<string> {
  if (!deps.operators.includes(callerId)) {
    deps.log("canvas_probe_refused", { member: callerId, outcome: "not_operator" });
    return PROBE_OPERATOR_ONLY;
  }
  const lines: string[] = [];
  for (const variant of VARIANTS) {
    try {
      const id = (await deps.slack.canvases.create(variant.args)).canvas_id;
      if (!id) throw new Error("no_canvas_id");
      let cleaned = "deleted";
      try {
        await deps.slack.canvases.delete({ canvas_id: id });
      } catch (error) {
        cleaned = `not deleted (${errorCode(error)})`;
      }
      deps.log("canvas_probe", { variant: variant.name, outcome: "ok", cleaned });
      lines.push(`:white_check_mark: ${variant.name}: accepted, ${cleaned}`);
    } catch (error) {
      const code = errorCode(error);
      const detail = detailOf(error);
      deps.log("canvas_probe", { variant: variant.name, outcome: code, detail });
      lines.push(`:x: ${variant.name}: *${code}*${detail ? ` (${detail})` : ""}`);
    }
  }
  const failed = lines.filter((l) => l.startsWith(":x:")).length;
  const verdict =
    failed === 0
      ? "Slack accepts every variant, so the content is not the problem."
      : failed === VARIANTS.length
        ? "Slack refuses every variant, even an empty canvas: canvases are not available to this app or workspace."
        : "Slack accepts some variants and refuses others: the first refused one above is what to change.";
  return `Canvas probe (standalone canvases, each deleted afterwards):\n${lines.join("\n")}\n${verdict}`;
}
