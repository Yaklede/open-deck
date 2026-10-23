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
  sourceTimestampQuery,
  freshnessStatus,
  grafanaServicePlan,
} from "../host/grafana.mjs";
import { createHost, deviceConfig } from "../host/server.mjs";
import { defaultConfig, validateConfig } from "../host/config.mjs";
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
const countExpr = 'sum by (job) (rate(http_server_requests_seconds_count{namespace="${project}"}[5m]))';
const sumExpr = 'sum by (job) (rate(http_server_requests_seconds_sum{namespace="${project}"}[5m]))';
const errorExpr = 'sum by (job) (rate(http_server_requests_seconds_count{namespace="${project}",status=~"5.."}[5m]))';
const servicePanels = () => [
  { id: 11, title: "HTTP requests", datasource: { uid: "mimir", type: "prometheus" }, fieldConfig: { defaults: { unit: "reqps" } }, targets: [{ expr: countExpr }] },
  { id: 12, title: "HTTP mean latency", datasource: { uid: "mimir", type: "prometheus" }, fieldConfig: { defaults: { unit: "s" } }, targets: [{ expr: `${sumExpr} / ${countExpr}` }] },
  { id: 13, title: "HTTP 5xx/s", datasource: { uid: "mimir", type: "prometheus" }, fieldConfig: { defaults: { unit: "reqps" } }, targets: [{ expr: errorExpr }] },
];
const serviceResponse = () => {
  const raw = response();
  raw.results.J = { frames: [frame("Value", [.1, .2, .1], { job: "api" }), frame("Value", [.4, .4, .4], { job: "web" })] };
  raw.results.K = { frames: [frame("Value", [1, 2, 1], { job: "api" }), frame("Value", [3, 3, 3], { job: "web" })] };
  // Deliberately reverse query frame order; joining by index would be wrong.
  raw.results.L = { frames: [frame("Value", [30, 30, 30], { job: "web" }), frame("Value", [10, 10, 10], { job: "api" })] };
  for (const ref of ["TJ", "TK", "TL"]) raw.results[ref] = { frames: [frame("scrape", Array(3).fill((now - 15000) / 1000))] };
  return raw;
};
const parseService = (raw = serviceResponse(), panels = servicePanels()) =>
  parseGrafanaMetrics(raw, now, grafanaServicePlan(panels).metrics);

test("service mean latency is request-weighted milliseconds, 5xx is percent, and job/time joins ignore frame order", () => {
  const data = parseService();
  assert.equal(data.service.latency.value, 325);
  assert.equal(data.service.latency.aggregation, "mean");
  assert.equal(data.service.latency.unit, "ms");
  assert.deepEqual(data.service.latency.points, [[now - 120000, 325], [now - 60000, 350], [now, 325]]);
  assert.equal(data.service.errorRate.value, 10);
  assert.equal(data.service.errorRate.unit, "percent");
  assert.equal(data.service.rps.value, 40);
  assert.equal(data.service.rps.unit, "req/s");
  assert.equal(data.freshness.latency.sampleAt, now - 15000);
  assert.equal(data.cpu.value, 40);
  assert.equal(data.tps.value, 0);
});

test("missing 5xx is unknown, observed zero is zero, and zero total requests never invents latency or an error percentage", () => {
  const raw = serviceResponse();
  raw.results.K.frames = [];
  assert.equal(parseService(raw).service.errorRate.value, null);
  raw.results.K = { frames: [frame("Value", [0, 0, 0], { job: "api" }), frame("Value", [0, 0, 0], { job: "web" })] };
  assert.equal(parseService(raw).service.errorRate.value, 0);
  for (const frame of raw.results.L.frames) frame.data.values[1] = [0, 0, 0];
  const data = parseService(raw);
  assert.equal(data.service.rps.value, 0);
  assert.equal(data.service.latency.value, null);
  assert.equal(data.service.errorRate.value, null);
});

