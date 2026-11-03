import "dotenv/config";
import { loadItems } from "../src/checklist.js";
import { log } from "../src/log.js";
import { seedCohort } from "../src/seedCohort.js";
import { openStore } from "../src/store.js";

// A rehearsed account is cleared by `/onboard reset`, which leaves these rows alone. Deleting the store file and running this is a full wipe only (DD-EN-003).
const dbPath = process.env.DB_PATH || "state/copilot.db";
const store = openStore(dbPath);
const count = seedCohort(store, loadItems(), () => new Date().toISOString());
store.close();
log("seeded", { members: count, db: dbPath });
