import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import http from "node:http";
import { once } from "node:events";
import { createHost, deviceConfig } from "../host/server.mjs";
import { defaultConfig, writeJson, validateConfig } from "../host/config.mjs";
import { defaultSettings } from "../host/settings.mjs";
import { loadIdentity } from "../host/network.mjs";
function config() {
  const c = defaultConfig();
  c.pages = [
    {
      id: "first",
      name: "First",
      columns: 4,
      rows: 2,
      widgets: [
        {
          id: "a",
          x: 0,
          y: 0,
          w: 2,
          h: 2,
          type: "grafana",
          label: "CPU",
          metric: "system",
          url: "https://metrics.example/d/source/dashboard",
          projects: [{ value: "prod", label: "Production" }],
          alerts: { holdSeconds: 0 },
          latencyPanelId: 12,
          errorRatePanelId: 13,
          rpsPanelId: 11,
        },
      ],
    },
    {
      id: "second",
      name: "Second",
      columns: 4,
      rows: 2,
      widgets: [
        {
          id: "b",
          x: 0,
          y: 0,
          w: 2,
          h: 2,
          type: "grafana",
          label: "DB",
          metric: "database",
          url: "https://metrics.example/d/source/dashboard",
          projects: [{ value: "prod", label: "Production" }],
          alerts: { holdSeconds: 0 },
        },
      ],
    },
  ];
  c.profiles = [
    { id: "first", name: "First", pageIds: ["first"], defaultPageId: "first" },
    {
      id: "second",
      name: "Second",
      pageIds: ["second"],
      defaultPageId: "second",
    },
  ];
  c.defaultProfileId = "first";
  return validateConfig(c);
}
async function fixture(t, wifi = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opendeck-inbox-api-"));
  writeJson(path.join(dir, "deck.json"), config());
  const settings = defaultSettings();
  settings.network.discoveryEnabled = false;
  writeJson(path.join(dir, "preferences.json"), settings);
  const host = createHost({
    dir,
    metrics: false,
    wifi,
    wifiPort: 0,
    runner: async () => "",
  });
  if (wifi && !host.lanServer.listening)
    await once(host.lanServer, "listening");
  host.server.listen(0, "127.0.0.1");
  await once(host.server, "listening");
  const base = `http://127.0.0.1:${host.server.address().port}`;
  const call = async (route, method = "GET", body, auth = "admin") => {
    const response = await fetch(base + route, {
      method,
      headers: {
        ...(auth === "admin"
          ? { "X-Open-Deck-Admin": host.adminKey }
          : auth
            ? { Authorization: `Bearer ${auth}` }
            : {}),
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  t.after(async () => {
    await host.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, host, base, call };
}
test("paired incident actions enforce current profile scope and strict bodies; snapshots and SSE never leak hidden incidents", async (t) => {
  const { call, host, base } = await fixture(t);
  const pair = (
    await call("/api/pair", "POST", { pin: host.getPin(), name: "Fixture" })
  ).data;
  const test = await call("/api/admin/monitor-test", "POST", { widgetId: "b" });
  assert.equal(test.status, 200);
  const hidden = test.data.incident.id;
  assert.equal(
    (await call("/api/snapshot", "GET", undefined, pair.token)).data.state
      .monitoring.inbox.incidents.length,
    0,
  );
  assert.equal(
    (
      await call(
        `/api/monitor/incidents/${hidden}`,
        "POST",
        { action: "acknowledge" },
        pair.token,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await call(
        `/api/monitor/incidents/${hidden}`,
        "POST",
        { action: "acknowledge" },
        null,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await call(
        "/api/admin/monitor-test",
        "POST",
        { widgetId: "a" },
        pair.token,
      )
    ).status,
    403,
  );
  const own = (await call("/api/admin/monitor-test", "POST", { widgetId: "a" }))
    .data.incident.id;
  // Same-source synthetic test events group too. The current condition now belongs to a.
  assert.equal(own, hidden);
  let r = await call(
    `/api/monitor/incidents/${own}`,
    "POST",
    { action: "acknowledge" },
    pair.token,
  );
  assert.equal(r.status, 200);
  assert.ok(r.data.incident.acknowledgedAt);
  for (const payload of [
    null,
    [],
    {},
    { action: "snooze", minutes: 1 },
    { action: "acknowledge", extra: "secret" },
  ])
    assert.equal(
      (await call(`/api/monitor/incidents/${own}`, "POST", payload, pair.token))
        .status,
      400,
    );
  assert.equal(
    (
      await call(
        "/api/monitor/incidents/incident-" + "f".repeat(32),
        "POST",
        { action: "resume" },
        pair.token,
      )
    ).status,
    404,
  );
  const abort = new AbortController();
  t.after(() => abort.abort());
  const response = await fetch(base + "/api/events", {
    headers: { Authorization: `Bearer ${pair.token}` },
    signal: abort.signal,
  });
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let text = "",
    snapshot;
  while (!snapshot) {
    text += decoder.decode((await reader.read()).value);
    const match = text.match(/data: (.+)\n/);
    if (match) snapshot = JSON.parse(match[1]);
  }
  assert.deepEqual(snapshot.state.monitoring.inbox.incidents[0].widgetIds, [
    "a",
  ]);
  assert.ok(
    snapshot.state.monitoring.inbox.incidents[0].conditions.every(
      (c) => c.widgetId === "a",
    ),
  );
  assert.ok(
    !JSON.stringify(snapshot.state.monitoring).includes("metrics.example"),
  );
  assert.ok(!JSON.stringify(snapshot).includes(host.adminKey));
  assert.ok(!JSON.stringify(snapshot).includes(pair.token));
  assert.equal(snapshot.config.pages[0].widgets[0].latencyPanelId, undefined);
  await reader.cancel();
  abort.abort();
  // Changing assigned profiles immediately changes authorization, including a previously known ID.
  assert.equal(
    (
      await call(
        "/api/device/settings",
        "PUT",
        { settings: { profileId: "second", startPageId: "" } },
        pair.token,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        `/api/monitor/incidents/${own}`,
        "POST",
        { action: "snooze" },
        pair.token,
      )
    ).status,
    404,
  );
  r = await call("/api/admin/monitor-test", "POST", {
    widgetId: "a",
    operation: "recover",
  });
  assert.equal(r.data.incident.status, "resolved");
  assert.equal(
    (await call(`/api/monitor/incidents/${own}`, "POST", { action: "resume" }))
      .status,
    409,
  );
});
test("HTTPS LAN exposes only paired monitor actions and never the admin synthetic endpoint", async (t) => {
  const { call, host, dir } = await fixture(t, true),
    cert = loadIdentity(dir).cert;
  const token = (await call("/api/pair", "POST", { pin: host.getPin() })).data
    .token;
  const incident = (
    await call("/api/admin/monitor-test", "POST", { widgetId: "a" })
  ).data.incident;
  const request = (route, body, auth = token) =>
    new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: "127.0.0.1",
          port: host.lanServer.address().port,
          path: route,
          method: "POST",
          servername: "opendeck.local",
          ca: cert,
          agent: false,
          headers: {
            "Content-Type": "application/json",
            ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
          },
        },
        (res) => {
          let text = "";
          res.on("data", (d) => (text += d));
          res.on("end", () =>
            resolve({ status: res.statusCode, data: JSON.parse(text) }),
          );
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });
  assert.equal(
    (
      await request(`/api/monitor/incidents/${incident.id}`, {
        action: "snooze",
        minutes: 30,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request(
        `/api/monitor/incidents/${incident.id}`,
        { action: "resume" },
        null,
      )
    ).status,
    401,
  );
  assert.equal(
    (await request("/api/admin/monitor-test", { widgetId: "a" })).status,
    403,
  );
  assert.equal(
    (await request("/api/monitor/incidents/anything", { action: "resume" }))
      .status,
    403,
  );
});
test("monitor incident ACK and synthetic history survive a real host close/start without replay", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opendeck-inbox-restart-"));
  writeJson(path.join(dir, "deck.json"), config());
  let host = createHost({ dir, metrics: false, runner: async () => "" });
  host.server.listen(0, "127.0.0.1");
  await once(host.server, "listening");
  const page = host.engine.config.pages[0],
    record = host.engine.monitorAlerts.testNotification(page, page.widgets[0]);
  host.engine.monitorAlerts.act(host.engine.config, record.id, {
    action: "acknowledge",
  });
  await host.close();
  host = createHost({ dir, metrics: false, runner: async () => "" });
  host.server.listen(0, "127.0.0.1");
  await once(host.server, "listening");
  t.after(async () => {
    await host.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const state = host.engine.state();
  assert.equal(state.monitoring.inbox.incidents[0].id, record.id);
  assert.ok(state.monitoring.inbox.incidents[0].acknowledgedAt);
  assert.equal(state.monitoring.notifications.length, 0);
});
test("a revoked token cannot gain admin incident scope while the request body is still streaming", async (t) => {
  const { call, host, base } = await fixture(t);
  const paired = (await call("/api/pair", "POST", { pin: host.getPin() })).data;
  const device = (await call("/api/snapshot", "GET", undefined, paired.token))
    .data.device;
  const incident = (
    await call("/api/admin/monitor-test", "POST", { widgetId: "a" })
  ).data.incident;
  let request;
  const response = new Promise((resolve, reject) => {
    request = http.request(
      base + `/api/monitor/incidents/${incident.id}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${paired.token}`,
          "Content-Type": "application/json",
          "Transfer-Encoding": "chunked",
        },
      },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () =>
          resolve({ status: res.statusCode, data: JSON.parse(body) }),
        );
      },
    );
    request.on("error", reject);
  });
  const arrived = once(host.server, "request");
  request.write('{"action":');
  await arrived;
  assert.equal(
    (await call("/api/admin/revoke", "POST", { id: device.id })).status,
    200,
  );
  request.end('"acknowledge"}');
  assert.equal((await response).status, 401);
  assert.equal(
    host.engine.monitorAlerts.incidents.get(incident.id).acknowledgedAt,
    null,
  );
});
