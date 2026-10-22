import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import https from "node:https";
import { once } from "node:events";
import { createHost } from "../host/server.mjs";
import { defaultSettings } from "../host/settings.mjs";
import { writeJson } from "../host/config.mjs";
import { loadIdentity } from "../host/network.mjs";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function fixture(t, wifi = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "od-settings-integration-"));
  const settings = defaultSettings();
  settings.network.wifiPort = await freePort();
  settings.network.discoveryEnabled = false;
  writeJson(path.join(dir, "preferences.json"), settings);
  const host = createHost({ dir, wifi, metrics: false, runner: async () => "" });
  await new Promise((resolve) => host.server.listen(0, "127.0.0.1", resolve));
  if (wifi && !host.lanServer.listening) await once(host.lanServer, "listening");
  t.after(async () => { await host.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${host.server.address().port}`;
  const api = async (route, method = "GET", body, token) => {
    const response = await fetch(base + route, { method, headers: { ...(token ? { Authorization: "Bearer " + token } : { "X-Open-Deck-Admin": host.adminKey }), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  const pair = async () => (await api("/api/pair", "POST", { pin: host.getPin() })).body.token;
  return { dir, settings, host, base, api, pair };
}

function tlsHealth(port, certificate) {
  return new Promise((resolve, reject) => {
    // Trust only this test's exact generated certificate and verify its hostname.
    const req = https.get({ hostname: "127.0.0.1", port, path: "/health", ca: certificate, servername: "opendeck.local", agent: false }, (res) => {
      const fingerprint = res.socket.getPeerCertificate().fingerprint256.replaceAll(":", "").toLowerCase();
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode, fingerprint }));
    });
    req.on("error", reject);
    req.setTimeout(1500, () => req.destroy(Error("fixture timeout")));
  });
}

test("changing HTTPS to an occupied port fails without replacing the working listener or saved setting", async (t) => {
  const { host, api, settings, dir } = await fixture(t, true);
  const identity = loadIdentity(dir);
  const occupied = net.createServer();
  await new Promise((resolve) => occupied.listen(0, "0.0.0.0", resolve));
  t.after(() => new Promise((resolve) => occupied.close(resolve)));
  const port = occupied.address().port;
  const failed = await api("/api/admin/settings", "PUT", { network: { wifiPort: port } });
  assert.equal(failed.status, 400);
  assert.equal(host.lanServer.address().port, settings.network.wifiPort);
  assert.equal((await api("/api/admin/settings")).body.settings.network.wifiPort, settings.network.wifiPort);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "preferences.json"))).network.wifiPort, settings.network.wifiPort);
  assert.equal((await tlsHealth(settings.network.wifiPort, identity.cert)).status, 200);
  const newPort = await freePort();
  assert.equal((await api("/api/admin/settings", "PUT", { network: { wifiPort: newPort } })).status, 200);
  assert.equal(host.lanServer.address().port, newPort);
  assert.equal((await tlsHealth(newPort, identity.cert)).status, 200);
});

test("a certificate/key mismatch is rejected without changing the saved identity or live TLS listener", async (t) => {
  const { host, api, dir } = await fixture(t, true);
  const original = loadIdentity(dir);
  const alternate = loadIdentity(path.join(dir, "alternate-identity"));
  const before = (await api("/api/admin/certificate")).body;
  const result = await api("/api/admin/certificate", "POST", { certificatePem: original.cert.toString(), privateKeyPem: alternate.key.toString() });
  assert.equal(result.status, 400);
  const after = loadIdentity(dir);
  assert.deepEqual(after.cert, original.cert);
  assert.deepEqual(after.key, original.key);
  assert.deepEqual((await api("/api/admin/certificate")).body, before);
  assert.deepEqual(await tlsHealth(host.lanServer.address().port, original.cert), { status: 200, fingerprint: original.fingerprint });
  assert.equal(fs.existsSync(path.join(dir, "wifi-key.pem.next")), false);
  assert.equal(fs.existsSync(path.join(dir, "wifi-cert.pem.next")), false);
});

test("a valid custom certificate is persisted privately and used by new TLS connections", async (t) => {
  const { host, api, dir, pair } = await fixture(t, true);
  const alternate = loadIdentity(path.join(dir, "alternate-identity"));
  const result = await api("/api/admin/certificate", "POST", { certificatePem: alternate.cert.toString(), privateKeyPem: alternate.key.toString() });
  assert.equal(result.status, 200);
  assert.equal(result.body.source, "custom");
  assert.equal(result.body.fingerprint, alternate.fingerprint);
  assert.deepEqual(loadIdentity(dir).cert, alternate.cert);
  assert.deepEqual(loadIdentity(dir).key, alternate.key);
  for (const file of ["wifi-key.pem", "wifi-cert.pem", "wifi-custom-certificate"]) assert.equal(fs.statSync(path.join(dir, file)).mode & 0o777, 0o600);
  assert.deepEqual(await tlsHealth(host.lanServer.address().port, alternate.cert), { status: 200, fingerprint: alternate.fingerprint });
  const token = await pair();
  assert.equal((await api("/api/admin/certificate", "POST", { certificatePem: alternate.cert.toString(), privateKeyPem: alternate.key.toString() }, token)).status, 403);
});

test("diagnostic export excludes pairing tokens, editor keys, private certificates and password material", async (t) => {
  const { api, dir, pair, host } = await fixture(t);
  const token = await pair();
  const identity = loadIdentity(dir);
  const password = "fixture-editor-password-23819";
  assert.equal((await api("/api/admin/lock", "POST", { operation: "configure", password, idleMinutes: 0 })).status, 200);
  assert.equal((await api("/api/admin/lock", "POST", { operation: "unlock", password })).status, 200);
  await api("/api/admin/settings", "PUT", { appearance: { themeMode: "light" } });
  const result = await api("/api/admin/diagnostics");
  assert.equal(result.status, 200);
  assert.ok(result.body.logs.some((log) => log.event === "device.paired"));
  const json = JSON.stringify(result.body);
  for (const secret of [token, host.adminKey, password, identity.key.toString().trim(), "BEGIN PRIVATE KEY", "BEGIN RSA PRIVATE KEY"]) assert.equal(json.includes(secret), false);
  assert.equal(Object.hasOwn(result.body, "devices"), false);
  assert.equal((await api("/api/admin/diagnostics", "GET", null, token)).status, 403);
});

test("locking the editor blocks its reads and writes while the paired tablet continues working", async (t) => {
  const { api, pair } = await fixture(t);
  const token = await pair();
  const before = (await api("/api/admin/info")).body.config;
  const password = "fixture-lock-password-40728";
  assert.equal((await api("/api/admin/lock", "POST", { operation: "configure", password, idleMinutes: 1 })).status, 200);
  assert.equal((await api("/api/admin/lock", "POST", { operation: "lock" })).status, 200);
  assert.equal((await api("/api/admin/lock-status")).body.locked, true);
  assert.equal((await api("/api/admin/info")).status, 423);
  assert.equal((await api("/api/admin/config", "PUT", { ...before, name: "Must not persist" })).status, 423);
  assert.equal((await api("/api/admin/diagnostics")).status, 423);
  assert.equal((await api("/api/snapshot", "GET", null, token)).status, 200);
  assert.equal((await api("/api/device/settings", "PUT", { settings: { textScale: 110 } }, token)).status, 200);
  assert.equal((await api("/api/admin/lock", "POST", { operation: "unlock", password: "wrong-password" })).status, 403);
  assert.equal((await api("/api/admin/lock", "POST", { operation: "unlock", password })).status, 200);
  assert.deepEqual((await api("/api/admin/info")).body.config, before);
  assert.equal((await api("/api/admin/lock", "POST", { operation: "disable", password })).status, 200);
  assert.equal((await api("/api/admin/lock-status")).body.configured, false);
});

test("global pinned buttons remain actionable from another profile, and removed profiles do not poison later device settings", async (t) => {
  const { api, pair } = await fixture(t);
  const token = await pair();
  const config = (await api("/api/admin/info")).body.config;
  const pinned = config.pages[0].widgets.find((w) => w.type === "button");
  pinned.pinScope = "global";
  const page = { id: "other-page", name: "Other", columns: 4, rows: 2, gap: 12, radius: 13, theme: "midnight", widgets: [] };
  config.pages.push(page);
  config.profiles.push({ id: "other", name: "Other", pageIds: [page.id], defaultPageId: page.id, focusApps: [] });
  assert.equal((await api("/api/admin/config", "PUT", config)).status, 200);
  assert.equal((await api("/api/device/settings", "PUT", { settings: { profileId: "other", startPageId: page.id } }, token)).status, 200);
  const snapshot = (await api("/api/snapshot", "GET", null, token)).body;
  assert.ok(snapshot.config.pages[0].widgets.some((w) => w.id === pinned.id && w.inheritedPin));
  assert.equal((await api("/api/action", "POST", { id: pinned.id }, token)).status, 200);
  config.profiles = config.profiles.filter((p) => p.id !== "other");
  config.pages = config.pages.filter((p) => p.id !== page.id);
  assert.equal((await api("/api/admin/config", "PUT", config)).status, 200);
  const settings = (await api("/api/device/settings", "GET", null, token)).body.device.settings;
  assert.equal(settings.profileId, "");
  assert.equal(settings.startPageId, "");
  assert.equal((await api("/api/device/settings", "PUT", { settings: { textScale: 120 } }, token)).status, 200);
});

test("settings updates reach the paired SSE stream and revocation ends its access", async (t) => {
  const { api, pair, base } = await fixture(t);
  const token = await pair(), abort = new AbortController();
  t.after(() => abort.abort());
  const res = await fetch(base + "/api/events", { headers: { Authorization: "Bearer " + token }, signal: abort.signal });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  let buffer = "";
  const nextSnapshot = async () => {
    for (;;) {
      const split = buffer.indexOf("\n\n");
      if (split >= 0) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const data = frame.split("\n").find((line) => line.startsWith("data: "));
        if (data) return JSON.parse(data.slice(6));
      } else {
        const next = await reader.read();
        if (next.done) throw Error("stream ended before snapshot");
        buffer += Buffer.from(next.value).toString("utf8");
      }
    }
  };
  const first = await nextSnapshot();
  const id = first.device.id;
  await api("/api/admin/devices", "PUT", { id, settings: { showNavigation: false, textScale: 125 } });
  const changed = await nextSnapshot();
  assert.equal(changed.device.settings.textScale, 125);
  assert.equal(changed.device.settings.showNavigation, false);
  assert.ok(changed.device.settingsRevision > first.device.settingsRevision);
  assert.ok(changed.config);
  await api("/api/admin/revoke", "POST", { id });
  assert.equal((await api("/api/device/settings", "GET", null, token)).status, 401);
  await reader.cancel();
});

test("API backup export/import retains app preferences and invalid restore cannot change the live deck", async (t) => {
  const { api, pair } = await fixture(t);
  await api("/api/admin/settings", "PUT", { appearance: { themeMode: "light" } });
  const backup = (await api("/api/admin/backups", "POST", { operation: "create" })).body.backup;
  assert.ok(backup.hasPreferences);
  await api("/api/admin/settings", "PUT", { appearance: { themeMode: "dark" } });
  const restored = await api("/api/admin/backups", "POST", { operation: "restore", id: backup.id });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.preferencesRestored, true);
  assert.equal((await api("/api/admin/settings")).body.settings.appearance.themeMode, "light");
  const token = await pair();
  assert.equal((await api("/api/admin/backups", "POST", { operation: "export", id: backup.id }, token)).status, 403);
  const before = (await api("/api/admin/info")).body.config;
  assert.equal((await api("/api/admin/backups", "POST", { operation: "restore", id: "../runtime" })).status, 400);
  assert.deepEqual((await api("/api/admin/info")).body.config, before);
});
