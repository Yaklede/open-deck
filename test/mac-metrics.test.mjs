import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeSystemSample, MacMetrics } from "../host/mac-metrics.mjs";
import { monitorPage } from "../host/public/monitor-layout.mjs";
import { defaultConfig, validateConfig } from "../host/config.mjs";
import { deviceConfig } from "../host/server.mjs";
const sample = () => ({
  schemaVersion: 1,
  capturedAt: 100000,
  model: "Apple Silicon",
  logicalCores: 12,
  uptimeSeconds: 123,
  cpu: { percent: 20, cores: [10, 30] },
  memory: {
    totalBytes: 48000,
    usedBytes: 40000,
    compressedBytes: 2000,
    swapBytes: 0,
    pressure: "warning",
  },
  disk: { totalBytes: 100000, availableBytes: 10000, freeBytes: 10000 },
  network: {
    rxBytesPerSecond: 500,
    txBytesPerSecond: 200,
    interfaces: ["en0", "lo0", "utun0"],
  },
  processes: {
    count: 2,
    cpu: [
      {
        pid: 123,
        name: "App",
        cpuPercent: 140,
        memoryBytes: 500,
        argv: "PRIVATE",
        path: "/PRIVATE",
      },
    ],
    memory: [],
  },
  power: { thermal: "normal", batteryPercent: 100, pluggedIn: true },
  secret: "PRIVATE",
});
test("system telemetry preserves unknowns, pressure and multicore process CPU without sharing arguments", () => {
  const s = sanitizeSystemSample(sample(), 100000);
  assert.equal(s.memory.swapBytes, 0);
  assert.equal(s.memory.pressure, "warning");
  assert.equal(s.io.readBytesPerSecond, null);
  assert.equal(s.processes.cpu[0].cpuPercent, 140);
  assert.deepEqual(s.network.interfaces, ["en0"]);
  assert(!JSON.stringify(s).includes("PRIVATE"));
  assert.throws(() => sanitizeSystemSample(sample(), 120000));
  const invalid = sample();
  invalid.cpu.percent = 101;
  invalid.network.rxBytesPerSecond = -1;
  const result = sanitizeSystemSample(invalid, 100000);
  assert.equal(result.cpu.percent, null);
  assert.equal(result.network.rxBytesPerSecond, null);
});
test("stale telemetry disappears instead of retaining a live-looking last value, history stays bounded", () => {
  let time = 100000,
    changed = 0;
  const metrics = new MacMetrics(() => changed++, {
    platform: "linux",
    clock: () => time,
  });
  for (let i = 0; i < 150; i++)
    metrics.accept({ ...sample(), capturedAt: time++ });
  assert.equal(metrics.state().history.cpu.length, 120);
  assert.equal(metrics.state().history.battery.length, 120);
  assert(metrics.state().history.battery.every((v) => v === 100));
  assert(metrics.state().history.read.every((v) => v === null));
  assert(metrics.state().history.write.every((v) => v === null));
  assert.equal(changed, 150);
  time += 9000;
  assert.deepEqual(metrics.state(), { status: "stale", capturedAt: 100149 });
  metrics.close();
});
test("monitor template has actual system roles, no calendar, and editable scoped Grafana projects", () => {
  const c = defaultConfig();
  const page = monitorPage({
    id: "monitor",
    grafana: {
      url: "https://grafana.example/d/system",
      projects: [
        { label: "Biscuit Link", value: "everypay" },
        { label: "BTECA", value: "bteca" },
      ],
      defaultProject: "everypay",
    },
  });
  c.pages.push(page);
  assert.equal(validateConfig(c).pages.at(-1).widgets.length, 3);
  assert(!page.widgets.some((w) => w.type === "calendar"));
  assert.equal(page.widgets.filter((w) => w.type === "system").length, 1);
  assert(page.widgets.find((w) => w.type === "system").compact);
  assert.equal(page.widgets[0].projectGroup, page.widgets[1].projectGroup);
  const exposed = deviceConfig(c)
    .pages.at(-1)
    .widgets.find((w) => w.type === "grafana");
  assert.equal(exposed.defaultProject, "everypay");
  assert.equal(exposed.actions, undefined);
  const g = page.widgets.find(
    (w) => w.type === "grafana" && w.metric === "database",
  );
  g.url = "https://user:password@grafana.example";
  assert.throws(() => validateConfig(c));
  g.url = "https://grafana.example";
  g.defaultProject = "absent";
  assert.throws(() => validateConfig(c));
  g.defaultProject = "everypay";
  g.projects.push({ label: "Wrong", value: "everypay" });
  assert.throws(() => validateConfig(c));
});
