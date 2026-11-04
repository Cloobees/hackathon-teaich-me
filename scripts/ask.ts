import "dotenv/config";
import { answer } from "../src/assist.js";
import { createRows, loadItems } from "../src/checklist.js";
import { selectClaudeClient } from "../src/claudeClient.js";
import { log } from "../src/log.js";
import { openStore, type Role } from "../src/store.js";

// `npm run ask -- "How do I connect Claude to Context Builder?"` asks the library through the real model (BP-028).
// `--role technical --ticked I1,I2` seeds an in-memory member first, so the reply ends with that member's next item (BP-054).
const USAGE = 'Usage: npm run ask -- [--role technical|non-technical] [--ticked I1,I2] "<question>"';
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const [, value] = args.splice(at, 2);
  if (!value) throw new Error(USAGE);
  return value;
};
const role = flag("--role") as Role | undefined;
const ticked = flag("--ticked")?.split(",").map((id) => id.trim()).filter(Boolean) ?? [];
const question = args.join(" ").trim();
if (!question || (role && role !== "technical" && role !== "non-technical") || (ticked.length && !role)) throw new Error(USAGE);

const store = openStore(":memory:");
const items = loadItems();
if (role) {
  store.run("INSERT INTO member (member_id, role, started_by) VALUES ('ask', ?, 'command')", role);
  const ids = createRows(store, items, "ask", role).map((item) => item.id);
  for (const id of ticked) {
    if (!ids.includes(id)) throw new Error(`${id} is not an item for ${role}`);
    store.run("UPDATE checklist_item SET status = 'ticked' WHERE member_id = 'ask' AND item_id = ?", id);
  }
}
const reply = await answer(
  {
    store,
    slack: undefined as never,
    items,
    libraryDir: process.env.LIBRARY_DIR || "library",
    now: () => new Date().toISOString(),
    log,
    operators: [],
  },
  selectClaudeClient(),
  { question, memberId: role ? "ask" : undefined },
);
console.log(reply);
