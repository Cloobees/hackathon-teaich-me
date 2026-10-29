import "dotenv/config";
import { answer } from "../src/assist.js";
import { loadItems } from "../src/checklist.js";
import { selectClaudeClient } from "../src/claudeClient.js";
import { log } from "../src/log.js";
import { openStore } from "../src/store.js";

// `npm run ask -- "How do I connect Claude to Context Builder?"` asks the library through the real model (BP-028).
const question = process.argv.slice(2).join(" ").trim();
if (!question) throw new Error('Usage: npm run ask -- "<question>"');
const reply = await answer(
  {
    store: openStore(":memory:"),
    slack: undefined as never,
    items: loadItems(),
    libraryDir: process.env.LIBRARY_DIR || "library",
    now: () => new Date().toISOString(),
    log,
    operators: [],
  },
  selectClaudeClient(),
  { question },
);
console.log(reply);