test("partial jobs, duplicate jobs, and missing latest points are not published as complete service aggregates", () => {
  let raw = serviceResponse();
  raw.results.K.frames.pop();
  assert.equal(parseService(raw).service.errorRate.value, null);
  raw = serviceResponse();
  raw.results.J.frames[1].data.values[0][2] -= 1000;
  const skewed = parseService(raw).service.latency;
  assert.equal(skewed.value, null);
  assert.equal(skewed.at, null);
  assert.equal(skewed.points.length, 2);
  raw = serviceResponse();
  raw.results.J.frames[0].data.values[1][2] = null;
  assert.equal(parseService(raw).service.latency.value, null);
  raw = serviceResponse();
  raw.results.L.frames.push(structuredClone(raw.results.L.frames[0]));
  const duplicate = parseService(raw);
  assert.equal(duplicate.service.rps.value, null);
  assert.equal(duplicate.service.latency.value, null);
  assert.equal(duplicate.service.errorRate.value, null);
});

test("service source freshness includes every contributing counter and never substitutes an evaluation timestamp", () => {
  const raw = serviceResponse();
  raw.results.TJ.frames[0].data.values[1] = Array(3).fill((now - 301000) / 1000);
  let data = parseService(raw);
  assert.equal(data.service.latency.value, null);
  assert.equal(data.service.latency.reason, "stale");
  assert.equal(data.freshness.latency.sampleAt, now - 301000);
  assert.equal(data.service.rps.value, 40);
  delete raw.results.TJ;
  data = parseService(raw);
  assert.equal(data.service.latency.value, null);
  assert.equal(data.freshness.latency.kind, "unavailable");
  raw.results.TL.frames[0].data.values[1] = Array(3).fill((now - 100000) / 1000);
  data = parseService(raw);
  assert.equal(data.freshness.errorRate.sampleAt, now - 100000);
  assert.equal(freshnessStatus(data.freshness.errorRate.sampleAt, now, 90000, 300000), "delayed");
});

test("explicit percentage panels are weighted once and ambiguous units/counts/percentages are rejected", () => {
  const panels = servicePanels(), raw = serviceResponse();
  panels[2].targets[0].expr = `${errorExpr} / ${countExpr}`;
  panels[2].fieldConfig.defaults.unit = "percentunit";
  raw.results.K.frames[0].data.values[1] = [.1, .1, .1];
  raw.results.K.frames[1].data.values[1] = [.2, .2, .2];
  assert.equal(parseService(raw, panels).service.errorRate.value, 17.5);
  panels[2].targets[0].expr = `100 * (${errorExpr} / ${countExpr})`;
  panels[2].fieldConfig.defaults.unit = "percent";
  raw.results.K.frames[0].data.values[1] = [10, 10, 10];
  raw.results.K.frames[1].data.values[1] = [20, 20, 20];
  assert.equal(parseService(raw, panels).service.errorRate.value, 17.5);
  raw.results.K.frames[0].data.values[1][2] = 101;
  assert.equal(parseService(raw, panels).service.errorRate.value, null);
  panels[2].targets[0].expr = errorExpr;
  assert.equal(grafanaServicePlan(panels).metrics.errorRate, undefined);
  panels[2].fieldConfig.defaults.unit = "reqps";
  panels[2].targets[0].expr = errorExpr.replace('status=~"5.."', 'status=~"4.."');
  assert.equal(grafanaServicePlan(panels).metrics.errorRate, undefined);
});

test("P95 requires an actual 0.95 histogram quantile and a single aggregate; per-job percentiles are never summed or averaged", () => {
  const panels = servicePanels(), raw = serviceResponse();
  panels[1].title = "P95";
  assert.equal(grafanaServicePlan(panels).metrics.latency.aggregation, "mean");
  panels[1].targets[0].expr = 'histogram_quantile(0.95, sum by (le) (rate(http_server_requests_seconds_bucket{namespace="${project}"}[5m])))';
  raw.results.J.frames = [frame("Value", [.1, .1, .1])];
  let data = parseService(raw, panels);
  assert.equal(data.service.latency.aggregation, "p95");
  assert.equal(data.service.latency.value, 100);
  panels[1].targets[0].expr = panels[1].targets[0].expr.replace("by (le)", "by (job, le)");
  raw.results.J = serviceResponse().results.J;
  data = parseService(raw, panels);
  assert.equal(data.service.latency.value, null);
  assert.equal(data.service.latency.reason, "ambiguous");
  panels[1].targets[0].expr = panels[1].targets[0].expr.replace("0.95", "0.99");
  assert.equal(grafanaServicePlan(panels).metrics.latency, undefined);
});

