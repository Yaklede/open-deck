import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrate, place, overlaps } from "../host/public/layout.mjs";
import {
  validateConfig,
  defaultConfig,
  loadConfig,
  writeJson,
} from "../host/config.mjs";
import { Engine } from "../host/engine.mjs";
import { Scheduler } from "../host/scheduler.mjs";
import { httpRequest, Connectors } from "../host/connectors.mjs";
import { saveAsset, readAsset } from "../host/assets.mjs";
import { deviceConfig, createHost } from "../host/server.mjs";
const legacy = () => ({
  version: 1,
  name: "test",
  columns: 4,
  pages: [
    {
      id: "main",
      name: "Main",
      widgets: Array.from({ length: 12 }, (_, i) => ({
        id: "b" + i,
        type: "button",
        label: "B" + i,
        actions: [{ type: "openApp", value: "Fake.app" }],
      })),
    },
  ],
  automations: [],
});
test("v1 migration keeps all actions and positions twelve buttons in original order", () => {
  const original = legacy();
  const c = validateConfig(original);
  assert.equal(original.version, 1);
  assert.equal(c.version, 2);
  assert.equal(c.pages[0].rows, 3);
  c.pages[0].widgets.forEach((w, i) => {
    assert.deepEqual([w.x, w.y, w.w, w.h], [i % 4, Math.floor(i / 4), 1, 1]);
    assert.deepEqual(w.actions, original.pages[0].widgets[i].actions);
  });
  assert.deepEqual(migrate(c), c);
});
test("v2 migration is backed up on disk exactly once", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "od-layout-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeJson(path.join(dir, "deck.json"), legacy());
  assert.equal(loadConfig(dir).version, 2);
  const backup = fs.readFileSync(path.join(dir, "deck-before-v2.json"), "utf8");
  loadConfig(dir);
  assert.equal(
    fs.readFileSync(path.join(dir, "deck-before-v2.json"), "utf8"),
    backup,
  );
});
test("different grids preserve spans and pack portrait without overlaps", () => {
  const widgets = [
    { x: 0, y: 0, w: 3, h: 2 },
    { x: 3, y: 0, w: 1, h: 1 },
    { x: 0, y: 2, w: 2, h: 1 },
  ];
  const rows = place(widgets, 2, 1, false);
  assert.equal(rows, 4);
  assert.equal(widgets[0].w, 2);
  for (let i = 0; i < widgets.length; i++)
    for (let j = i + 1; j < widgets.length; j++)
      assert(!overlaps(widgets[i], widgets[j]));
});
test("validator rejects overlap, out-of-bounds style, folder cycles, bad connector IDs", () => {
  const c = validateConfig(legacy());
  const invalid = (fn) => {
    const v = structuredClone(c);
    fn(v);
    assert.throws(() => validateConfig(v));
  };
  invalid((v) => (v.pages[0].widgets[1].x = 0));
  invalid((v) => (v.pages[0].widgets[0].style.textSize = 99));
  invalid((v) => (v.pages[0].parentId = "main"));
  invalid((v) =>
    v.integrations.push({
      id: "../secret",
      type: "http",
      name: "test",
      url: "https://example.com",
    }),
  );
});
function controls() {
  const c = defaultConfig();
  c.variables = { enabled: false, level: 10, count: 0 };
  c.pages[0].widgets = [
    {
      id: "toggle",
      type: "toggle",
      label: "Enabled",
      binding: "enabled",
      x: 0,
      y: 0,
      w: 1,
      h: 1,
    },
    {
      id: "slider",
      type: "slider",
      label: "Level",
      binding: "level",
      min: 0,
      max: 50,
      x: 1,
      y: 0,
      w: 1,
      h: 1,
    },
    { id: "todo", type: "todo", label: "Tasks", x: 2, y: 0, w: 1, h: 1 },
    {
      id: "increment",
      type: "button",
      label: "Count",
      x: 3,
      y: 0,
      w: 1,
      h: 1,
      actions: [{ type: "increment", variable: "count", value: 1 }],
    },
  ];
  return validateConfig(c);
}
test("typed controls and todos reject forged IDs and out-of-range values", () => {
  const e = new Engine(controls());
  assert.equal(e.control("toggle", true), true);
  assert.equal(e.control("slider", 30), 30);
  assert.throws(() => e.control("slider", 100));
  assert.throws(() => e.control("toggle", 1));
  assert.throws(() => e.control("missing", true));
  e.todo("todo", "add", "Example");
  const item = e.todos.todo[0];
  e.todo("todo", "toggle", item.id);
  assert.equal(item.done, true);
  e.todo("todo", "delete", item.id);
  assert.equal(e.todos.todo.length, 0);
  assert.throws(() => e.todo("toggle", "add", "Fake"));
});
test("variable automations execute matching transitions with cooldown, never initial configuration", async () => {
  const c = controls();
  c.automations = [
    {
      id: "auto",
      trigger: "variable",
      variable: "enabled",
      equals: true,
      widgetId: "increment",
      enabled: true,
      cooldownSeconds: 5,
    },
  ];
  const e = new Engine(validateConfig(c));
  assert.equal(e.variables.count, 0);
  e.control("toggle", true);
  await new Promise((r) => setImmediate(r));
  assert.equal(e.variables.count, 1);
  e.control("toggle", false);
  e.control("toggle", true);
  await new Promise((r) => setImmediate(r));
  assert.equal(e.variables.count, 1);
});
test("no selected weekdays means no execution; absent weekdays keeps legacy daily schedule", async () => {
  let n = 0;
  const c = {
    automations: [
      { id: "a", enabled: true, time: "09:00", days: [], widgetId: "b" },
    ],
  };
  const s = new Scheduler(
    () => c,
    () => n++,
  );
  s.tick(new Date(2026, 9, 21, 9));
  await new Promise((r) => setImmediate(r));
  assert.equal(n, 0);
  delete c.automations[0].days;
  s.tick(new Date(2026, 9, 21, 9));
  await new Promise((r) => setImmediate(r));
  assert.equal(n, 1);
});
test("HTTP connector selects a scalar, refuses objects and oversized bodies", async () => {
  assert.equal(
    await httpRequest(
      { url: "http://test", path: "data.count" },
      async () => new Response('{"data":{"count":7}}'),
    ),
    7,
  );
  await assert.rejects(
    httpRequest({ url: "http://test" }, async () => new Response('{"a":1}')),
  );
  await assert.rejects(
    httpRequest(
      { url: "http://test" },
      async () => new Response("x".repeat(524289)),
    ),
  );
});
test("POST webhook never auto-polls", () => {
  const c = new Connectors(
    () => ({
      integrations: [
        {
          id: "a",
          method: "POST",
          url: "http://test",
          enabled: true,
          variable: "v",
        },
      ],
    }),
    () => {},
    () => {},
  );
  let n = 0;
  c.run = () => {
    n++;
    return Promise.resolve();
  };
  c.tick();
  assert.equal(n, 0);
  c.close();
});
test("asset content hash round-trips and traversal is rejected", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "od-assets-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const a = saveAsset(dir, "data:image/png;base64," + png);
  assert.equal(a.id.length, 64);
  assert.equal(readAsset(dir, a.id).mime, "image/png");
  assert.throws(() => readAsset(dir, "../deck.json"));
  assert.throws(() => saveAsset(dir, "data:image/svg+xml;base64,PHN2Zz4="));
});
test("tablet config strips all gesture actions and connectors", () => {
  const c = controls();
  c.pages[0].widgets[3].longActions = [{ type: "command", value: "private" }];
  const d = deviceConfig(c);
  assert(!JSON.stringify(d).includes("private"));
  assert.equal(d.pages[0].widgets[3].gestures.long, true);
  assert.equal(d.integrations, undefined);
});
test("controls and todos persist across host restart", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "od-persist-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeJson(path.join(dir, "deck.json"), controls());
  let h = createHost({ dir, metrics: false });
  await new Promise((r) => h.server.listen(0, "127.0.0.1", r));
  h.engine.control("slider", 33);
  h.engine.todo("todo", "add", "Persistent");
  await h.close();
  h = createHost({ dir, metrics: false });
  await new Promise((r) => h.server.listen(0, "127.0.0.1", r));
  assert.equal(h.engine.variables.level, 33);
  assert.equal(h.engine.todos.todo[0].text, "Persistent");
  await h.close();
});
test("SSE sends configuration once, then state deltas; a save refreshes configuration", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "od-sse-"));
  const h = createHost({ dir, metrics: false });
  await new Promise((r) => h.server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + h.server.address().port;
  const abort = new AbortController();
  const res = await fetch(base + "/api/events", {
    headers: { "X-Open-Deck-Admin": h.adminKey },
    signal: abort.signal,
  });
  const reader = res.body.getReader();
  let buffer = "";
  async function next() {
    for (;;) {
      const match = buffer.match(/data: (.*)\n\n/);
      if (match) {
        buffer = buffer.slice(match.index + match[0].length);
        return JSON.parse(match[1]);
      }
      const r = await reader.read();
      buffer += Buffer.from(r.value).toString();
    }
  }
  try {
    assert((await next()).config);
    h.engine.onChange();
    assert.equal((await next()).config, undefined);
    const c = defaultConfig();
    c.name = "Updated";
    c.pages[0].name = "Renamed monitor";
    c.pages[0].widgets[0].label = "Changed tablet label";
    c.pages[0].widgets[0].style = { textSize: 24 };
    const saved = await fetch(base + "/api/admin/config", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "X-Open-Deck-Admin": h.adminKey,
      },
      body: JSON.stringify(c),
    });
    assert.equal(saved.status, 200);
    const refreshed = (await next()).config;
    assert.equal(refreshed.name, "Updated");
    assert.equal(refreshed.pages[0].name, "Renamed monitor");
    assert.equal(refreshed.pages[0].widgets[0].label, "Changed tablet label");
    assert.equal(refreshed.pages[0].widgets[0].style.textSize, 24);
  } finally {
    abort.abort();
    await h.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("editing a variable default persists the new current value before host restart", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "od-default-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeJson(path.join(dir, "deck.json"), controls());
  let h = createHost({ dir, metrics: false });
  await new Promise((r) => h.server.listen(0, "127.0.0.1", r));
  h.engine.control("slider", 33);
  const c = controls();
  c.variables.level = 42;
  const res = await fetch(
    "http://127.0.0.1:" + h.server.address().port + "/api/admin/config",
    {
      method: "PUT",
      headers: {
        "X-Open-Deck-Admin": h.adminKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(c),
    },
  );
  assert.equal(res.status, 200);
  assert.equal(h.engine.variables.level, 42);
  await h.close();
  h = createHost({ dir, metrics: false });
  await new Promise((r) => h.server.listen(0, "127.0.0.1", r));
  assert.equal(h.engine.variables.level, 42);
  await h.close();
});
