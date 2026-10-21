import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { once } from "node:events";
import { createHost } from "../host/server.mjs";
import { loadIdentity } from "../host/network.mjs";

test("Wi-Fi TLS keeps editor/admin private, shares paired tokens, and enforces revocation", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "open-deck-wifi-"));
  const h = createHost({
    dir,
    metrics: false,
    wifi: true,
    wifiPort: 0,
    runner: async () => "",
  });
  await once(h.lanServer, "listening");
  await new Promise((r) => h.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await h.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const cert = fs.readFileSync(path.join(dir, "wifi-cert.pem"));
  const port = h.lanServer.address().port;
  const req = (route, headers = {}, method = "GET", body) =>
    new Promise((resolve, reject) => {
      // Trust only this test's exact generated certificate, never disable certificate verification.
      const r = https.request(
        {
          hostname: "127.0.0.1",
          port,
          path: route,
          method,
          ca: cert,
          servername: "opendeck.local",
          headers: {
            ...headers,
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
        },
        (res) => {
          let text = "";
          res.on("data", (b) => (text += b));
          res.on("end", () =>
            resolve({ status: res.statusCode, body: JSON.parse(text) }),
          );
        },
      );
      r.on("error", reject);
      r.end(body ? JSON.stringify(body) : undefined);
    });
  const local = "http://127.0.0.1:" + h.server.address().port;
  const { token } = await (
    await fetch(local + "/api/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: h.getPin() }),
    })
  ).json();
  const auth = { Authorization: "Bearer " + token };
  assert.equal((await req("/api/snapshot")).status, 401);
  const snap = await req("/api/snapshot", auth);
  assert.equal(snap.status, 200);
  assert.equal(snap.body.network.fingerprint, loadIdentity(dir).fingerprint);
  assert(!JSON.stringify(snap.body.config).includes("actions"));
  for (const route of [
    "/",
    "/app.js",
    "/api/admin/info",
    "/api/admin/config",
    "/api/admin/pin",
  ]) {
    assert.equal(
      (await req(route, { ...auth, "X-Open-Deck-Admin": h.adminKey })).status,
      403,
    );
  }
  assert.equal(
    (await req("/api/snapshot", { ...auth, Origin: "https://evil.example" }))
      .status,
    403,
  );
  const id = h.engine.config.pages[0].widgets.find(
    (w) => w.type === "timer",
  ).id;
  assert.equal(
    (await req("/api/action", auth, "POST", { kind: "timer", id })).status,
    200,
  );
  const devices = JSON.parse(fs.readFileSync(path.join(dir, "devices.json")));
  await fetch(local + "/api/admin/revoke", {
    method: "POST",
    headers: {
      "X-Open-Deck-Admin": h.adminKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id: devices[0].id }),
  });
  assert.equal((await req("/api/snapshot", auth)).status, 401);
  assert.equal(
    loadIdentity(dir).fingerprint,
    snap.body.network.fingerprint,
    "identity persists across launches",
  );
  assert.equal(fs.statSync(path.join(dir, "wifi-key.pem")).mode & 0o777, 0o600);
});
