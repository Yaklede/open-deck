import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHost } from "../host/server.mjs";
import { defaultConfig, validateConfig, writeJson } from "../host/config.mjs";
import { parseGrafanaMetrics } from "../host/grafana.mjs";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail("condition did not become true before deadline");
    await pause(10);
  }
}

async function setup(t, large = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opendeck-sse-test-"));
  const config = defaultConfig();
  config.pages = [{
    id: "monitor", name: "Synthetic", columns: 4, rows: 2,
    widgets: [{
      id: "db", type: "grafana", metric: "database", label: "Synthetic",
      x: 0, y: 0, w: 4, h: 2, url: "https://synthetic.invalid/d/test",
      projects: Array.from({ length: large ? 3 : 1 }, (_, i) => ({ value: "synthetic" + i, label: "Synthetic " + i })),
      alerts: { enabled: false },
    }],
  }];
  config.profiles = [{ id: "synthetic", name: "Synthetic", pageIds: ["monitor"], defaultPageId: "monitor" }];
  config.defaultProfileId = "synthetic";
  config.extensions = {};
  config.integrations = [];
  config.automations = [];
  writeJson(path.join(dir, "deck.json"), validateConfig(config));
  const host = createHost({ dir, metrics: false, wifi: false, runner: async () => "" });
  const clients = [];
  const responses = [];
  host.server.prependListener("request", (request, response) => {
    if (request.url === "/api/events") responses.push(response);
  });
  await new Promise((resolve) => host.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const client of clients) client.request.destroy();
    await host.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${host.server.address().port}`;
  const api = async (route, method = "GET", input, token) => {
    const response = await fetch(base + route, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : { "X-Open-Deck-Admin": host.adminKey }),
        ...(input === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    return { status: response.status, data: await response.json() };
  };
  if (large) {
    const now = Date.now();
    const times = Array.from({ length: 60 }, (_, i) => now - (59 - i) * 60000);
    const frame = (name, value) => ({
      schema: { fields: [{ name: "Time", type: "time" }, { name, type: "number", labels: { pod: name } }] },
      data: { values: [times, times.map((_, i) => value + Math.sin(i + 64) * 0.1)] },
    });
    const data = parseGrafanaMetrics({ results: {
      A: { frames: Array.from({ length: 64 }, (_, i) => frame("synthetic-db-" + i, 0.3)) },
      B: { frames: [frame("TPS", 30)] },
      H: { frames: Array.from({ length: 64 }, (_, i) => frame("synthetic-db-" + i, 0.5)) },
    } }, now);
    const widgets = { db: { projects: Object.fromEntries(config.pages[0].widgets[0].projects.map((p) => [p.value, data])) } };
    host.engine.grafana = { state: () => ({ widgets }), tick: () => {} };
  }
  const pair = async (name = "Synthetic tablet") => {
    const result = await api("/api/pair", "POST", { pin: host.getPin(), name });
    assert.equal(result.status, 200);
    return result.data;
  };
  const open = async (token, paused = false) => {
    const client = { snapshots: [], comments: [], closed: false, buffer: "", response: null };
    client.request = http.get(base + "/api/events", {
      headers: token ? { Authorization: `Bearer ${token}` } : { "X-Open-Deck-Admin": host.adminKey },
    }, (response) => {
      client.response = response;
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        client.buffer += chunk;
        let boundary;
        while ((boundary = client.buffer.indexOf("\n\n")) >= 0) {
          const part = client.buffer.slice(0, boundary);
          client.buffer = client.buffer.slice(boundary + 2);
          if (part.startsWith(":")) client.comments.push(part);
          const data = part.split("\n").find((line) => line.startsWith("data: "));
          if (data) client.snapshots.push(JSON.parse(data.slice(6)));
        }
      });
      response.on("close", () => { client.closed = true; });
      response.on("error", () => { client.closed = true; });
      if (paused) response.pause();
    });
    client.request.on("error", () => { client.closed = true; });
    clients.push(client);
    await until(() => !!client.response);
    client.serverResponse = responses.at(-1);
    return client;
  };
  const block = async (client) => {
    // The real TCP client stops consuming. Repeated updates eventually fill OS
    // socket buffers; the server must retain only its latest unsent snapshot.
    for (let i = 0; i < 100; i++) { host.engine.onChange(); await pause(5); }
    await pause(100);
    assert.equal(client.serverResponse.openDeckChannel.blocked, true);
    assert.ok(client.serverResponse.writableLength > 0);
    assert.equal(client.serverResponse.destroyed, false);
  };
  return { host, config, dir, base, api, pair, open, block };
}

test("idle SSE emits independent comment heartbeats without generating a snapshot", { timeout: 8000 }, async (t) => {
  const h = await setup(t);
  const device = await h.pair();
  const stream = await h.open(device.token);
  await until(() => stream.snapshots.length === 1);
  await until(() => stream.comments.includes(": heartbeat"), 3500);
  assert.equal(stream.snapshots.length, 1);
  assert.equal(stream.closed, false);
  assert.ok(stream.comments.includes(": connected"));
});

test("real host keeps a normal reader connected through consecutive 490 KB snapshots", async (t) => {
  const h = await setup(t, true);
  const device = await h.pair();
  const stream = await h.open(device.token);
  await until(() => stream.snapshots.length >= 1);
  assert.ok(Buffer.byteLength(JSON.stringify(stream.snapshots[0])) > 450000);
  const start = stream.snapshots.length;
  h.host.engine.onChange();
  h.host.engine.onChange();
  h.host.engine.onChange();
  await until(() => stream.snapshots.length >= start + 2);
  assert.equal(stream.closed, false);
  assert.equal(stream.serverResponse.destroyed, false);
});

test("paused real reader receives the latest config and device revision after drain", { timeout: 12000 }, async (t) => {
  const h = await setup(t, true);
  const paired = await h.pair();
  const stream = await h.open(paired.token, true);
  await h.block(stream);
  const sentRevision = stream.serverResponse.openDeckRevision;
  for (const label of ["Intermediate config", "Latest config"]) {
    const config = structuredClone(h.config);
    config.pages[0].widgets[0].label = label;
    assert.equal((await h.api("/api/admin/config", "PUT", config)).status, 200);
  }
  let latestSettingsRevision;
  for (const textScale of [110, 125]) {
    const update = await h.api("/api/device/settings", "PUT", { settings: { textScale } }, paired.token);
    assert.equal(update.status, 200);
    latestSettingsRevision = update.data.device.settingsRevision;
  }
  assert.equal(stream.serverResponse.openDeckRevision, sentRevision, "unsent revisions cannot be acknowledged");
  assert.equal(stream.closed, false);
  stream.response.resume();
  await until(() => stream.snapshots.some((s) => s.config?.pages[0]?.widgets[0]?.label === "Latest config" && s.device?.settings.textScale === 125));
  const latest = stream.snapshots.find((s) => s.config?.pages[0]?.widgets[0]?.label === "Latest config" && s.device?.settings.textScale === 125);
  assert.equal(latest.device.settingsRevision, latestSettingsRevision);
  assert.ok(!stream.snapshots.some((s) => s.config?.pages[0]?.widgets[0]?.label === "Intermediate config"));
  assert.equal(stream.serverResponse.openDeckChannel.pending, null);
  assert.equal(stream.closed, false);
});

test("admin device metadata is not acknowledged until its queued snapshot is sent", { timeout: 12000 }, async (t) => {
  const h = await setup(t, true);
  const paired = await h.pair();
  const stream = await h.open(undefined, true);
  await h.block(stream);
  const sentDevices = stream.serverResponse.openDeckDevices;
  for (const name of ["Intermediate name", "Latest name"])
    assert.equal((await h.api("/api/device/settings", "PUT", { name }, paired.token)).status, 200);
  assert.equal(stream.serverResponse.openDeckDevices, sentDevices);
  stream.response.resume();
  await until(() => stream.snapshots.some((s) => s.devices?.some((d) => d.name === "Latest name")));
  assert.equal(stream.closed, false);
  assert.ok(!JSON.stringify(stream.snapshots).includes(paired.token));
});

test("revocation discards a blocked device stream while other clients remain connected", { timeout: 12000 }, async (t) => {
  const h = await setup(t, true);
  const first = await h.pair("First synthetic"), second = await h.pair("Second synthetic");
  const blocked = await h.open(first.token, true);
  const healthy = await h.open(second.token);
  await h.block(blocked);
  const own = (await h.api("/api/device/settings", "GET", undefined, first.token)).data.device;
  const sent = blocked.serverResponse.openDeckRevision;
  const config = structuredClone(h.config);
  config.pages[0].widgets[0].label = "Pending must not escape";
  assert.equal((await h.api("/api/admin/config", "PUT", config)).status, 200);
  assert.equal((await h.api("/api/admin/revoke", "POST", { id: own.id })).status, 200);
  assert.equal(blocked.serverResponse.openDeckChannel.closed, true);
  assert.equal(blocked.serverResponse.openDeckChannel.pending, null);
  assert.equal(blocked.serverResponse.openDeckRevision, sent);
  assert.equal(blocked.serverResponse.destroyed, true);
  assert.equal((await h.api("/api/snapshot", "GET", undefined, first.token)).status, 401);
  h.host.engine.onChange();
  await until(() => healthy.snapshots.some((s) => s.config?.pages[0]?.widgets[0]?.label === "Pending must not escape"));
  assert.equal(healthy.closed, false);
  const events = fs.readFileSync(path.join(h.dir, "diagnostics.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(events.some((e) => e.event === "stream.closed" && e.reason === "device_revoked"));
  assert.ok(!JSON.stringify(events).includes(first.token));
});

test("a real client stalled for 15 seconds is closed with a bounded, secret-free reason log", { timeout: 23000 }, async (t) => {
  const h = await setup(t, true);
  const device = await h.pair();
  const stream = await h.open(device.token, true);
  await h.block(stream);
  await until(() => stream.serverResponse.destroyed, 17000);
  const channel = stream.serverResponse.openDeckChannel;
  assert.equal(channel.closed, true);
  assert.equal(channel.pending, null);
  assert.equal(channel.timer, null);
  const raw = fs.readFileSync(path.join(h.dir, "diagnostics.jsonl"), "utf8");
  const events = raw.trim().split("\n").map(JSON.parse);
  const stall = events.find((e) => e.event === "stream.closed" && e.reason === "backpressure_timeout");
  assert.ok(stall);
  assert.equal(stall.level, "warn");
  assert.ok(stall.durationMs >= 14500);
  assert.ok(stall.durationMs < 20000);
  assert.ok(!raw.includes(device.token));
  assert.ok(!raw.includes(h.host.adminKey));
});
