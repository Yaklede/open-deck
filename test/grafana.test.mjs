import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import {
  GrafanaMonitor,
  parseGrafanaMetrics,
  grafanaSource,
  grafanaSecretId,
} from "../host/grafana.mjs";
import { createHost, deviceConfig } from "../host/server.mjs";
import { defaultConfig } from "../host/config.mjs";
const now = 1792627861000;
const frame = (name, values, labels = {}) => ({
  schema: {
    fields: [
      { name: "Time", type: "time" },
      { name, type: "number", labels },
    ],
  },
  data: { values: [[now - 120000, now - 60000, now], values] },
});
const response = () => ({
  results: {
    A: {
      status: 200,
      frames: [
        frame("mariadb-0", [0.1, 0.2, 0.15]),
        frame("mariadb-1", [0.3, 0.25, 0.4]),
      ],
    },
    B: { status: 200, frames: [frame("TPS", [1, 2, 0])] },
  },
});
const widget = () => ({
  id: "db",
  type: "grafana",
  url: "https://grafana.example/d/system?var-project=wrong",
  auth: true,
  projects: [
    { label: "A", value: "alpha" },
    { label: "B", value: "beta" },
  ],
  defaultProject: "alpha",
});
const dashboard = {
  panels: [
    {
      id: 1,
      datasource: { uid: "gcm", type: "stackdriver" },
      fieldConfig: { defaults: { unit: "percentunit" } },
      targets: [{ metricQuery: { filters: ["namespace", "=", "${project}"] } }],
    },
    {
      id: 2,
      datasource: { uid: "mimir", type: "prometheus" },
      targets: [{ expr: 'sum(rate(commits{namespace="${project}"}[5m]))' }],
    },
  ],
};
const settle = async (predicate) => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw Error("Timed out");
};
test("system CPU stays separate from DB CPU and a failed exporter prevents a healthy DB badge", () => {
  const raw = response();
  raw.results.C = { frames: [frame("ready", [1, 1, 1])] };
  raw.results.D = {
    frames: [frame("Value", [0.01, 0.02, 0.03], { job: "backend" })],
  };
  raw.results.E = {
    frames: [
      frame("up", [1, 1, 1], { job: "backend" }),
      frame("up", [1, 1, 0], { job: "mariadb-exporter", pod: "db-0" }),
    ],
  };
  raw.results.F = {
    frames: [
      frame("connections", [10, 20, 30]),
      frame("connections", [3, 4, 5]),
    ],
  };
  const data = parseGrafanaMetrics(raw, now);
  assert.equal(data.cpu.value, 40);
  assert.equal(data.system.value, 3);
  assert.equal(data.system.nodes[0].name, "backend");
  assert.deepEqual(data.collection, { healthy: 1, total: 2 });
  assert.equal(data.database.ready, false);
  assert.equal(data.database.connections, 35);
});
test("DB QPS sums per-node query rates, memory uses the highest node and missing samples stay unknown", () => {
  const raw = response();
  raw.results.G = {
    frames: [frame("db-0", [10, 20, 0]), frame("db-1", [3, 4, 5])],
  };
  raw.results.H = {
    frames: [frame("db-0", [0.1, 0.2, 0.3]), frame("db-1", [0.3, 0.4, 0.2])],
  };
  const data = parseGrafanaMetrics(raw, now);
  assert.equal(data.qps.value, 5);
  assert.deepEqual(
    data.qps.points.map((p) => p[1]),
    [13, 24, 5],
  );
  assert.equal(data.memory.value, 30);
  assert.equal(data.memory.nodes.length, 2);
  assert.equal(parseGrafanaMetrics(response(), now).qps.value, null);
  assert.equal(parseGrafanaMetrics(response(), now).memory.value, null);
});
test("two native cards for one project reuse the same collected result", async (t) => {
  let posts = 0;
  const a = widget(),
    b = {
      ...widget(),
      id: "system",
      metric: "system",
      projectGroup: "monitor",
    };
  const monitor = new GrafanaMonitor(
    () => ({ pages: [{ widgets: [a, b] }] }),
    () => {},
    {
      clock: () => now,
      secret: async () => "PRIVATE_TOKEN",
      fetcher: async (url) => {
        if (url.includes("dashboards")) return Response.json({ dashboard });
        posts++;
        return Response.json(response());
      },
    },
  );
  t.after(() => monitor.close());
  monitor.tick();
  await settle(() => monitor.active === 0);
  assert.equal(posts, 2);
  assert.deepEqual(
    monitor.state().widgets.db.projects.alpha,
    monitor.state().widgets.system.projects.alpha,
  );
});
test("Grafana native metrics preserve real zero, normalize CPU ratios and aggregate history without adding TPS series", () => {
  const data = parseGrafanaMetrics(response(), now);
  assert.equal(data.cpu.value, 40);
  assert.deepEqual(
    data.cpu.nodes.map((r) => r.value),
    [15, 40],
  );
  assert.equal(data.tps.value, 0);
  assert.deepEqual(
    data.cpu.points.map((p) => p[1]),
    [30, 25, 40],
  );
  const missing = response();
  missing.results.A.frames = [];
  missing.results.B.frames = [];
  assert.equal(parseGrafanaMetrics(missing, now).tps.value, null);
  assert.equal(parseGrafanaMetrics(missing, now).cpu.value, null);
  const old = response();
  for (const x of Object.values(old.results))
    for (const f of x.frames)
      f.data.values[0] = f.data.values[0].map((t) => t - 600000);
  assert.equal(parseGrafanaMetrics(old, now).cpu.value, null);
  const bad = response();
  bad.results.B.error = "PRIVATE_ERROR";
  assert.throws(() => parseGrafanaMetrics(bad, now), /QUERY/);
  const duplicate = response();
  duplicate.results.B.frames.push(frame("other", [1, 2, 3]));
  assert.throws(() => parseGrafanaMetrics(duplicate, now), /TPS_SERIES/);
});
test("project queries are isolated, authenticated only on the Mac and cached with missing/stale/error states", async (t) => {
  let time = now,
    calls = [],
    closed = 0;
  const w = widget();
  const monitor = new GrafanaMonitor(
    () => ({ pages: [{ widgets: [w] }] }),
    () => closed++,
    {
      clock: () => time,
      secret: async () => "PRIVATE_TOKEN",
      fetcher: async (url, init) => {
        assert.equal(init.redirect, "error");
        assert.equal(init.headers.Authorization, "Bearer PRIVATE_TOKEN");
        calls.push({ url, init });
        if (url.includes("dashboards")) return Response.json({ dashboard });
        const body = JSON.parse(init.body);
        assert.equal(body.queries[0].refId, "A");
        assert.equal(body.queries[1].refId, "B");
        const namespace = body.queries[0].metricQuery.filters[2];
        assert(["alpha", "beta"].includes(namespace));
        assert(body.queries[1].expr.includes('namespace="' + namespace + '"'));
        assert(!JSON.stringify(body).includes("wrong"));
        return Response.json(
          namespace === "alpha"
            ? response()
            : { results: { A: { frames: [] }, B: { frames: [] } } },
        );
      },
    },
  );
  t.after(() => monitor.close());
  monitor.tick();
  await settle(() => closed === 2);
  assert.equal(monitor.state().widgets.db.projects.alpha.tps.value, 0);
  assert.equal(monitor.state().widgets.db.projects.beta.tps.value, null);
  const n = calls.length;
  monitor.tick();
  assert.equal(calls.length, n);
  assert(!JSON.stringify(monitor.state()).includes("PRIVATE_TOKEN"));
  time += 91000;
  assert.equal(monitor.state().widgets.db.projects.alpha.status, "stale");
  monitor.fetcher = async () => new Response("PRIVATE_BODY", { status: 403 });
  monitor.tick();
  await settle(() => closed === 4);
  const state = monitor.state();
  assert.equal(state.widgets.db.projects.alpha.status, "error");
  assert(!JSON.stringify(state).includes("PRIVATE"));
  assert.equal(state.widgets.db.projects.alpha.cpu, undefined);
});
test("dashboard address validation and device snapshots exclude Grafana connection details", () => {
  assert.throws(() =>
    grafanaSource({ ...widget(), url: "http://grafana.example/d/system" }),
  );
  assert.throws(() =>
    grafanaSource({ ...widget(), url: "https://u:p@grafana.example/d/system" }),
  );
  assert.throws(() =>
    grafanaSource({ ...widget(), url: "https://grafana.example/anything" }),
  );
  assert.equal(grafanaSecretId("https://grafana.example").length, 32);
  const c = defaultConfig();
  c.pages[0].widgets.push(widget());
  const exposed = deviceConfig(c).pages[0].widgets.at(-1);
  assert.equal(exposed.url, undefined);
  assert.equal(exposed.auth, undefined);
  assert.equal(exposed.projects.length, 2);
});
test("paired snapshots expose native metrics while LAN cannot store a Grafana credential", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-grafana-"));
  const c = defaultConfig();
  c.pages.push({
    id: "db-monitor",
    name: "Monitor",
    columns: 2,
    rows: 2,
    widgets: [
      { ...widget(), label: "DB", x: 0, y: 0, w: 2, h: 2, color: "#efb17c" },
    ],
  });
  fs.writeFileSync(path.join(dir, "deck.json"), JSON.stringify(c));
  const h = createHost({
    dir,
    metrics: false,
    wifi: true,
    wifiPort: 0,
    grafanaOptions: {
      clock: () => now,
      secret: async () => "PRIVATE_TOKEN",
      fetcher: async (url) =>
        Response.json(url.includes("dashboards") ? { dashboard } : response()),
    },
  });
  await new Promise((r) => h.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await h.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = "http://127.0.0.1:" + h.server.address().port;
  const template = await fetch(base + "/monitor-layout.mjs", {
    headers: { "X-Open-Deck-Admin": h.adminKey },
  });
  assert.equal(template.status, 200);
  assert.match(template.headers.get("content-type"), /javascript/);
  assert((await template.text()).includes("projectGroup"));
  assert.equal((await fetch(base + "/monitor-layout.mjs")).status, 401);
  const unauthorized = await fetch(base + "/api/snapshot");
  assert.equal(unauthorized.status, 401);
  const pair = await (
    await fetch(base + "/api/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: h.getPin() }),
    })
  ).json();
  h.engine.grafana.tick();
  await settle(
    () => h.engine.grafana.state().widgets.db.projects.alpha.status === "ready",
  );
  const snap = await (
    await fetch(base + "/api/snapshot", {
      headers: { Authorization: "Bearer " + pair.token },
    })
  ).json();
  assert.equal(snap.state.grafana.widgets.db.projects.alpha.cpu.value, 40);
  assert(!JSON.stringify(snap).includes("PRIVATE_TOKEN"));
  assert(!JSON.stringify(snap.config).includes("grafana.example"));
  const write = await fetch(base + "/api/admin/grafana-token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + pair.token,
    },
    body: JSON.stringify({ widgetId: "db", token: "never stored" }),
  });
  assert.equal(write.status, 403);
  if (!h.lanServer.listening)
    await new Promise((r) => h.lanServer.once("listening", r));
  const status = await new Promise((resolve, reject) => {
    // Isolated fixture certificate only; production clients pin the real host certificate.
    const req = https.request(
      {
        hostname: "127.0.0.1",
        port: h.lanServer.address().port,
        path: "/api/admin/grafana-token",
        method: "POST",
        rejectUnauthorized: false,
        headers: {
          "X-Open-Deck-Admin": h.adminKey,
          "Content-Type": "application/json",
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ widgetId: "db", token: "never stored" }));
  });
  assert.equal(status, 403);
});