test("service panels require matching source scopes and one visible target; unknown panels stay optional", () => {
  let panels = servicePanels();
  panels[1].targets[0].expr = panels[1].targets[0].expr.replaceAll("[5m]", "[1m]");
  assert.equal(grafanaServicePlan(panels).metrics.latency, undefined);
  panels = servicePanels();
  panels[2].datasource.uid = "other";
  assert.equal(grafanaServicePlan(panels).metrics.errorRate, undefined);
  panels = servicePanels();
  panels[2].targets[0].expr = panels[2].targets[0].expr.replace("${project}", "other-project");
  assert.equal(grafanaServicePlan(panels).metrics.errorRate, undefined);
  panels = servicePanels();
  panels[1].targets.push({ expr: "up" });
  assert.equal(grafanaServicePlan(panels).metrics.latency, undefined);
  panels[1].targets[1].hide = true;
  assert.equal(grafanaServicePlan(panels).metrics.latency.aggregation, "mean");
  panels[1].fieldConfig.overrides = [{ properties: [{ id: "unit", value: "ms" }] }];
  assert.equal(grafanaServicePlan(panels).metrics.latency, undefined);
  assert.deepEqual(grafanaServicePlan(servicePanels(), { latencyPanelId: 0, errorRatePanelId: 0, rpsPanelId: 0 }).selected, []);
});

test("malformed or over-limit optional frames do not hide valid CPU/DB metrics or publish truncated service totals", () => {
  for (const frames of [{ unexpected: true }, Array(65).fill(frame("Value", [1, 1, 1], { job: "api" })), [{ schema: { fields: {} } }]]) {
    const raw = serviceResponse();
    raw.results.J.frames = frames;
    const data = parseService(raw);
    assert.equal(data.service.latency.value, null);
    assert.equal(data.cpu.value, 40);
    assert.equal(data.tps.value, 0);
  }
  const panels = servicePanels();
  panels[1].targets = { invalid: true };
  assert.equal(grafanaServicePlan(panels).metrics.latency, undefined);
});

test("service panel IDs validate bounded integers including explicit disable and preserve other Grafana settings", () => {
  const config = defaultConfig();
  config.pages.push({ id: "service-metrics", name: "Service", columns: 2, rows: 2, widgets: [
    { ...widget(), label: "Service", x: 0, y: 0, w: 2, h: 2, latencyPanelId: 12, errorRatePanelId: 13, rpsPanelId: 11 },
  ] });
  assert.equal(validateConfig(config).pages.at(-1).widgets[0].latencyPanelId, 12);
  for (const key of ["latencyPanelId", "errorRatePanelId", "rpsPanelId"]) {
    config.pages.at(-1).widgets[0][key] = 0;
    validateConfig(config);
    for (const value of [-1, 1.2, 100001, "12", null]) {
      config.pages.at(-1).widgets[0][key] = value;
      assert.throws(() => validateConfig(config));
    }
    config.pages.at(-1).widgets[0][key] = 12;
  }
});

