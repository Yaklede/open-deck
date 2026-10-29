import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MonitorAlerts } from "../host/monitor-alerts.mjs";
import {
  monitorSettings,
  validateMonitorSettings,
} from "../host/public/monitor-rules.mjs";
const widget = (
  id = "cpu",
  metric = "system",
  url = "https://metrics.example/d/shared/dashboard",
) => ({
  id,
  type: "grafana",
  metric,
  url,
  label: id,
  projects: [{ value: "prod", label: "Production" }],
  alerts: { holdSeconds: 0, cooldownSeconds: 60 },
});
const sample = (time, cpu = 95) => ({
  status: "ready",
  capturedAt: time,
  system: { value: cpu },
  cpu: { value: cpu },
  memory: { value: 60 },
  database: { ready: true },
  collection: { healthy: 1, total: 1 },
});
function fixture(options = {}) {
  let time = 1000000;
  const cpu = widget(),
    db = widget("db", "database"),
    config = { pages: [{ id: "p", widgets: [cpu, db] }] };
  const monitor = new MonitorAlerts({ clock: () => time, ...options }),
    values = { cpu: sample(time), db: sample(time) };
  return {
    monitor,
    config,
    cpu,
    db,
    values,
    get now() {
      return time;
    },
    advance(ms) {
      time += ms;
      for (const v of Object.values(values)) v.capturedAt = time;
    },
    evaluate() {
      return monitor.evaluate(config, {
        grafana: {
          widgets: Object.fromEntries(
            Object.entries(values).map(([id, v]) => [
              id,
              { projects: { prod: v } },
            ]),
          ),
        },
      });
    },
  };
}
test("CPU and DB from one source/project create a single incident and one notification", () => {
  const h = fixture(),
    inbox = h.evaluate().inbox;
  assert.equal(inbox.activeCount, 1);
  assert.equal(h.monitor.notifications.length, 1);
  assert.equal(inbox.incidents[0].conditions.length, 2);
  assert.deepEqual(inbox.incidents[0].widgetIds, ["cpu", "db"]);
  assert.deepEqual(
    inbox.incidents[0].timeline.map((e) => e.type),
    ["occurrence"],
  );
  h.db.url = "https://other.example/d/shared/dashboard";
  assert.equal(h.evaluate().inbox.activeCount, 2);
  h.db.url = "https://metrics.example/d/other/dashboard";
  assert.equal(h.evaluate().inbox.activeCount, 2);
});
test("acknowledgement suppresses repeats; recovery and recurrence retain the same history", () => {
  const h = fixture(),
    id = h.evaluate().inbox.incidents[0].id;
  h.monitor.act(h.config, id, { action: "acknowledge" });
  h.advance(120000);
  h.evaluate();
  assert.equal(h.monitor.notifications.length, 1);
  assert.equal(h.monitor.inbox(h.config).unacknowledgedCount, 0);
  h.values.cpu.system.value = 30;
  h.values.db.cpu.value = 30;
  let record = h.evaluate().inbox.incidents[0];
  assert.equal(record.status, "resolved");
  assert.equal(h.monitor.notifications.at(-1).severity, "normal");
  h.values.cpu.system.value = 95;
  record = h.evaluate().inbox.incidents[0];
  assert.equal(record.id, id);
  assert.equal(record.count, 2);
  assert.equal(record.acknowledgedAt, null);
  assert.deepEqual(
    record.timeline.map((e) => e.type),
    ["occurrence", "acknowledge", "recovery", "occurrence"],
  );
});
test("snooze suppresses danger and recovery delivery, expiry and explicit resume are recorded", () => {
  const h = fixture(),
    id = h.evaluate().inbox.incidents[0].id;
  h.monitor.act(h.config, id, { action: "snooze", minutes: 30 });
  h.advance(120000);
  h.evaluate();
  assert.equal(h.monitor.notifications.length, 1);
  h.monitor.act(h.config, id, { action: "resume" });
  h.evaluate();
  assert.equal(h.monitor.notifications.length, 2);
  h.monitor.act(h.config, id, { action: "snooze" });
  h.advance(1800000);
  h.evaluate();
  assert.equal(h.monitor.notifications.length, 3);
  h.monitor.act(h.config, id, { action: "snooze" });
  h.values.cpu.system.value = 30;
  h.values.db.cpu.value = 30;
  assert.equal(h.evaluate().inbox.incidents[0].status, "resolved");
  assert.equal(h.monitor.notifications.length, 3);
  assert.ok(
    h.monitor
      .inbox(h.config)
      .incidents[0].timeline.filter((e) => e.type === "resume").length === 2,
  );
});
test("missing individual metrics and disconnected siblings preserve the last active conditions", () => {
  const h = fixture();
  h.evaluate();
  h.values.cpu.system.value = null;
  h.values.db.cpu.value = 30;
  let r = h.evaluate().inbox.incidents[0];
  assert.equal(r.status, "active");
  assert.equal(r.stale, true);
  assert.equal(r.conditions[0].value, 95);
  h.values.cpu.system.value = 30;
  h.values.db.status = "error";
  r = h.evaluate().inbox.incidents[0];
  assert.equal(r.status, "active");
  assert.equal(r.stale, true);
  assert.equal(h.monitor.notifications.length, 1);
  h.values.db.status = "ready";
  r = h.evaluate().inbox.incidents[0];
  assert.equal(r.status, "resolved");
  assert.equal(h.monitor.notifications.length, 2);
});
test("system CPU uses system freshness rather than DB CPU freshness", () => {
  const h = fixture();
  h.config.pages[0].widgets = [h.cpu];
  h.values.cpu.freshness = {
    system: { status: "delayed" },
    cpu: { status: "fresh" },
  };
  assert.equal(h.evaluate().inbox.activeCount, 0);
  assert.equal(
    h.monitor.widgets.cpu.projects.prod.metrics.cpu.level,
    "unknown",
  );
  h.values.cpu.freshness = {
    system: { status: "fresh" },
    cpu: { status: "delayed" },
  };
  assert.equal(h.evaluate().inbox.activeCount, 1);
});
test("private atomic history restores ack/snooze, never reloads notifications, and waits for fresh recovery", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opendeck-incidents-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const h = fixture({ dir });
  const original = h.evaluate().inbox.incidents[0];
  h.monitor.act(h.config, original.id, { action: "acknowledge" });
  h.monitor.act(h.config, original.id, { action: "snooze" });
  h.monitor.close();
  const file = path.join(dir, "monitor-incidents.json"),
    text = fs.readFileSync(file, "utf8");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(!text.includes("metrics.example"));
  assert.ok(!text.includes("notifications"));
  assert.equal(fs.readdirSync(dir).length, 1);
  const restored = new MonitorAlerts({ dir, clock: () => h.now });
  let state = restored.evaluate(h.config, {});
  assert.equal(state.notifications.length, 0);
  assert.equal(state.inbox.incidents[0].status, "active");
  assert.equal(state.inbox.incidents[0].stale, true);
  assert.ok(state.inbox.incidents[0].acknowledgedAt);
  assert.ok(state.inbox.incidents[0].snoozedUntil);
  state = restored.evaluate(h.config, {
    grafana: {
      widgets: {
        cpu: { projects: { prod: sample(h.now) } },
        db: { projects: { prod: sample(h.now) } },
      },
    },
  });
  assert.equal(state.notifications.length, 0);
  assert.equal(state.inbox.incidents[0].count, 1);
  assert.deepEqual(
    state.inbox.incidents[0].timeline.map((e) => e.type),
    ["occurrence", "acknowledge", "snooze"],
  );
});
test("unacknowledged active alerts do not replay immediately after host restart", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opendeck-replay-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const h = fixture({ dir });
  h.evaluate();
  h.monitor.close();
  h.advance(600000);
  const restored = new MonitorAlerts({ dir, clock: () => h.now }),
    evaluate = () =>
      restored.evaluate(h.config, {
        grafana: {
          widgets: {
            cpu: { projects: { prod: sample(h.now) } },
            db: { projects: { prod: sample(h.now) } },
          },
        },
      });
  evaluate();
  assert.equal(restored.notifications.length, 0);
  h.advance(59000);
  evaluate();
  assert.equal(restored.notifications.length, 0);
  h.advance(1000);
  evaluate();
  assert.equal(restored.notifications.length, 1);
});
test("source scoping prevents an unrelated profile from reading or changing an incident", () => {
  const h = fixture();
  h.values.db.cpu.value = 30;
  const id = h.evaluate().inbox.incidents[0].id;
  assert.equal(h.monitor.inbox(h.config, ["db"]).incidents.length, 0);
  assert.throws(
    () => h.monitor.act(h.config, id, { action: "acknowledge" }, ["db"]),
    (e) => e.status === 404,
  );
  const scoped = h.monitor.inbox(h.config, ["cpu"]);
  assert.deepEqual(scoped.incidents[0].widgetIds, ["cpu"]);
  for (const payload of [
    null,
    [],
    {},
    { action: "delete" },
    { action: "snooze", minutes: 31 },
    { action: "acknowledge", minutes: 30 },
    { action: "snooze", extra: true },
  ])
    assert.throws(() => h.monitor.act(h.config, id, payload));
  assert.throws(
    () =>
      h.monitor.act(h.config, "incident-" + "0".repeat(32), {
        action: "acknowledge",
      }),
    (e) => e.status === 404,
  );
});
test("synthetic test incidents are separate, persistent, bounded, and recover without touching real alerts", () => {
  const h = fixture();
  h.evaluate();
  const real = h.monitor.inbox(h.config).incidents[0];
  const test = h.monitor.testNotification(h.config.pages[0], h.cpu);
  assert.equal(test.synthetic, true);
  assert.notEqual(test.id, real.id);
  h.monitor.act(h.config, test.id, { action: "snooze" });
  h.advance(1800000);
  h.evaluate();
  assert.equal(h.monitor.incidents.get(test.id).snoozedUntil, null);
  assert.equal(h.monitor.incidents.get(test.id).timeline.at(-1).type, "resume");
  h.monitor.testNotification(h.config.pages[0], h.cpu, "recover");
  assert.equal(h.monitor.incidents.get(test.id).status, "resolved");
  assert.equal(h.monitor.incidents.get(real.id).status, "active");
  for (let i = 0; i < 120; i++)
    h.monitor.testNotification(h.config.pages[0], h.cpu);
  assert.equal(h.monitor.incidents.get(test.id).timeline.length, 40);
  assert.equal(h.monitor.notifications.length, 40);
  h.monitor.testNotification(h.config.pages[0], h.cpu, "recover");
  h.advance(31 * 86400000);
  h.evaluate();
  assert.equal(h.monitor.incidents.has(test.id), false);
});
test("optional service rules are opt-in, independently validate units, and reject missing source timestamps", () => {
  const h = fixture();
  h.config.pages[0].widgets = [h.cpu];
  for (const key of ["latency", "errorRate", "rps"])
    assert.equal(monitorSettings(h.cpu).rules[key].enabled, false);
  h.cpu.alerts.rules = {
    latency: { enabled: true, warning: 500, critical: 1000 },
    errorRate: { enabled: true, warning: 1, critical: 5 },
  };
  validateMonitorSettings(h.cpu);
  h.values.cpu.system.value = 10;
  h.values.cpu.service = { latency: { value: 1200 }, errorRate: { value: 10 } };
  h.values.cpu.freshness = {
    latency: { status: "fresh" },
    errorRate: { status: "missing" },
  };
  const s = h.evaluate();
  assert.equal(s.widgets.cpu.projects.prod.metrics.latency.level, "critical");
  assert.equal(s.widgets.cpu.projects.prod.metrics.errorRate.level, "unknown");
  assert.throws(() =>
    validateMonitorSettings({
      ...h.cpu,
      alerts: {
        rules: { errorRate: { enabled: true, warning: 99, critical: 101 } },
      },
    }),
  );
});
test("active incidents are capped without evicting and replaying existing alerts", () => {
  let now = 1000000;
  const monitor = new MonitorAlerts({ clock: () => now });
  const widgets = Array.from({ length: 110 }, (_, i) =>
    widget("w" + i, "system", `https://metrics.example/d/source${i}/dashboard`),
  );
  const config = { pages: [{ id: "p", widgets }] };
  const evaluate = () =>
    monitor.evaluate(config, {
      grafana: {
        widgets: Object.fromEntries(
          widgets.map((w) => [w.id, { projects: { prod: sample(now) } }]),
        ),
      },
    });
  assert.equal(evaluate().inbox.incidents.length, 100);
  const ids = [...monitor.incidents.keys()],
    notificationIds = monitor.notifications.map((n) => n.id);
  now += 1000;
  evaluate();
  assert.deepEqual([...monitor.incidents.keys()], ids);
  assert.deepEqual(
    monitor.notifications.map((n) => n.id),
    notificationIds,
  );
});
test("notify false retains grouped history, and restoring source gaps does not imply recovery", () => {
  const h = fixture();
  h.cpu.alerts.notify = false;
  h.db.alerts.notify = false;
  let r = h.evaluate();
  assert.equal(r.inbox.activeCount, 1);
  assert.equal(r.notifications.length, 0);
  h.values.cpu.freshness = { system: { status: "missing" } };
  h.values.db.freshness = { cpu: { status: "fresh", missingSeries: 1 } };
  r = h.evaluate();
  assert.equal(r.inbox.incidents[0].status, "active");
  assert.equal(r.inbox.incidents[0].stale, true);
  assert.equal(r.notifications.length, 0);
});
test("fresh confirmed CPU danger still notifies while a different enabled service metric is missing", () => {
  const h = fixture();
  h.config.pages[0].widgets = [h.cpu];
  h.cpu.alerts.rules = {
    errorRate: { enabled: true, warning: 1, critical: 5 },
  };
  h.values.cpu.freshness = {
    system: { status: "fresh" },
    errorRate: { status: "missing" },
  };
  let state = h.evaluate();
  assert.equal(state.inbox.incidents[0].stale, true);
  assert.equal(state.notifications.length, 1);
  assert.match(state.notifications[0].body, /CPU/);
  h.values.cpu.freshness.system.status = "missing";
  h.advance(120000);
  state = h.evaluate();
  assert.equal(state.notifications.length, 1);
  assert.equal(state.inbox.incidents[0].status, "active");
  h.values.cpu.service = { errorRate: { value: 10 } };
  h.values.cpu.freshness.errorRate.status = "fresh";
  state = h.evaluate();
  assert.equal(state.notifications.length, 2);
  assert.match(state.notifications.at(-1).body, /5xx/);
  assert.doesNotMatch(state.notifications.at(-1).body, /CPU/);
});
test("an unmuted healthy sibling does not notify for a muted widget's danger or recovery", () => {
  const h = fixture();
  h.cpu.alerts.notify = false;
  h.values.db.cpu.value = 30;
  assert.equal(h.evaluate().notifications.length, 0);
  h.values.cpu.system.value = 30;
  assert.equal(h.evaluate().inbox.incidents[0].status, "resolved");
  assert.equal(h.monitor.notifications.length, 0);
});
test("identical collected samples keep incident JSON stable across repeated snapshot reads", () => {
  let now = 1000000;
  const h = fixture(),
    monitor = new MonitorAlerts({ clock: () => now });
  const data = {
    grafana: {
      widgets: {
        cpu: { projects: { prod: sample(now) } },
        db: { projects: { prod: sample(now) } },
      },
    },
  };
  const original = JSON.stringify(monitor.evaluate(h.config, data).inbox);
  monitor.dirty = false;
  now += 1000;
  assert.equal(
    JSON.stringify(monitor.evaluate(h.config, data).inbox),
    original,
  );
  assert.equal(monitor.dirty, false);
});
test("synthetic incidents do not become collection-stale after restart", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opendeck-synthetic-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const h = fixture({ dir });
  h.monitor.testNotification(h.config.pages[0], h.cpu);
  h.monitor.close();
  const restored = new MonitorAlerts({ dir, clock: () => h.now });
  const record = restored
    .evaluate(h.config, {})
    .inbox.incidents.find((r) => r.synthetic);
  assert.equal(record.stale, false);
  assert.equal(restored.notifications.length, 0);
});
test("scoped severity follows visible conditions instead of a hidden sibling's critical state", () => {
  const h = fixture();
  h.values.cpu.system.value = 85;
  h.evaluate();
  assert.equal(h.monitor.inbox(h.config).incidents[0].severity, "critical");
  assert.equal(
    h.monitor.inbox(h.config, ["cpu"]).incidents[0].severity,
    "warning",
  );
});
test("history I/O failures do not throw through snapshots or close, and failed ACK rolls back", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opendeck-disk-failure-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const errors = [],
    h = fixture({ dir, onError: (operation) => errors.push(operation) });
  const record = h.evaluate().inbox.incidents[0];
  const diskBefore = fs.readFileSync(h.monitor.file, "utf8"),
    originalPath = h.monitor.file;
  const occupied = path.join(dir, "not-a-directory");
  fs.writeFileSync(occupied, "fixture");
  h.monitor.file = path.join(occupied, "history.json");
  h.advance(10000);
  assert.doesNotThrow(() => h.evaluate());
  assert.equal(h.monitor.storageError, true);
  assert.deepEqual(errors, ["write"]);
  assert.throws(
    () => h.monitor.act(h.config, record.id, { action: "acknowledge" }),
    (e) => e.status === 503,
  );
  assert.equal(h.monitor.incidents.get(record.id).acknowledgedAt, null);
  assert.equal(fs.readFileSync(originalPath, "utf8"), diskBefore);
  assert.doesNotThrow(() => h.monitor.close());
  assert.deepEqual(errors, ["write"]);
  h.monitor.file = originalPath;
  assert.ok(
    h.monitor.act(h.config, record.id, { action: "acknowledge" }).incident
      .acknowledgedAt,
  );
  assert.equal(h.monitor.storageError, false);
});
test("maximum UTF-8 labels at the retained bounds fit the same writer/reader byte budget", (t) => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "opendeck-history-budget-"),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const h = fixture({ dir }),
    seed = h.evaluate().inbox.incidents[0];
  h.monitor.incidents.clear();
  for (let i = 0; i < 100; i++) {
    const r = {
      ...structuredClone(seed),
      id: "incident-" + i.toString(16).padStart(32, "0"),
      project: "가".repeat(128),
      title: "가".repeat(160),
      label: "가".repeat(160),
      conditions: Array.from({ length: 32 }, (_, n) => ({
        key: "가".repeat(40),
        label: "가".repeat(160),
        widgetId: "나".repeat(125) + String(n).padStart(3, "0"),
        level: "critical",
        value: 123456789012345,
      })),
      timeline: Array.from({ length: 40 }, () => ({
        type: "snooze",
        at: 9999999999999,
        until: 9999999999999,
        severity: "critical",
      })),
      pageIds: Array(40).fill("가".repeat(128)),
      widgetIds: Array(128).fill("나".repeat(128)),
    };
    h.monitor.incidents.set(r.id, r);
  }
  h.monitor.dirty = true;
  assert.equal(h.monitor.persist(true), true);
  const bytes = fs.statSync(h.monitor.file).size;
  assert.ok(bytes < 4 * 1024 * 1024, `history ${bytes} bytes`);
  const restored = new MonitorAlerts({ dir, clock: () => h.now });
  assert.equal(restored.incidents.size, 100);
  assert.equal(restored.storageError, false);
});
test("incident action response stays small even with full retained history", () => {
  const h = fixture();
  const seed = h.evaluate().inbox.incidents[0];
  for (let i = 0; i < 100; i++)
    h.monitor.incidents.set("incident-" + i.toString(16).padStart(32, "0"), {
      ...structuredClone(seed),
      id: "incident-" + i.toString(16).padStart(32, "0"),
      timeline: Array.from({ length: 40 }, () => ({
        type: "occurrence",
        at: h.now,
        severity: "critical",
      })),
    });
  const result = h.monitor.act(h.config, seed.id, { action: "acknowledge" });
  assert.equal(Object.hasOwn(result, "inbox"), false);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 32 * 1024);
});
