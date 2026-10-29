import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { getMetrics } from "./aggregate.js";
import type { ItemsConfig } from "./checklist.js";
import type { Store } from "./store.js";

const PUBLIC = new URL("../public/", import.meta.url);
const FILES: Record<string, [string, string]> = {
  "/": ["dashboard.html", "text/html; charset=utf-8"],
  "/dashboard.js": ["dashboard.js", "text/javascript; charset=utf-8"],
};

/** Aggregate metrics and the page. Counts only, no member id in any response (FR-DB-004). Listen on 127.0.0.1 only (A-DB-002). */
export function createDashboardServer(store: Store, config: ItemsConfig): Server {
  return createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] as string;
    try {
      if (path === "/api/metrics") {
        const body = JSON.stringify(getMetrics(store, config));
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(body);
        return;
      }
      if (path === "/favicon.ico") {
        res.writeHead(204).end();
        return;
      }
      const file = FILES[path];
      if (!file) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "content-type": file[1] }).end(readFileSync(new URL(file[0], PUBLIC)));
    } catch (error) {
      console.error("[dashboard] request failed:", error);
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "metrics unavailable" }));
    }
  });
}

export const listenOnLocalhost = (server: Server, port: number) =>
  new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
