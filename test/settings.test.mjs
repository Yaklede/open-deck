import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHost } from "../host/server.mjs";
import {
  defaultSettings,
  mergeSettings,
  validateDeviceSettings,
  Diagnostics,
  releaseInfo,
  APP_VERSION,
} from "../host/settings.mjs";
import { defaultConfig, validateConfig } from "../host/config.mjs";
import { httpRequest } from "../host/connectors.mjs";

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opendeck-settings-"));
  const h = createHost({ dir, metrics: false, runner: async () => "" });
  await new Promise((r) => h.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await h.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const url = "http://127.0.0.1:" + h.server.address().port;
  const api = async (route, method = "GET", body, token) => {
    const r = await fetch(url + route, {
      method,
      headers: {
        ...(token
          ? { Authorization: "Bearer " + token }
          : { "X-Open-Deck-Admin": h.adminKey }),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, data: await r.json() };
  };
  const pair = async () => {
    const r = await api("/api/pair", "POST", { pin: h.getPin() });
    return r.data.token;
  };
  return { h, api, pair, dir };
}
test("settings reject unknown keys, invalid ports, unsafe values and preserve untouched fields", () => {
  const d = defaultSettings();
  assert.equal(
    mergeSettings(d, { appearance: { uiScale: 120 } }).appearance.uiScale,
    120,
  );
  assert.equal(d.appearance.uiScale, 100);
  for (const patch of [
    { network: { wifiPort: 8840 } },
    { network: { wifiPort: 80 } },
    { appearance: { accentColor: "red" } },
    { usb: { executablePath: "adb;rm" } },
    { logging: { minimumLevel: "verbose" } },
    { http: { userAgent: "a\r\nb" } },
    { bad: { x: 1 } },
    { startup: { autostart: "yes" } },
  ])
    assert.throws(() => mergeSettings(d, patch));
});
test("settings persist atomically and paired devices cannot read or change host settings", async (t) => {
  const { api, pair, dir } = await setup(t);
  const token = await pair();
  const patch = {
    appearance: { themeMode: "light", palette: ["#001122"] },
    backups: { schedule: "weekly", time: "11:30", dayOfWeek: 4 },
    http: { userAgent: "MyDeck/1" },
  };
  assert.equal((await api("/api/admin/settings", "PUT", patch)).status, 200);
  assert.equal(
    (await api("/api/admin/settings")).data.settings.http.userAgent,
    "MyDeck/1",
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dir, "preferences.json"))).backups
      .time,
    "11:30",
  );
  assert.equal(
    fs.statSync(path.join(dir, "preferences.json")).mode & 0o777,
    0o600,
  );
  assert.equal(
    (await api("/api/admin/settings", "GET", null, token)).status,
    403,
  );
  assert.equal(
    (await api("/api/admin/settings", "PUT", patch, token)).status,
    403,
  );
  assert.equal(
    (await api("/api/admin/settings", "PUT", { network: { wifiPort: 0 } }))
      .status,
    400,
  );
  assert.equal(
    (await api("/api/admin/settings")).data.settings.network.wifiPort,
    8841,
  );
});
test("per-device profile and display settings remain isolated and survive a new host instance", async (t) => {
  const { api, pair, dir, h } = await setup(t);
  const a = await pair(),
    b = await pair();
  const config = (await api("/api/admin/info")).data.config;
  const p = {
    id: "secondary",
    name: "보조",
    columns: 2,
    rows: 1,
    gap: 12,
    radius: 13,
    theme: "midnight",
    widgets: [
      {
        id: "secondary-button",
        type: "button",
        label: "Only here",
        x: 0,
        y: 0,
        w: 1,
        h: 1,
        style: {},
        actions: [],
      },
    ],
  };
  config.pages.push(p);
  config.profiles.push({
    id: "second",
    name: "Second",
    pageIds: [p.id],
    defaultPageId: p.id,
    focusApps: ["com.example.Editor"],
  });
  assert.equal((await api("/api/admin/config", "PUT", config)).status, 200);
  assert.equal(
    (
      await api(
        "/api/device/settings",
        "PUT",
        {
          name: "Tablet A",
          settings: {
            profileId: "second",
            textScale: 125,
            settingsButtonHidden: true,
          },
        },
        a,
      )
    ).status,
    200,
  );
  const own = (await api("/api/device/settings", "GET", null, a)).data.device;
  assert.equal(own.name, "Tablet A");
  assert.equal(own.settings.textScale, 125);
  assert.equal(
    (await api("/api/device/settings", "GET", null, b)).data.device.settings
      .textScale,
    undefined,
  );
  assert.equal(
    (
      await api(
        "/api/device/settings",
        "PUT",
        { id: "arbitrary", settings: {} },
        a,
      )
    ).status,
    400,
  );
  assert.equal(
    (await api("/api/snapshot", "GET", null, a)).data.config.pages.length,
    1,
  );
  assert.equal(
    (await api("/api/snapshot", "GET", null, a)).data.config.pages[0].id,
    p.id,
  );
  const first = config.pages[0].widgets.find((w) => w.type === "button").id;
  assert.equal(
    (await api("/api/action", "POST", { id: first }, a)).status,
    400,
  );
  assert.equal(
    (await api("/api/action", "POST", { id: "secondary-button" }, a)).status,
    200,
  );
  assert.equal(
    (
      await api(
        "/api/device/settings",
        "PUT",
        { settings: { startPageId: config.pages[0].id } },
        a,
      )
    ).status,
    400,
  );
  assert.equal(
    (await api("/api/admin/focus", "POST", { bundleId: "com.example.Editor" }))
      .data.changed,
    true,
  );
  assert.equal(
    (await api("/api/device/settings", "GET", null, b)).data.device.settings
      .profileId,
    "second",
  );
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "devices.json")));
  assert.equal(saved.find((d) => d.id === own.id).settings.textScale, 125);
  const h2 = createHost({ dir, metrics: false, runner: async () => "" });
  await new Promise((r) => h2.server.listen(0, "127.0.0.1", r));
  try {
    const res = await fetch(
      "http://127.0.0.1:" + h2.server.address().port + "/api/device/settings",
      { headers: { Authorization: "Bearer " + a } },
    );
    assert.equal((await res.json()).device.settings.textScale, 125);
  } finally {
    await h2.close();
  }
});
test("profile migration retains all page and widget ids and rejects cross-profile duplicates", () => {
  const c = defaultConfig(),
    old = c.pages.flatMap((p) => p.widgets.map((w) => w.id));
  delete c.profiles;
  delete c.defaultProfileId;
  const result = validateConfig(c);
  assert.deepEqual(
    result.pages.flatMap((p) => p.widgets.map((w) => w.id)),
    old,
  );
  assert.equal(result.profiles[0].pageIds[0], c.pages[0].id);
  result.profiles.push({ id: "bad", name: "Bad", pageIds: [c.pages[0].id] });
  assert.throws(() => validateConfig(result));
});
test("device settings validation rejects admin fields and invalid values", () => {
  const c = defaultConfig();
  for (const v of [
    { fontSize: 40 },
    { brightness: 101 },
    { profileId: "missing" },
    { vibrationMs: 10000 },
    { orientation: "upside" },
    { name: "not settings" },
  ])
    assert.throws(() => validateDeviceSettings({}, v, c));
  assert.equal(
    validateDeviceSettings(
      { showNavigation: true },
      { showNavigation: false, fullscreen: true },
      c,
    ).showNavigation,
    false,
  );
});
test("diagnostics enforce minimum level and strip potentially sensitive content", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opendeck-diag-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let settings = defaultSettings();
  const d = new Diagnostics(dir, () => settings);
  d.log("debug", "private", { token: "TOKEN", status: 200 });
  assert.equal(d.entries().length, 0);
  d.log("warn", "request.failed", {
    token: "TOKEN",
    message: "private",
    status: 401,
    reason: "safe_code",
  });
  assert.deepEqual(Object.keys(d.entries()[0]).sort(), [
    "at",
    "event",
    "level",
    "reason",
    "status",
  ]);
  assert(
    !fs
      .readFileSync(path.join(dir, "diagnostics.jsonl"), "utf8")
      .includes("TOKEN"),
  );
  settings.logging.minimumLevel = "error";
  d.log("warn", "skipped");
  assert.equal(d.entries().length, 1);
});
test("HTTP User-Agent setting reaches actual request and bounded release checker returns trusted assets", async () => {
  let headers;
  await httpRequest(
    { url: "https://example.test", path: "x" },
    async (_, options) => {
      headers = options.headers;
      return new Response('{"x":1}');
    },
    "MyDeck/2",
  );
  assert.equal(headers["User-Agent"], "MyDeck/2");
  const result = await releaseInfo(
    async () =>
      new Response(
        JSON.stringify({
          tag_name: "v0.9.1",
          html_url: "https://github.com/Yaklede/open-deck/releases/tag/v0.9.1",
          assets: [
            {
              name: "Open-Deck-Android.apk",
              browser_download_url:
                "https://github.com/Yaklede/open-deck/releases/download/v0.9.1/Open-Deck-Android.apk",
              size: 123,
            },
            {
              name: "Open-Deck-Android.apk",
              browser_download_url: "https://evil.test/apk",
            },
          ],
        }),
      ),
  );
  assert.equal(result.updateAvailable, true);
  assert.equal(result.version, APP_VERSION);
  assert.equal(result.assets.length, 1);
});