test("service collection reuses project queries, substitutes project variables, and isolates different optional panel selections", async (t) => {
  const base = { ...widget(), projects: [{ label: "A", value: "alpha" }] };
  const other = { ...base, id: "system", metric: "system" };
  const config = { pages: [{ widgets: [base, other] }] }, posts = [];
  const monitor = new GrafanaMonitor(() => config, () => {}, {
    clock: () => now, secret: async () => "TOKEN",
    fetcher: async (url, init) => {
      if (url.includes("dashboards")) return Response.json({ dashboard: { panels: [...dashboard.panels, ...servicePanels()] } });
      const body = JSON.parse(init.body); posts.push(body);
      return Response.json(serviceResponse());
    },
  });
  t.after(() => monitor.close());
  monitor.tick();
  await settle(() => monitor.active === 0);
  assert.equal(posts.length, 1);
  for (const ref of ["J", "K", "L", "TJ", "TK", "TL"]) assert.ok(posts[0].queries.some((query) => query.refId === ref));
  assert.equal(JSON.stringify(posts).includes("${project}"), false);
  assert.match(posts[0].queries.find((query) => query.refId === "TJ").expr, /and on\(\)/);
  assert.equal(monitor.state().widgets.system.projects.alpha.service.latency.value, 325);
  other.latencyPanelId = 0;
  monitor.tick();
  await settle(() => monitor.active === 0);
  assert.equal(posts.length, 2);
  assert.equal(posts[1].queries.some((query) => query.refId === "J"), false);
  assert.equal(monitor.state().widgets.system.projects.alpha.service.latency.value, null);
  assert.equal(monitor.state().widgets.db.projects.alpha.service.latency.value, 325);
});

