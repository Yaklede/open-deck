import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  Vorssaint,
  catalog,
  validatePatch,
  vorssaintPage,
} from "../host/extensions/vorssaint/index.mjs";
import { createHost } from "../host/server.mjs";
import { defaultConfig, validateConfig } from "../host/config.mjs";
const defaults = () =>
  Object.fromEntries(
    catalog.features.flatMap((f) => f.fields.map((x) => [x.key, x.default])),
  );
function fakeNative() {
  let values = defaults(),
    running = true;
  const calls = [];
  const revision = () =>
    crypto.createHash("sha256").update(JSON.stringify(values)).digest("hex");
  return {
    calls,
    external: (key, value) => {
      values[key] = value;
    },
    async native(op, input) {
      calls.push(op);
      if (op === "read")
        return {
          ok: true,
          installed: true,
          running,
          version: "3.4.2",
          values: { ...values },
          revision: revision(),
        };
      if (op === "quit") {
        running = false;
        return { ok: true };
      }
      if (op === "write") {
        if (input.revision !== revision())
          throw Object.assign(Error("CONFLICT"), {
            code: "CONFLICT",
            status: 409,
          });
        Object.assign(values, input.patch);
        return { ok: true, revision: revision() };
      }
      if (op === "start") {
        running = true;
        return { ok: true };
      }
      if (op === "open-settings") return { ok: true };
      throw Error("unexpected operation");
    },
  };
}
function provider(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "od-vorssaint-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fake = fakeNative();
  const p = new Vorssaint({
    dir,
    getOptions: () => ({ enabled: true }),
    native: fake.native,
  });
  t.after(() => p.close());
  return { p, fake, dir };
}
test("utility catalog exposes the pinned feature interface and validated page layout", () => {
  assert.equal(catalog.upstreamVersion, "3.4.2");
  assert.equal(catalog.features.filter((x) => x.id !== "general").length, 77);
  assert.equal(catalog.groups.length, 9);
  assert.equal(
    new Set(catalog.features.flatMap((x) => x.fields.map((f) => f.key))).size,
    151,
  );
  const config = defaultConfig();
  config.pages.push(vorssaintPage());
  config.extensions = { vorssaint: { enabled: true, autoStart: true } };
  assert.doesNotThrow(() => validateConfig(config));
  const invalid = structuredClone(config);
  invalid.pages.at(-1).widgets.find((w) => w.utilityGroup).utilityGroup =
    "unknown";
  assert.throws(() => validateConfig(invalid));
});
test("utility patches are typed, range checked, choice checked and category scoped", () => {
  assert.doesNotThrow(() =>
    validatePatch("general", { appAppearance: "dark" }),
  );
  assert.doesNotThrow(() =>
    validatePatch("energyDisplay", {
      keepAwakeAutoStart: true,
      defaultDurationMinutes: 30,
    }),
  );
  for (const [group, patch] of [
    ["general", { featureAvailable: true }],
    ["general", { keepAwakeAutoStart: true }],
    ["general", { appAppearance: "arbitrary" }],
    ["energyDisplay", { defaultDurationMinutes: 31 }],
    ["energyDisplay", { keepAwakeAutoStart: "true" }],
    ["mouseKeyboard", { smoothScrollStep: 500 }],
    ["mouseKeyboard", { smoothScrollStep: 25.5 }],
    ["general", {}],
    ["bad", { appAppearance: "dark" }],
  ])
    assert.throws(() => validatePatch(group, patch));
});

