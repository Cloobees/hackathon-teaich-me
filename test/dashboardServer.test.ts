import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createDashboardServer, listenOnLocalhost } from "../src/dashboardServer.js";
import { loadItems } from "../src/checklist.js";
import { seedCohort } from "../src/seedCohort.js";
import { openStore, type Store } from "../src/store.js";

const config = loadItems();
const open: { close: () => void }[] = [];
afterEach(() => open.splice(0).forEach((s) => s.close()));

async function serve(store: Store) {
  const server = createDashboardServer(store, config);
  await listenOnLocalhost(server, 0);
  open.push(server);
  const { address, port } = server.address() as AddressInfo;
  return { address, base: `http://127.0.0.1:${port}` };
}

describe("dashboard server", () => {
  it("holds no member id, name or email in the metrics or the page (Scenario 2)", async () => {
    const store = openStore(":memory:");
    store.run("INSERT INTO member (member_id, role, seeded) VALUES ('U0SAMPLE1', 'technical', 0)");
    store.run("INSERT INTO checklist_item (member_id, item_id, status, method) VALUES ('U0SAMPLE1', 'I1', 'ticked', 'observed')");
    seedCohort(store, config, () => "2026-10-26T10:00:00.000Z");
    const { base } = await serve(store);

    const metrics = await (await fetch(`${base}/api/metrics`)).text();
    const page = await (await fetch(`${base}/`)).text();
    const script = await (await fetch(`${base}/dashboard.js`)).text();
    for (const body of [metrics, page, script]) {
      expect(body).not.toContain("U0SAMPLE1");
      expect(body).not.toContain("SEED-");
      expect(body).not.toContain("@");
    }
    expect(JSON.parse(metrics).groups.all.started.total).toBe(21);
  });

  it("listens on 127.0.0.1 only (A-DB-002)", async () => {
    const { address } = await serve(openStore(":memory:"));
    expect(address).toBe("127.0.0.1");
  });

  it("a store error returns an error response, not zero counts", async () => {
    const store = openStore(":memory:");
    const { base } = await serve({ ...store, all: () => { throw new Error("db locked"); } });
    const res = await fetch(`${base}/api/metrics`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "metrics unavailable" });
  });

  it("an unknown path is a 404", async () => {
    const { base } = await serve(openStore(":memory:"));
    expect((await fetch(`${base}/etc/passwd`)).status).toBe(404);
    expect((await fetch(`${base}/favicon.ico`)).status).toBe(204);
  });
});
