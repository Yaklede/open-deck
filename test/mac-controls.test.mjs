import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  MacControls,
  validateControl,
} from "../host/extensions/vorssaint/runtime.mjs";
import {
  vorssaintPage,
  upgradeVorssaintPage,
} from "../host/extensions/vorssaint/index.mjs";
import { createHost } from "../host/server.mjs";
const curve = [
  {
    sensor: "hottestSoC",
    points: [
      { temperature: 50, coolingLevel: 0 },
      { temperature: 70, coolingLevel: 100 },
    ],
  },
];
test("direct controls accept only typed, bounded operations for the visible control", () => {
  for (const [kind, op, p] of [
    ["fan", "fan.system", {}],
    ["fan", "fan.authorize", {}],
    ["fan", "fan.manual", { level: 100 }],
    ["fan", "fan.curve", { curves: curve }],
    ["audio", "audio.volume", { deviceId: 1, direction: "output", value: 0 }],
    ["audio", "audio.mute", { deviceId: 1, direction: "input", value: true }],
    ["audio", "audio.device", { deviceId: 1, direction: "input" }],
    ["display", "display.brightness", { displayId: 1, value: 1 }],
    ["awake", "awake.start", { minutes: 30, display: false }],
    ["awake", "awake.stop", {}],
  ])
    assert.doesNotThrow(() => validateControl(kind, op, p));
  for (const [kind, op, p] of [
    ["audio", "fan.manual", { level: 100 }],
    ["fan", "shell", { command: "arbitrary" }],
    ["fan", "fan.system", { path: "/tmp" }],
    ["fan", "fan.manual", { level: 101 }],
    ["fan", "fan.manual", { level: 43 }],
    ["fan", "fan.manual", { level: "50" }],
    ["audio", "audio.volume", { deviceId: -1, direction: "output", value: 50 }],
    [
      "audio",
      "audio.volume",
      { deviceId: 1, direction: "output", value: 100.5 },
    ],
    ["audio", "audio.mute", { deviceId: 1, direction: "input", value: 1 }],
    ["display", "display.brightness", { displayId: 1, value: 0 }],
    ["awake", "awake.start", { minutes: 31, display: false }],
    ["awake", "awake.start", { minutes: 30, display: 1 }],
  ])
    assert.throws(() => validateControl(kind, op, p));
});
test("curves reject duplicate sensors, reversed temperatures, descending levels and invalid points", () => {
  const rejects = [
    [],
    [...curve, ...curve],
    [{ sensor: "arbitrary", points: curve[0].points }],
    [
      {
        sensor: "hottestSoC",
        points: [
          { temperature: 80, coolingLevel: 20 },
          { temperature: 70, coolingLevel: 100 },
        ],
      },
    ],
    [
      {
        sensor: "hottestSoC",
        points: [
          { temperature: 50, coolingLevel: 100 },
          { temperature: 70, coolingLevel: 20 },
        ],
      },
    ],
    [
      {
        sensor: "hottestSoC",
        points: [
          { temperature: 19, coolingLevel: 0 },
          { temperature: 70, coolingLevel: 100 },
        ],
      },
    ],
    [
      {
        sensor: "hottestSoC",
        points: [
          { temperature: 50, coolingLevel: 21 },
          { temperature: 70, coolingLevel: 100 },
        ],
      },
    ],
  ];
  for (const curves of rejects)
    assert.throws(() => validateControl("fan", "fan.curve", { curves }));
});
test("the Mac tools page prioritizes actual fan readings and preserves unrelated pages during upgrade", () => {
  const next = vorssaintPage();
  assert.equal(next.widgets.filter((w) => w.utilityControl).length, 5);
  assert.equal(next.widgets.find((w) => w.utilityControl === "fan").w, 12);
  const unrelated = {
    id: "workspace",
    widgets: [{ id: "mine", label: "Keep me" }],
  };
  const old = {
    id: "vorssaint-page",
    widgets: Array.from({ length: 13 }, (_, i) => ({ id: "vorssaint-" + i })),
  };
  const config = { pages: [structuredClone(unrelated), old] };
  upgradeVorssaintPage(config);
  assert.deepEqual(config.pages[0], unrelated);
  assert.ok(config.pages[1].widgets.some((w) => w.utilityControl === "fan"));
  const custom = { id: "vorssaint-page", widgets: [{ id: "custom" }] };
  assert.equal(upgradeVorssaintPage({ pages: [custom] }).pages[0], custom);
});
function nativeFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "od-mac-control-"));
  const binary = path.join(dir, "native");
  fs.writeFileSync(binary, "fixture");
  let now = 100000,
    child;
  const requests = [];
  const controls = new MacControls({
    dir,
    binary,
    clock: () => now,
    spawnChild: () => {
      child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {
        child.emit("exit", 0);
        return true;
      };
      child.stdin.on("data", (b) => {
        const input = JSON.parse(String(b));
        requests.push(input);
        if (input.op !== "hang")
          child.stdout.write(
            JSON.stringify({
              id: input.id,
              ok: true,
              state: {
                at: now,
                fan: {
                  mode: input.op === "fan.manual" ? "manual" : "system",
                  fans: [],
                },
                audio: { devices: [] },
              },
            }) + "\n",
          );
      });
      return child;
    },
  });
  t.after(() => {
    controls.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    controls,
    dir,
    requests,
    child: () => child,
    clock: (n) => {
      now = n;
    },
  };
}
test("successful presets persist without replaying manual fan control on restart", async (t) => {
  const f = nativeFixture(t);
  await f.controls.control("fan", "fan.manual", { level: 65 });
  await f.controls.control("fan", "fan.curve", { curves: curve });
  assert.equal(f.controls.state().fan.presetLevel, 65);
  assert.deepEqual(f.controls.state().fan.presetCurves, curve);
  const other = new MacControls({ dir: f.dir, binary: "missing" });
  assert.equal(other.state().fan.presetLevel, 65);
  assert.deepEqual(other.state().fan.presetCurves, curve);
  assert.equal(other.child, null);
  other.close();
  assert.deepEqual(
    f.requests.map((r) => r.op),
    ["fan.manual", "fan.curve"],
  );
  assert.equal(
    fs.statSync(path.join(f.dir, "mac-control-presets.json")).mode & 0o777,
    0o600,
  );
});
test("native disconnection marks retained readings stale and bounded reconnect recovers", async (t) => {
  const f = nativeFixture(t);
  await f.controls.read();
  const at = f.controls.state().at;
  f.child().emit("exit", 1);
  assert.equal(f.controls.state().available, false);
  assert.equal(f.controls.state().stale, true);
  assert.equal(f.controls.state().at, at);
  const retained = await f.controls.read();
  assert.equal(retained.available, false);
  assert.equal(retained.stale, true);
  assert.equal(retained.at, at);
  assert.equal(retained.error, "MAC_CONTROLS_DISCONNECTED");
  await assert.rejects(
    f.controls.control("fan", "fan.manual", { level: 50 }),
    (e) => e.code === "MAC_CONTROLS_DISCONNECTED",
  );
  const cold = new MacControls({ dir: f.dir, binary: "missing" });
  await assert.rejects(
    cold.read(),
    (e) => e.code === "MAC_CONTROLS_NOT_INSTALLED",
  );
  cold.close();
  f.clock(120000);
  f.controls.ensure();
  assert.equal(f.controls.state().available, false);
  assert.equal(f.controls.state().stale, true);
  await f.controls.read();
  assert.equal(f.controls.state().available, true);
  assert.equal(f.controls.state().stale, false);
});

