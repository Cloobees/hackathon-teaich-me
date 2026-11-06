import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createDashboardServer, listenOnLocalhost } from "../src/dashboardServer.js";
import { getMetrics } from "../src/aggregate.js";
import { createRows, loadItems, tick } from "../src/checklist.js";
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

  it("shows the same figures whether channel columns are populated or null, and no channel, member id, name or email (Scenario 28, FR-CH-025)", async () => {
    // The same members and ticks in two stores: one with all five channel columns set (varied states), one with them null.
    const members = [
      { id: "U0CHAN001", role: "technical", ticked: 6, state: "active", name: "ada-lovelace" },
      { id: "U0CHAN002", role: "technical", ticked: 3, state: "member_left", name: "grace-hopper" },
      { id: "U0CHAN003", role: "non-technical", ticked: 5, state: "lost", name: "alan-turing" },
      { id: "U0CHAN004", role: "non-technical", ticked: 1, state: "active", name: "edsger-dijkstra" },
    ] as const;
    const build = (withChannels: boolean) => {
      const store = openStore(":memory:");
      seedCohort(store, config, () => "2026-10-26T10:00:00.000Z");
      for (const m of members) {
        store.run("INSERT INTO member (member_id, role, role_chosen_at, seeded) VALUES (?, ?, '2026-10-26T10:00:00.000Z', 0)", m.id, m.role);
        createRows(store, config, m.id, m.role)
          .slice(0, m.ticked)
          .forEach((item) => tick(store, config, m.id, item.id, "self-attested", null, () => "2026-10-26T11:00:00.000Z"));
        if (withChannels) {
          store.run(
            "UPDATE member SET channel_id = ?, channel_name = ?, channel_state = ?, checklist_canvas_id = ?, canvas_surface = 'canvas' WHERE member_id = ?",
            `C0${m.id}`,
            `onboarding-copilot-${m.name}`,
            m.state,
            `F0${m.id}`,
            m.id,
          );
        }
      }
      return store;
    };
    const withChannels = build(true);
    const without = build(false);
    expect(withChannels.all("SELECT * FROM member WHERE channel_id IS NOT NULL")).toHaveLength(members.length);
    expect(without.all("SELECT * FROM member WHERE channel_id IS NOT NULL")).toHaveLength(0);
    expect(getMetrics(withChannels, config)).toEqual(getMetrics(without, config));
    expect(getMetrics(withChannels, config).groups.all.started).toEqual({ total: 24, seeded: 20 });

    const { base } = await serve(withChannels);
    const metrics = await (await fetch(`${base}/api/metrics`)).text();
    const baseline = (await serve(without)).base;
    expect(metrics).toBe(await (await fetch(`${baseline}/api/metrics`)).text());
    for (const m of members) {
      for (const secret of [m.id, `C0${m.id}`, `F0${m.id}`, m.name, m.state]) expect(metrics).not.toContain(secret);
    }
    expect(metrics).not.toContain("onboarding-copilot");
    expect(metrics).not.toContain("@");
    // Item names may say "channel" (I6 joins the help channel); no field or value may name a member channel.
    expect(metrics).not.toMatch(/member_id|email|channel_|canvas|"C0|"F0/i);
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
