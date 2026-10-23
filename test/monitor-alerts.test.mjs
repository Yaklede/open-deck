import { test } from "node:test";
import assert from "node:assert/strict";
import { MonitorAlerts } from "../host/monitor-alerts.mjs";
import {
  monitorLevel,
  monitorSettings,
  validateMonitorSettings,
} from "../host/public/monitor-rules.mjs";
const widget = () => ({
  id: "db",
  type: "grafana",
  metric: "database",
  label: "Database",
  projects: [
    { value: "a", label: "A" },
    { value: "b", label: "B" },
  ],
  alerts: { holdSeconds: 60, cooldownSeconds: 120 },
});
const sample = (at, cpu = 30) => ({
  status: "ready",
  capturedAt: at,
  cpu: { value: cpu },
  memory: { value: 60 },
  tps: { value: 10 },
  qps: { value: 100 },
  database: { ready: true, connections: 40 },
});
function harness(w = widget()) {
  let time = 1000000;
  const alerts = new MonitorAlerts({ clock: () => time });
  const config = { pages: [{ id: "monitor", widgets: [w] }] };
  const values = { a: sample(time), b: sample(time) };
  const evaluate = () =>
    alerts.evaluate(config, {
      grafana: { widgets: { db: { projects: values } } },
    });
  return {
    alerts,
    w,
    values,
    config,
    evaluate,
    advance(ms) {
      time += ms;
      for (const data of Object.values(values)) data.capturedAt = time;
    },
    get now() {
      return time;
    },
  };
}
test("thresholds support inclusive high/low warning and critical values; zero and missing stay distinct", () => {
  const rule = { enabled: true, direction: "above", warning: 80, critical: 90 };
  assert.equal(monitorLevel(80, rule), "warning");
  assert.equal(monitorLevel(90, rule), "critical");
  assert.equal(monitorLevel(null, rule), "unknown");
  const low = { ...rule, direction: "below", warning: 5, critical: 1 };
  assert.equal(monitorLevel(0, low), "critical");
  assert.equal(monitorLevel(5, low), "warning");
  assert.equal(monitorLevel(6, low), "normal");
  assert.equal(monitorSettings(widget()).rules.qps.enabled, false);
});
test("brief spikes do not notify; sustained danger, cooldown and recovery notify once per transition", () => {
  const h = harness();
  h.values.a.cpu.value = 95;
  h.evaluate();
  h.advance(30000);
  h.values.a.cpu.value = 30;
  h.evaluate();
  assert.equal(h.alerts.notifications.length, 0);
  h.values.a.cpu.value = 95;
  h.evaluate();
  h.advance(60000);
  h.evaluate();
  assert.equal(h.alerts.notifications.length, 1);
  assert.equal(h.alerts.notifications[0].severity, "critical");
  h.evaluate();
  assert.equal(h.alerts.notifications.length, 1);
  h.advance(119000);
  h.evaluate();
  assert.equal(h.alerts.notifications.length, 1);
  h.advance(1000);
  h.evaluate();
  assert.equal(h.alerts.notifications.length, 2);
  h.values.a.cpu.value = 30;
  h.evaluate();
  h.advance(60000);
  h.evaluate();
  assert.equal(h.alerts.notifications.length, 3);
  assert.equal(h.alerts.notifications.at(-1).severity, "normal");
});
test("projects stay isolated and missing or stale data cannot trigger or complete a danger hold", () => {
  const h = harness();
  h.values.a.cpu.value = 95;
  h.evaluate();
  h.advance(30000);
  h.values.a = { status: "error" };
  h.evaluate();
  h.advance(60000);
  h.values.a = sample(h.now, 95);
  h.evaluate();
  assert.equal(h.alerts.notifications.length, 0);
  h.advance(60000);
  const state = h.evaluate();
  assert.equal(h.alerts.notifications.length, 1);
  assert.equal(state.widgets.db.projects.b.level, "normal");
  assert.equal(h.alerts.notifications[0].project, "a");
  h.values.a.capturedAt = h.now - 90001;
  assert.equal(h.evaluate().widgets.db.projects.a.level, "unknown");
});
test("low TPS rules and DB not-ready failures are independent; notifications can be muted without removing colors", () => {
  const w = widget();
  w.alerts.holdSeconds = 0;
  w.alerts.notify = false;
  w.alerts.rules = {
    tps: { enabled: true, direction: "below", warning: 3, critical: 1 },
  };
  const h = harness(w);
  h.values.a.tps.value = 0;
  let result = h.evaluate();
  assert.equal(result.widgets.db.projects.a.metrics.tps.level, "critical");
  assert.equal(h.alerts.notifications.length, 0);
  h.values.a.tps.value = null;
  h.values.a.database.ready = false;
  result = h.evaluate();
  assert.equal(result.widgets.db.projects.a.level, "critical");
  assert.equal(result.widgets.db.projects.a.metrics.tps.level, "unknown");
});
test("Mac CPU and actual used/total memory ratios share threshold rules and hide disconnected samples", () => {
  let time = 1000000;
  const monitor = new MonitorAlerts({ clock: () => time });
  const w = { id: "mac", type: "system", alerts: { holdSeconds: 0 } };
  const config = { pages: [{ id: "p", widgets: [w] }] };
  const system = {
    status: "connected",
    capturedAt: time,
    cpu: { percent: 91 },
    memory: { usedBytes: 96, totalBytes: 100 },
  };
  let result = monitor.evaluate(config, { system });
  assert.equal(result.widgets.mac.projects.mac.metrics.memory.value, 96);
  assert.equal(result.widgets.mac.projects.mac.level, "critical");
  assert.equal(result.notifications.length, 1);
  time += 10001;
  result = monitor.evaluate(config, { system });
  assert.equal(result.widgets.mac.projects.mac.level, "unknown");
  assert.equal(result.notifications.length, 1);
});
test("settings reject reversed, missing and out-of-range thresholds and preserve disabled optional metrics", () => {
  const w = widget();
  validateMonitorSettings(w);
  for (const settings of [
    { holdSeconds: -1 },
    { cooldownSeconds: 10 },
    { rules: { cpu: { enabled: true, warning: 95, critical: 80 } } },
    { rules: { memory: { enabled: true, warning: 101, critical: 110 } } },
    { rules: { tps: { enabled: true, warning: null, critical: null } } },
    { rules: { bogus: { enabled: true } } },
  ]) {
    assert.throws(() => validateMonitorSettings({ ...w, alerts: settings }));
  }
  validateMonitorSettings({
    ...w,
    alerts: {
      rules: {
        tps: { enabled: true, direction: "below", warning: 5, critical: 1 },
      },
    },
  });
});
test("test notifications are labeled, bounded and removed widgets do not keep incident state", () => {
  const h = harness();
  h.evaluate();
  for (let i = 0; i < 45; i++)
    h.alerts.testNotification(h.config.pages[0], h.w);
  h.evaluate();
  assert.equal(h.alerts.notifications.length, 40);
  assert.match(h.alerts.notifications[0].body, /실제 장애 알림이 아닙니다/);
  h.config.pages[0].widgets = [];
  h.evaluate();
  assert.equal(h.alerts.incidents.size, 0);
});

test("a different sustained critical metric gets its own alert before the repeat cooldown", () => {
  const h = harness();
  h.values.a.cpu.value = 95;
  h.evaluate();
  h.advance(60000);
  h.evaluate();
  assert.equal(h.alerts.notifications.length, 1);
  h.values.a.cpu.value = 30;
  h.values.a.memory.value = 98;
  h.evaluate();
  h.advance(60000);
  h.evaluate();
  assert.equal(h.alerts.notifications.length, 2);
  assert.match(h.alerts.notifications.at(-1).body, /MEM/);
});

test("successful queries cannot continue a CPU danger hold when source collection is delayed", () => {
  const h = harness();
  h.values.a.cpu.value = 95;
  h.values.a.freshness = { cpu: { status: "fresh" } };
  h.evaluate();
  h.advance(60000);
  h.values.a.freshness.cpu.status = "delayed";
  h.evaluate();
  assert.equal(h.alerts.notifications.length, 0);
  assert.equal(h.alerts.widgets.db.projects.a.metrics.cpu.level, "unknown");
  h.values.a.freshness.cpu.status = "fresh";
  h.evaluate();
  h.advance(60000);
  h.evaluate();
  assert.equal(h.alerts.notifications.length, 1);
});