test("HTTP 400 mixed query batches keep valid CPU/DB data while optional errors remain unknown; core failures still fail", async (t) => {
  const w = { ...widget(), projects: [{ value: "alpha", label: "A" }] };
  let time = now, coreFailure = false;
  const monitor = new GrafanaMonitor(() => ({ pages: [{ widgets: [w] }] }), () => {}, {
    clock: () => time, secret: async () => "PRIVATE_TOKEN",
    fetcher: async (url) => {
      if (url.includes("dashboards")) return Response.json({ dashboard: { panels: [...dashboard.panels, ...servicePanels()] } });
      const raw = serviceResponse();
      raw.results.J = { status: 400, error: "PRIVATE_INTERNAL_QUERY_ERROR" };
      if (coreFailure) raw.results.B = { status: 400, error: "PRIVATE_CORE_ERROR" };
      return Response.json(raw, { status: 400 });
    },
  });
  t.after(() => monitor.close());
  monitor.tick();
  await settle(() => monitor.active === 0);
  let state = monitor.state().widgets.db.projects.alpha;
  assert.equal(state.status, "ready");
  assert.equal(state.cpu.value, 40);
  assert.equal(state.tps.value, 0);
  assert.equal(state.service.latency.value, null);
  assert.equal(state.service.errorRate.value, 10);
  assert.equal(state.service.rps.value, 40);
  coreFailure = true; time += 30001;
  monitor.tick();
  await settle(() => monitor.active === 0);
  state = monitor.state().widgets.db.projects.alpha;
  assert.equal(state.status, "error");
  assert.equal(state.cpu.value, 40);
  assert.equal(JSON.stringify(state).includes("PRIVATE"), false);
});
test("freshness uses source scrape timestamps rather than query evaluation time and cannot invent unavailable times", () => {
  const raw = response();
  raw.results.TB = {
    frames: [
      frame("timestamp", [
        (now - 150000) / 1000,
        (now - 120000) / 1000,
        (now - 100000) / 1000,
      ]),
    ],
  };
  let data = parseGrafanaMetrics(raw, now);
  assert.equal(data.freshness.tps.sampleAt, now - 100000);
  assert.equal(data.freshness.cpu.sampleAt, now);
  assert.equal(data.freshness.cpu.kind, "point");
  assert.equal(
    freshnessStatus(data.freshness.tps.sampleAt, now, 90000, 300000),
    "delayed",
  );
  assert.equal(freshnessStatus(now - 300000, now, 90000, 300000), "stale");
  assert.equal(freshnessStatus(now + 61000, now, 90000, 300000), "missing");
  delete raw.results.TB;
  data = parseGrafanaMetrics(raw, now);
  assert.equal(data.freshness.tps.sampleAt, null);
  assert.equal(data.freshness.tps.kind, "unavailable");
  const query = sourceTimestampQuery(
    {
      datasource: { type: "prometheus", uid: "p" },
      expr: 'sum(rate(commits{namespace="alpha"}[5m]))',
    },
    "TB",
  );
  assert.equal(query.expr, 'min(timestamp(commits{namespace="alpha"}))');
  assert.equal(query.instant, true);
  const combined = sourceTimestampQuery(
      { datasource: { type: "prometheus" }, expr: 'a{x="y"} + b{x="y"}' },
      "T",
  );
  assert.match(combined.expr, /min\(label_replace\(min\(timestamp\(a\{x="y"\}\)\)/);
  assert.match(combined.expr, /or label_replace\(min\(timestamp\(b\{x="y"\}\)\)/);
  assert.ok(combined.expr.endsWith('and on() (min(timestamp(a{x="y"})) and on() min(timestamp(b{x="y"})))'));
  assert.equal(sourceTimestampQuery({ datasource: { type: "prometheus" }, expr: Array.from({ length: 9 }, (_, i) => `m${i}{job="a"}`).join("+") }, "T"), null);
});
test("wake recovery supersedes in-flight queries and late old results cannot consume slots or overwrite fresh data", async (t) => {
  const w = { ...widget(), projects: [{ value: "alpha", label: "A" }] };
  const pending = [];
  let changes = 0;
  const monitor = new GrafanaMonitor(
    () => ({ pages: [{ widgets: [w] }] }),
    () => changes++,
    {
      clock: () => now,
      secret: async () => "TOKEN",
      fetcher: async (url, init) => {
        if (url.includes("dashboards")) return Response.json({ dashboard });
        return await new Promise((resolve) =>
          pending.push({ resolve, signal: init.signal }),
        );
      },
    },
  );
  t.after(() => monitor.close());
  monitor.tick();
  await settle(() => pending.length === 1);
  monitor.resume();
  await settle(() => pending.length === 2);
  assert.equal(pending[0].signal.aborted, true);
  const fresh = response();
  fresh.results.B.frames = [frame("TPS", [9, 9, 9])];
  pending[1].resolve(Response.json(fresh));
  await settle(() => monitor.active === 0);
  pending[0].resolve(Response.json(response()));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(monitor.active, 0);
  assert.equal(monitor.state().widgets.db.projects.alpha.tps.value, 9);
  assert.equal(changes, 1);
});
test("a new successful query cannot make expired source samples live again and preserves the last collection time", async (t) => {
  let time = now;
  const w = { ...widget(), projects: [{ value: "alpha", label: "A" }] };
  const monitor = new GrafanaMonitor(
    () => ({ pages: [{ widgets: [w] }] }),
    () => {},
    {
      clock: () => time,
      secret: async () => "TOKEN",
      fetcher: async (url) =>
        Response.json(url.includes("dashboards") ? { dashboard } : response()),
    },
  );
  t.after(() => monitor.close());
  monitor.tick();
  await settle(() => monitor.active === 0);
  time += 301000;
  monitor.tick();
  await settle(() => monitor.active === 0);
  const data = monitor.state().widgets.db.projects.alpha;
  assert.equal(data.status, "ready");
  assert.equal(data.capturedAt, time);
  assert.equal(data.cpu.value, null);
  assert.equal(data.freshness.cpu.lastSampleAt, now);
  assert.equal(data.freshness.cpu.status, "stale");
});
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
test("DB GiB uses actual bytes from the same highest-utilization node, not a different node or inferred limit", () => {
  const raw = response();
  raw.results.H = {
    frames: [frame("db-0", [0.1, 0.3, 0.4]), frame("db-1", [0.6, 0.7, 0.8])],
  };
  raw.results.I = {
    frames: [frame("db-0", [100, 200, 300]), frame("db-1", [600, 700, 800])],
  };
  const data = parseGrafanaMetrics(raw, now);
  assert.equal(data.memory.usedBytes, 800);
  assert.equal(data.memory.value, 80);
  raw.results.I.frames.push(frame("db-1", [600, 700, 900]));
  assert.equal(parseGrafanaMetrics(raw, now).memory.usedBytes, null);
  raw.results.I.frames.pop();
  raw.results.I.frames.pop();
  assert.equal(parseGrafanaMetrics(raw, now).memory.usedBytes, null);
});
test("node comparison joins CPU and actual memory by exact node, preserves missing data and excludes exporter identities", () => {
  const raw = response();
  raw.results.A = {
    frames: [frame("db-0", [0.1, 0.2, 0.3]), frame("db-1", [0.5, 0.4, 0.2])],
  };
  raw.results.H = {
    frames: [frame("db-0", [0.6, 0.6, 0.6]), frame("db-1", [0.8, 0.8, 0.8])],
  };
  raw.results.I = {
    frames: [frame("db-0", [100, 200, 300]), frame("db-1", [700, 800, 900])],
  };
  raw.results.G = { frames: [frame("db-exporter-0", [10, 20, 30])] };
  let nodes = parseGrafanaMetrics(raw, now).database.nodes;
  assert.deepEqual(
    nodes.map((n) => [
      n.name,
      n.cpuPercent,
      n.memoryPercent,
      n.memoryUsedBytes,
    ]),
    [
      ["db-0", 30, 60, 300],
      ["db-1", 20, 80, 900],
    ],
  );
  assert.equal(nodes[0].cpuPoints.length, 3);
  assert.equal(nodes[0].cpuAt, now);
  raw.results.A.frames.push(frame("db-1", [0.6, 0.7, 0.8]));
  raw.results.I.frames.pop();
  nodes = parseGrafanaMetrics(raw, now).database.nodes;
  assert.equal(nodes[1].cpuPercent, null);
  assert.equal(nodes[1].memoryPercent, 80);
  assert.equal(nodes[1].memoryUsedBytes, null);
  raw.results.A.frames = [];
  raw.results.H.frames = [];
  raw.results.I.frames = [];
  assert.deepEqual(parseGrafanaMetrics(raw, now).database.nodes, []);
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
  assert.equal(state.widgets.db.projects.alpha.cpu.value, 40);
  assert.equal(state.widgets.db.projects.alpha.freshness.cpu.status, "fresh");
  // Historical values remain labeled error, so clients can show the last source time without treating them as live.
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
  assert.equal(
    (
      await fetch(base + "/monitor-rules.mjs", {
        headers: { "X-Open-Deck-Admin": h.adminKey },
      })
    ).status,
    200,
  );
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
  assert.equal(
    (
      await fetch(base + "/api/admin/resume", {
        method: "POST",
        headers: { Authorization: "Bearer " + pair.token },
      })
    ).status,
    403,
  );
  const eventResponse = await fetch(base + "/api/events", {
    headers: { Authorization: "Bearer " + pair.token },
    signal: AbortSignal.timeout(2000),
  });
  const eventReader = eventResponse.body.getReader();
  await eventReader.read();
  const resumed = await fetch(base + "/api/admin/resume", {
    method: "POST",
    headers: { "X-Open-Deck-Admin": h.adminKey },
  });
  assert.equal(resumed.status, 200);
  while (!(await eventReader.read()).done) {}
  const nextStream = await fetch(base + "/api/events", {
    headers: { Authorization: "Bearer " + pair.token },
    signal: AbortSignal.timeout(2000),
  });
  const nextReader = nextStream.body.getReader();
  assert.equal((await nextReader.read()).done, false);
  await nextReader.cancel();
  const adminInfo = await (
    await fetch(base + "/api/admin/info", {
      headers: { "X-Open-Deck-Admin": h.adminKey },
    })
  ).json();
  assert.equal(adminInfo.recovery.count, 1);
  const write = await fetch(base + "/api/admin/grafana-token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + pair.token,
    },
    body: JSON.stringify({ widgetId: "db", token: "never stored" }),
  });
  assert.equal(write.status, 403);
  const testBody = JSON.stringify({ widgetId: "db" });
  assert.equal(
    (
      await fetch(base + "/api/admin/monitor-test", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + pair.token,
        },
        body: testBody,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(base + "/api/admin/monitor-test", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Open-Deck-Admin": h.adminKey,
        },
        body: testBody,
      })
    ).status,
    200,
  );
  const notified = await (
    await fetch(base + "/api/snapshot", {
      headers: { Authorization: "Bearer " + pair.token },
    })
  ).json();
  assert.equal(notified.state.notifications.at(-1).kind, "monitor");
  assert.match(notified.state.notifications.at(-1).title, /알림 테스트/);
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