test("read requests coalesce and simultaneous mutations fail instead of accumulating stale actions", async (t) => {
  const f = nativeFixture(t);
  const a = f.controls.read(),
    b = f.controls.read();
  assert.equal(a, b);
  await a;
  assert.equal(f.requests.filter((r) => r.op === "read").length, 1);
  const changing = f.controls.control("fan", "fan.manual", { level: 100 });
  const concurrent = f.controls.control("fan", "fan.manual", { level: 50 });
  const during = f.controls.read();
  await assert.rejects(concurrent, (e) => e.code === "BUSY");
  assert.equal((await during).applying, true);
  const result = await changing;
  assert.equal(result.applying, false);
  assert.equal(f.requests.filter((r) => r.op === "fan.manual").length, 1);
  assert.equal(f.requests.at(-1).deadline, 105000);
});

test("a preset disk failure reports live control separately and a later save recovers", async (t) => {
  const f = nativeFixture(t);
  fs.mkdirSync(path.join(f.dir, "mac-control-presets.json.tmp"));
  const applied = await f.controls.control("fan", "fan.manual", { level: 80 });
  assert.equal(applied.fan.mode, "manual");
  assert.equal(applied.fan.presetSaveError, true);
  fs.rmdirSync(path.join(f.dir, "mac-control-presets.json.tmp"));
  const saved = await f.controls.control("fan", "fan.manual", { level: 75 });
  assert.equal(saved.fan.presetSaveError, false);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(f.dir, "mac-control-presets.json")))
      .level,
    75,
  );
});
test("pending native work is bounded and all in-flight requests fail when its process exits", async (t) => {
  const f = nativeFixture(t),
    pending = Array.from({ length: 8 }, () =>
      f.controls.request("hang").catch((e) => e.code),
    );
  await assert.rejects(f.controls.request("hang"), (e) => e.code === "BUSY");
  f.child().emit("exit", 1);
  assert.deepEqual(
    await Promise.all(pending),
    Array(8).fill("MAC_CONTROLS_DISCONNECTED"),
  );
});
async function hostFixture(t, { wifi = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "od-control-api-"));
  const calls = [];
  if (wifi) {
    const { defaultSettings } = await import("../host/settings.mjs");
    const settings = defaultSettings();
    settings.network.discoveryEnabled = false;
    fs.writeFileSync(
      path.join(dir, "preferences.json"),
      JSON.stringify(settings),
    );
  }
  const controls = {
    ensure() {},
    stop() {},
    close() {},
    state: () => ({
      available: true,
      at: Date.now(),
      fan: { mode: "system", fans: [] },
    }),
    async read() {
      return this.state();
    },
    async control(kind, op, p) {
      validateControl(kind, op, p);
      calls.push({ kind, op, p });
      return this.state();
    },
  };
  const host = createHost({
    dir,
    metrics: false,
    wifi,
    wifiPort: 0,
    runner: async () => "",
    vorssaintOptions: {
      controls,
      native: async () => ({
        ok: true,
        installed: false,
        running: false,
        version: "",
        revision: "test",
        values: {},
      }),
    },
  });
  await new Promise((r) => host.server.listen(0, "127.0.0.1", r));
  if (wifi && !host.lanServer.listening)
    await (await import("node:events")).once(host.lanServer, "listening");
  t.after(async () => {
    await host.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = "http://127.0.0.1:" + host.server.address().port;
  const api = async (route, method = "GET", body, token) => {
    const response = await fetch(base + route, {
      method,
      headers: {
        ...(token
          ? { Authorization: "Bearer " + token }
          : { "X-Open-Deck-Admin": host.adminKey }),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, data: await response.json() };
  };
  await api("/api/admin/extensions", "POST", {
    id: "vorssaint",
    enabled: true,
    addPage: true,
  });
  const pair = await api("/api/pair", "POST", {
    pin: host.getPin(),
    name: "control fixture",
  });
  return { api, host, calls, dir, token: pair.data.token };
}
test("paired controls enforce widget category and effective profile scope", async (t) => {
  const { api, token, calls } = await hostFixture(t);
  const route = "/api/extensions/vorssaint/control";
  assert.equal(
    (await api(route + "?widgetId=vorssaint-fan", "GET", undefined, token))
      .status,
    200,
  );
  assert.equal(
    (
      await api(
        route,
        "POST",
        {
          widgetId: "vorssaint-fan",
          operation: "fan.manual",
          parameters: { level: 100 },
        },
        token,
      )
    ).status,
    200,
  );
  assert.equal(calls.length, 1);
  assert.equal(
    (
      await api(
        route,
        "POST",
        {
          widgetId: "vorssaint-audio",
          operation: "fan.manual",
          parameters: { level: 100 },
        },
        token,
      )
    ).status,
    400,
  );
  assert.equal(calls.length, 1);
  assert.equal(
    (
      await api(
        route,
        "POST",
        {
          widgetId: "vorssaint-fan",
          operation: "fan.manual",
          parameters: { level: 100 },
          command: "arbitrary",
        },
        token,
      )
    ).status,
    400,
  );
  const config = (await api("/api/snapshot")).data.config;
  config.pages.push({
    id: "limited",
    name: "Limited",
    columns: 4,
    rows: 4,
    widgets: [],
  });
  config.profiles.push({
    id: "limited",
    name: "Limited",
    pageIds: ["limited"],
    defaultPageId: "limited",
  });
  assert.equal((await api("/api/admin/config", "PUT", config)).status, 200);
  assert.equal(
    (
      await api(
        "/api/device/settings",
        "PUT",
        { settings: { profileId: "limited" } },
        token,
      )
    ).status,
    200,
  );
  assert.equal(
    (await api(route + "?widgetId=vorssaint-fan", "GET", undefined, token))
      .status,
    403,
  );
  assert.equal(
    (
      await api(
        route,
        "POST",
        { widgetId: "vorssaint-fan", operation: "fan.system", parameters: {} },
        token,
      )
    ).status,
    403,
  );
  assert.equal(calls.length, 1);
});
test("advanced categories stay available through their scoped preferences widget", async (t) => {
  const { api, token } = await hostFixture(t);
  const route =
    "/api/extensions/vorssaint/settings?widgetId=vorssaint-group-general&group=";
  const result = await api(route + "all", "GET", undefined, token);
  assert.equal(result.status, 200);
  assert.equal(result.data.groups.length, 9);
  const group = await api(route + "energyDisplay", "GET", undefined, token);
  assert.equal(group.status, 200);
  assert.equal(group.data.group.id, "energyDisplay");
});

test("native control works on trusted HTTPS while unpaired, browser and LAN admin requests stay blocked", async (t) => {
  const { host, dir, token, calls } = await hostFixture(t, { wifi: true });
  const https = await import("node:https");
  const { loadIdentity } = await import("../host/network.mjs");
  const tls = (method, route, body, headers = {}) =>
    new Promise((resolve, reject) => {
      const request = https.request(
        {
          hostname: "127.0.0.1",
          port: host.lanServer.address().port,
          path: route,
          method,
          ca: loadIdentity(dir).cert,
          servername: "opendeck.local",
          agent: false,
          headers: {
            ...headers,
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
        },
        (response) => {
          let raw = "";
          response.on("data", (b) => (raw += b));
          response.on("end", () =>
            resolve({ status: response.statusCode, data: JSON.parse(raw) }),
          );
        },
      );
      request.on("error", reject);
      request.setTimeout(3000, () => request.destroy(Error("fixture timeout")));
      request.end(body ? JSON.stringify(body) : undefined);
    });
  const route = "/api/extensions/vorssaint/control",
    query = route + "?widgetId=vorssaint-fan",
    headers = { Authorization: "Bearer " + token };
  assert.equal((await tls("GET", query)).status, 401);
  assert.equal(
    (await tls("GET", query, null, { "X-Open-Deck-Admin": host.adminKey }))
      .status,
    401,
  );
  assert.equal((await tls("GET", query, null, headers)).status, 200);
  assert.equal(
    (
      await tls(
        "POST",
        route,
        {
          widgetId: "vorssaint-fan",
          operation: "fan.manual",
          parameters: { level: 100 },
        },
        headers,
      )
    ).status,
    200,
  );
  assert.equal(calls.length, 1);
  assert.equal(
    (
      await tls("GET", query, null, {
        ...headers,
        Origin: "https://untrusted.invalid",
      })
    ).status,
    403,
  );
  assert.equal(
    (await tls("GET", "/api/admin/extensions", null, headers)).status,
    403,
  );
});

test("device revocation during a streamed control request cancels hardware dispatch", async (t) => {
  const { api, host, token, calls } = await hostFixture(t);
  const http = await import("node:http");
  const device = (await api("/api/device/settings", "GET", undefined, token))
    .data.device;
  const payload = JSON.stringify({
    widgetId: "vorssaint-fan",
    operation: "fan.manual",
    parameters: { level: 100 },
  });
  let received;
  const receiving = new Promise((r) => (received = r));
  const listener = (req) => {
    if (
      req.url === "/api/extensions/vorssaint/control" &&
      req.method === "POST"
    ) {
      host.server.off("request", listener);
      received();
    }
  };
  host.server.prependListener("request", listener);
  let request;
  const result = new Promise((resolve, reject) => {
    request = http.request(
      {
        hostname: "127.0.0.1",
        port: host.server.address().port,
        path: "/api/extensions/vorssaint/control",
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      },
    );
    request.on("error", reject);
    request.setTimeout(3000, () => request.destroy(Error("fixture timeout")));
    request.write(payload.slice(0, 1));
  });
  await receiving;
  assert.equal(
    (await api("/api/admin/revoke", "POST", { id: device.id })).status,
    200,
  );
  request.end(payload.slice(1));
  assert.equal(await result, 401);
  assert.equal(calls.length, 0);
});
