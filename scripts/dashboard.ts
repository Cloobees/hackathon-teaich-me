import "dotenv/config";
import { loadItems } from "../src/checklist.js";
import { createDashboardServer, listenOnLocalhost } from "../src/dashboardServer.js";
import { log } from "../src/log.js";
import { openStore } from "../src/store.js";

// The dashboard alone, with no Slack tokens: `npm run seed`, then `npm run dashboard`.
const port = Number(process.env.DASHBOARD_PORT) || 3000;
await listenOnLocalhost(createDashboardServer(openStore(process.env.DB_PATH || "state/copilot.db"), loadItems()), port);
log("dashboard", { url: `http://127.0.0.1:${port}/` });