test("six work essentials are read-only until an explicit save and remain category scoped", async (t) => {
  const { p, fake } = provider(t);
  for (const f of catalog.features)
    for (const field of f.fields)
      if (field.kind === "boolean") fake.external(field.key, false);
  const before = await p.settings("essentials");
  assert.deepEqual(
    before.features.map((f) => f.id),
    [
      "windowLayout",
      "clipboardHistory",
      "pastePlain",
      "quitWindowProtection",
      "keepAwake",
      "soundOutputSwitcher",
    ],
  );
  assert.deepEqual(fake.calls, ["read"]);
  assert.ok(
    before.features
      .filter((f) => f.activation)
      .every((f) => f.enabled === false),
  );
  assert.deepEqual(
    before.features.filter((f) => f.control).map((f) => f.control),
    ["awake", "audio"],
  );
  await p.update("essentials", before.revision, {
    "featureAvailable.pastePlain": true,
    pastePlainEnabled: true,
  });
  const enabled = await p.settings("essentials");
  assert.equal(
    enabled.features.find((f) => f.id === "pastePlain").enabled,
    true,
  );
  assert.equal(enabled.values.clipboardHistoryEnabled, false);
  assert.equal(enabled.values.quitProtectionQuitEnabled, false);
  await p.update("essentials", enabled.revision, {
    "featureAvailable.pastePlain": false,
    pastePlainEnabled: false,
  });
  assert.equal(
    (await p.settings("essentials")).features.find((f) => f.id === "pastePlain")
      .enabled,
    false,
  );
  assert.throws(() => validatePatch("essentials", { appAppearance: "dark" }));
  assert.throws(() =>
    validatePatch("essentials", { clipboardHistoryEnabled: "true" }),
  );
});
test("a save preserves unrelated settings, verifies revision, quits before write and restarts once", async (t) => {
  const { p, fake, dir } = provider(t);
  const before = await p.settings("general");
  const result = await p.update("general", before.revision, {
    appAppearance: "dark",
  });
  assert.equal(result.saved, true);
  assert.deepEqual(fake.calls, [
    "read",
    "read",
    "quit",
    "write",
    "start",
    "read",
  ]);
  const after = await p.settings("general");
  assert.equal(after.values.appAppearance, "dark");
  assert.equal(after.values.appLanguage, before.values.appLanguage);
  assert.equal(
    fs.readdirSync(path.join(dir, "vorssaint-settings-backups")).length,
    1,
  );
  assert.ok(
    (fs.statSync(path.join(dir, "vorssaint-settings-backups")).mode & 0o777) ===
      0o700,
  );
});
test("an identical save does not restart the app or create a backup", async (t) => {
  const { p, fake, dir } = provider(t);
  const before = await p.settings("general");
  const result = await p.update("general", before.revision, {
    appAppearance: before.values.appAppearance,
  });
  assert.equal(result.restarted, false);
  assert.ok(!fake.calls.includes("write"));
  assert.equal(
    fs.existsSync(path.join(dir, "vorssaint-settings-backups")),
    false,
  );
});
test("native preference changes reject a stale form without overwriting or restarting", async (t) => {
  const { p, fake } = provider(t);
  const before = await p.settings("general");
  fake.external("appAppearance", "light");
  await assert.rejects(
    p.update("general", before.revision, { appAppearance: "dark" }),
    (e) => e.code === "CONFLICT",
  );
  assert.ok(!fake.calls.includes("quit"));
  assert.ok(!fake.calls.includes("write"));
  assert.equal(p.busy, false);
});
test("concurrent saves are rejected and a failed write restarts the previously running app", async (t) => {
  const { p, fake } = provider(t);
  let release;
  const native = fake.native;
  p.native = async (op, input) => {
    if (op === "quit") await new Promise((r) => (release = r));
    if (op === "write")
      throw Object.assign(Error("WRITE_FAILED"), { code: "WRITE_FAILED" });
    return native(op, input);
  };
  const before = await p.settings("general");
  const first = p.update("general", before.revision, { appAppearance: "dark" });
  while (!release) await new Promise((r) => setImmediate(r));
  await assert.rejects(
    p.update("general", before.revision, { appAppearance: "light" }),
    (e) => e.code === "BUSY",
  );
  release();
  await assert.rejects(first, (e) => e.code === "WRITE_FAILED");
  assert.ok(fake.calls.includes("start"));
  assert.equal(p.busy, false);
});
test("snapshots publish summary only, never full preferences or clipboard data", async (t) => {
  const { p, fake } = provider(t);
  fake.external("privateClipboard", "PRIVATE_CONTENT");
  await p.read();
  const text = JSON.stringify(p.state());
  assert.ok(!text.includes("PRIVATE_CONTENT"));
  assert.ok(!text.includes("appAppearance"));
  const g = await p.settings("general");
  assert.ok(!Object.hasOwn(g.values, "privateClipboard"));
  assert.ok(g.copy.ko.description);
  assert.ok(g.features.every((f) => f.group === "general"));
});
async function hostFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "od-vorssaint-api-"));
  const fake = fakeNative();
  const host = createHost({
    dir,
    metrics: false,
    runner: async () => "",
    vorssaintOptions: { native: fake.native },
  });
  await new Promise((r) => host.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await host.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = "http://127.0.0.1:" + host.server.address().port;
  const api = async (route, method = "GET", body, token, anonymous = false) => {
    const r = await fetch(base + route, {
      method,
      headers: {
        ...(anonymous
          ? {}
          : token
            ? { Authorization: "Bearer " + token }
            : { "X-Open-Deck-Admin": host.adminKey }),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, data: await r.json() };
  };
  return { host, api, fake };
}
test("paired devices configure only a visible utility group, and profile scope cannot be bypassed", async (t) => {
  const { api, host } = await hostFixture(t);
  const added = await api("/api/admin/extensions", "POST", {
    id: "vorssaint",
    enabled: true,
    addPage: true,
  });
  assert.equal(added.status, 200);
  const config = added.data.config;
  assert.ok(
    config.profiles
      .find((x) => x.id === config.defaultProfileId)
      .pageIds.includes("vorssaint-page"),
  );
  const token = (
    await api("/api/pair", "POST", { pin: host.getPin(), name: "test" })
  ).data.token;
  const id = "vorssaint-group-general",
    url = "/api/extensions/vorssaint/settings?widgetId=" + id;
  assert.equal((await api(url, "GET", undefined, undefined, true)).status, 401);
  const before = await api(url, "GET", undefined, token);
  assert.equal(before.status, 200);
  const essentials = await api(
    url + "&group=essentials",
    "GET",
    undefined,
    token,
  );
  assert.equal(essentials.status, 200);
  assert.equal(essentials.data.features.length, 6);
  assert.equal(
    (
      await api(
        "/api/extensions/vorssaint/settings",
        "POST",
        {
          widgetId: id,
          revision: before.data.revision,
          patch: { appAppearance: "dark" },
        },
        token,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await api(
        "/api/extensions/vorssaint/settings",
        "POST",
        {
          widgetId: id,
          revision: before.data.revision,
          patch: { keepAwakeAutoStart: true },
        },
        token,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await api(
        "/api/extensions/vorssaint/settings?widgetId=missing",
        "GET",
        undefined,
        token,
      )
    ).status,
    403,
  );
  config.pages.push({
    ...structuredClone(config.pages[0]),
    id: "limited-page",
    widgets: [],
  });
  config.profiles.push({
    id: "limited",
    name: "Limited",
    pageIds: ["limited-page"],
    defaultPageId: "limited-page",
  });
  assert.equal((await api("/api/admin/config", "PUT", config)).status, 200);
  await api(
    "/api/device/settings",
    "PUT",
    { settings: { profileId: "limited" } },
    token,
  );
  assert.equal((await api(url, "GET", undefined, token)).status, 403);
  assert.equal(
    (await api(url + "&group=essentials", "GET", undefined, token)).status,
    403,
  );
  assert.equal(
    (await api("/api/admin/extensions", "POST", { id: "vorssaint" }, token))
      .status,
    403,
  );
});

test("the utility settings surface works over trusted HTTPS while LAN admin access stays blocked", async (t) => {
  const https = await import("node:https");
  const { once } = await import("node:events");
  const { defaultSettings } = await import("../host/settings.mjs");
  const { writeJson } = await import("../host/config.mjs");
  const { loadIdentity } = await import("../host/network.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "od-vorssaint-tls-"));
  const settings = defaultSettings();
  settings.network.discoveryEnabled = false;
  writeJson(path.join(dir, "preferences.json"), settings);
  const fake = fakeNative();
  const host = createHost({
    dir,
    wifi: true,
    wifiPort: 0,
    metrics: false,
    runner: async () => "",
    vorssaintOptions: { native: fake.native },
  });
  await new Promise((r) => host.server.listen(0, "127.0.0.1", r));
  if (!host.lanServer.listening) await once(host.lanServer, "listening");
  t.after(async () => {
    await host.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const local = "http://127.0.0.1:" + host.server.address().port;
  const api = async (route, body) => {
    const r = await fetch(local + route, {
      method: "POST",
      headers: {
        "X-Open-Deck-Admin": host.adminKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    assert.equal(r.status, 200);
    return r.json();
  };
  await api("/api/admin/extensions", {
    id: "vorssaint",
    enabled: true,
    addPage: true,
  });
  const token = (
    await api("/api/pair", { pin: host.getPin(), name: "TLS fixture" })
  ).token;
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
  const route = "/api/extensions/vorssaint/settings",
    query = route + "?widgetId=vorssaint-group-general";
  assert.equal((await tls("GET", query)).status, 401);
  assert.equal(
    (await tls("GET", query, null, { "X-Open-Deck-Admin": host.adminKey }))
      .status,
    401,
  );
  const headers = { Authorization: "Bearer " + token };
  const before = await tls("GET", query, null, headers);
  assert.equal(before.status, 200);
  assert.equal(
    (
      await tls(
        "POST",
        route,
        {
          widgetId: "vorssaint-group-general",
          revision: before.data.revision,
          patch: { appAppearance: "dark" },
        },
        headers,
      )
    ).status,
    200,
  );
  assert.equal(
    (await tls("GET", "/api/admin/extensions", null, headers)).status,
    403,
  );
  assert.equal(
    (
      await tls("GET", query, null, {
        ...headers,
        Origin: "https://untrusted.invalid",
      })
    ).status,
    403,
  );
});

test("revocation while a paired settings body is arriving cannot become admin scope", async (t) => {
  const http = await import("node:http");
  const { api, host, fake } = await hostFixture(t);
  await api("/api/admin/extensions", "POST", {
    id: "vorssaint",
    enabled: true,
    addPage: true,
  });
  const pair = (
    await api("/api/pair", "POST", {
      pin: host.getPin(),
      name: "revocation fixture",
    })
  ).data;
  const device = (
    await api("/api/device/settings", "GET", undefined, pair.token)
  ).data.device;
  const settings = (
    await api(
      "/api/extensions/vorssaint/settings?widgetId=vorssaint-group-general",
      "GET",
      undefined,
      pair.token,
    )
  ).data;
  const payload = JSON.stringify({
    widgetId: "vorssaint-group-general",
    revision: settings.revision,
    patch: { appAppearance: "dark" },
  });
  let received;
  const receiving = new Promise((r) => (received = r));
  const listener = (req) => {
    if (
      req.url === "/api/extensions/vorssaint/settings" &&
      req.method === "POST"
    ) {
      host.server.off("request", listener);
      received();
    }
  };
  host.server.prependListener("request", listener);
  let request;
  const response = new Promise((resolve, reject) => {
    request = http.request(
      {
        hostname: "127.0.0.1",
        port: host.server.address().port,
        path: "/api/extensions/vorssaint/settings",
        method: "POST",
        headers: {
          Authorization: "Bearer " + pair.token,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    request.on("error", reject);
    request.setTimeout(2000, () => request.destroy(Error("fixture timeout")));
    request.write(payload.slice(0, 1));
  });
  await receiving;
  assert.equal(
    (await api("/api/admin/revoke", "POST", { id: device.id })).status,
    200,
  );
  request.end(payload.slice(1));
  assert.equal(await response, 401);
  assert.ok(!fake.calls.includes("write"));
});

test("locking the editor while a utility save body is arriving cancels the write", async (t) => {
  const http = await import("node:http");
  const { api, host, fake } = await hostFixture(t);
  await api("/api/admin/extensions", "POST", {
    id: "vorssaint",
    enabled: true,
    addPage: true,
  });
  const settings = (
    await api(
      "/api/extensions/vorssaint/settings?widgetId=vorssaint-group-general",
    )
  ).data;
  assert.equal(
    (
      await api("/api/admin/lock", "POST", {
        operation: "configure",
        password: "fixture-utility-lock-password",
      })
    ).status,
    200,
  );
  const payload = JSON.stringify({
    widgetId: "vorssaint-group-general",
    revision: settings.revision,
    patch: { appAppearance: "dark" },
  });
  let received;
  const receiving = new Promise((r) => (received = r));
  const listener = (req) => {
    if (
      req.url === "/api/extensions/vorssaint/settings" &&
      req.method === "POST"
    ) {
      host.server.off("request", listener);
      received();
    }
  };
  host.server.prependListener("request", listener);
  let request;
  const response = new Promise((resolve, reject) => {
    request = http.request(
      {
        hostname: "127.0.0.1",
        port: host.server.address().port,
        path: "/api/extensions/vorssaint/settings",
        method: "POST",
        headers: {
          "X-Open-Deck-Admin": host.adminKey,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    request.on("error", reject);
    request.setTimeout(2000, () => request.destroy(Error("fixture timeout")));
    request.write(payload.slice(0, 1));
  });
  await receiving;
  assert.equal(
    (await api("/api/admin/lock", "POST", { operation: "lock" })).status,
    200,
  );
  request.end(payload.slice(1));
  assert.equal(await response, 423);
  assert.ok(!fake.calls.includes("write"));
});
