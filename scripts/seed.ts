import "dotenv/config";
import { loadItems } from "../src/checklist.js";
import { log } from "../src/log.js";
import { seedCohort } from "../src/seedCohort.js";
import { openStore } from "../src/store.js";

// Reset for a rehearsal: delete the store file, then run this (DD-EN-003).
const dbPath = process.env.DB_PATH || "state/copilot.db";
const store = openStore(dbPath);
const count = seedCohort(store, loadItems(), () => new Date().toISOString());
store.close();
log("seeded", { members: count, db: dbPath });
