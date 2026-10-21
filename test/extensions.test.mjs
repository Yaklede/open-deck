import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  JiminOS,
  sanitizeSnapshot,
} from "../host/extensions/jimin-os/index.mjs";
import { Extensions, osPage } from "../host/extensions.mjs";
import { defaultConfig, validateConfig } from "../host/config.mjs";
import { createHost, deviceConfig } from "../host/server.mjs";
const id = "019f68cb-9400-7000-8000-000000000001",
  other = "019f68cb-9400-7000-8000-000000000002";
const snapshot = () => ({
  schemaVersion: 1,
  connected: true,
  updatedAt: Date.now(),
  counts: { requests: 1 },
  range: { from: new Date().toISOString(), to: new Date().toISOString() },
  events: [],
  tasks: [],
  inbox: [],
  routines: [],
});
function setup(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-os-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bridgePath = path.join(dir, "bridge.json");
  fs.writeFileSync(
    bridgePath,
    JSON.stringify({ protocol: 1, port: 12345, token: "a".repeat(64) }),
    { mode: 0o600 },
  );
  let data = snapshot(),
    options = { enabled: true, notifications: true };
  const calls = [],
    notifications = [];
  const p = new JiminOS({
    dir,
    bridgePath,
    getOptions: () => options,
    onNotification: (n) => notifications.push(n),
    fetcher: async (url, init) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify(url.endsWith("snapshot") ? data : { ok: true }),
      );
    },
    ...extra,
  });
  t.after(() => p.close());
  return {
    p,
    dir,
    bridgePath,
    calls,
    notifications,
    setData: (v) => (data = v),
    setOptions: (v) => (options = v),
  };
}
test("snapshot copies only minimal fields and tolerates malformed lists", () => {
  const source = snapshot();
  source.events = [
    {
      id,
      title: "Meeting",
      startsAt: new Date().toISOString(),
      endsAt: new Date().toISOString(),
      notes: "PRIVATE_NOTE",
      accessToken: "PRIVATE_TOKEN",
    },
  ];
  source.inbox = { accessToken: "PRIVATE_TOKEN" };
  source.accessToken = "PRIVATE_TOKEN";
  const s = sanitizeSnapshot(source);
  assert.equal(s.events[0].title, "Meeting");
  assert.deepEqual(s.inbox, []);
  assert(!JSON.stringify(s).includes("PRIVATE_"));
  assert.throws(() =>
    sanitizeSnapshot({ ...source, updatedAt: Date.now() - 180000 }),
  );
  assert.throws(() => sanitizeSnapshot({ ...source, connected: false }));
});
test("bridge accepts only owned private regular descriptor files and loopback bearer requests", async (t) => {
  const h = setup(t);
  await h.p.poll();
  assert.equal(h.p.status, "connected");
  assert.equal(h.calls[0].url, "http://127.0.0.1:12345/v1/snapshot");
  assert.equal(h.calls[0].init.redirect, "error");
  assert.equal(
    h.calls[0].init.headers.Authorization,
    "Bearer " + "a".repeat(64),
  );
  fs.chmodSync(h.bridgePath, 0o644);
  await h.p.poll();
  assert.equal(h.p.status, "disconnected");
  assert.equal(h.p.data, null);
  fs.chmodSync(h.bridgePath, 0o600);
  fs.renameSync(h.bridgePath, h.bridgePath + ".real");
  fs.symlinkSync(h.bridgePath + ".real", h.bridgePath);
  assert.throws(() => h.p.descriptor());
});
test("initial inbox is quiet, new requests notify once, and dedup survives restart", async (t) => {
  const h = setup(t);
  h.setData({
    ...snapshot(),
    inbox: [{ id, title: "First", kind: "request", revision: 1 }],
  });
  await h.p.poll();
  assert.equal(h.notifications.length, 0);
  h.setData({
    ...snapshot(),
    inbox: [
      { id, title: "First", kind: "request", revision: 2 },
      { id: other, title: "New", kind: "request", revision: 1 },
    ],
  });
  await h.p.poll();
  assert.equal(h.notifications.length, 2);
  await h.p.poll();
  assert.equal(h.notifications.length, 2);
  const p = new JiminOS({ dir: h.dir });
  assert.equal(p.seen.size, 3);
  assert.equal(p.baselined, true);
});
test("calendar and deadline reminders respect lead time and suppress repeats", async (t) => {
  const now = Date.now();
  const h = setup(t, { clock: () => now });
  h.setData({
    ...snapshot(),
    events: [
      {
        id,
        title: "Soon",
        startsAt: new Date(now + 300000).toISOString(),
        endsAt: new Date(now + 600000).toISOString(),
      },
    ],
    tasks: [
      { id: other, title: "Due", dueAt: new Date(now + 240000).toISOString() },
    ],
  });
  await h.p.poll();
  await h.p.poll();
  assert.deepEqual(
    h.notifications.map((n) => n.entity.kind),
    ["schedule", "task"],
  );
  h.setOptions({ enabled: true, notifications: false });
  h.setData({
    ...snapshot(),
    tasks: [
      { id, title: "Silent", dueAt: new Date(now + 240000).toISOString() },
    ],
  });
  await h.p.poll();
  assert.equal(h.notifications.length, 2);
  h.setOptions({ enabled: false });
  await h.p.poll();
  assert.equal(h.p.status, "disabled");
  assert.equal(h.p.data, null);
});
test("actions reject arbitrary commands, views and entities outside the shared snapshot", async (t) => {
  const h = setup(t);
  await h.p.poll();
  await assert.rejects(h.p.invoke("command", { value: "x" }));
  await assert.rejects(h.p.invoke("navigate", { view: "https://evil" }));
  await assert.rejects(h.p.invoke("open-schedule", { itemId: id }));
  await h.p.invoke("navigate", { view: "scheduled" });
  const action = JSON.parse(h.calls.at(-1).init.body);
  assert.deepEqual(action, { operation: "navigate", view: "scheduled" });
});
test("repeated extension actions are dropped without a queue", async (t) => {
  let done;
  const h = setup(t, {
    fetcher: () =>
      new Promise(
        (resolve) => (done = () => resolve(new Response('{"ok":true}'))),
      ),
  });
  const first = h.p.invoke("navigate", { view: "calendar" });
  assert.deepEqual(await h.p.invoke("navigate", { view: "calendar" }), {
    ignored: true,
  });
  done();
  await first;
  assert.equal(h.p.activeActions.size, 0);
});
test("OS page has valid non-overlapping geometry and device config strips private settings", () => {
  const c = defaultConfig();
  c.pages[0].widgets[0].id = "jimin-os";
  c.pages.push(osPage());
  c.extensions = {
    "jimin-os": { enabled: true, notifications: true, reminderMinutes: 10 },
  };
  assert.equal(validateConfig(c).pages.at(-1).name, "OS");
  assert.equal(osPage().widgets.length, 11);
  assert.equal(deviceConfig(c).extensions, undefined);
  for (const w of deviceConfig(c).pages.at(-1).widgets)
    assert.equal(w.actions, undefined);
});
test("extension notifications persist as a bounded private feed", (t) => {
  const h = setup(t),
    c = defaultConfig();
  const e = new Extensions({
    dir: h.dir,
    getConfig: () => c,
    onChange: () => {},
  });
  t.after(() => e.close());
  for (let i = 0; i < 45; i++)
    e.notify({ id: String(i), createdAt: Date.now(), title: "test" });
  assert.equal(e.notifications.length, 40);
  assert.equal(fs.statSync(e.file).mode & 0o077, 0);
});
test("admin settings are authenticated and invalid updates leave live config intact", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-os-http-"));
  const h = createHost({ dir, metrics: false });
  await new Promise((resolve) => h.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await h.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = "http://127.0.0.1:" + h.server.address().port;
  const req = (body, key = h.adminKey) =>
    fetch(base + "/api/admin/extensions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Open-Deck-Admin": key },
      body: JSON.stringify(body),
    });
  assert.equal((await req({ id: "jimin-os" }, "bad")).status, 403);
  assert.equal(
    (await req({ id: "jimin-os", addPage: true, reminderMinutes: 999 })).status,
    400,
  );
  const info = await (
    await fetch(base + "/api/admin/info", {
      headers: { "X-Open-Deck-Admin": h.adminKey },
    })
  ).json();
  assert(!info.config.pages.some((x) => x.id === "jimin-os-page"));
  const response = await req({ id: "jimin-os", addPage: true });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).config.pages.at(-1).name, "OS");
  const paired = await (
    await fetch(base + "/api/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: h.getPin() }),
    })
  ).json();
  const action = await fetch(base + "/api/action", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + paired.token,
    },
    body: JSON.stringify({
      kind: "extension",
      id: "os-calendar",
      operation: "navigate",
      view: "assistant",
    }),
  });
  assert.equal(action.status, 400);
});
