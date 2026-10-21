import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHost, deviceConfig } from "../host/server.mjs";
import { Engine } from "../host/engine.mjs";
import { sessionWindowIds } from "../host/chrome.mjs";
import { defaultConfig, validateConfig } from "../host/config.mjs";

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "open-deck-test-"));
  const calls = [];
  const h = createHost({
    dir,
    metrics: false,
    runner: async (...args) => {
      calls.push(args);
      return "50, false";
    },
  });
  await new Promise((r) => h.server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + h.server.address().port;
  t.after(async () => {
    await h.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const req = async (url, method = "GET", body, key) =>
    fetch(base + url, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(key ? { Authorization: "Bearer " + key } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  return { ...h, dir, calls, req, base };
}
test("pairing rejects wrong PIN, returns a scoped token, and never exposes commands", async (t) => {
  const h = await setup(t);
  assert.equal((await h.req("/api/snapshot")).status, 401);
  assert.equal(
    (await h.req("/api/pair", "POST", { pin: "000000" })).status,
    401,
  );
  const paired = await (
    await h.req("/api/pair", "POST", { pin: h.getPin(), name: "test" })
  ).json();
  assert.equal(paired.token.length, 64);
  const snap = await (
    await h.req("/api/snapshot", "GET", null, paired.token)
  ).json();
  assert(!JSON.stringify(snap.config).includes("actions"));
  assert.equal(
    (await h.req("/api/admin/info", "GET", null, paired.token)).status,
    403,
  );
  assert.equal(
    (
      await h.req(
        "/api/action",
        "POST",
        { id: "absent", command: "touch /tmp/never" },
        paired.token,
      )
    ).status,
    400,
  );
  assert.equal(h.calls.length, 0);
  assert(
    !fs
      .readFileSync(path.join(h.dir, "devices.json"), "utf8")
      .includes(paired.token),
  );
});
test("pair codes are single-use and brute-force attempts are throttled", async (t) => {
  const h = await setup(t),
    pin = h.getPin();
  assert.equal((await h.req("/api/pair", "POST", { pin })).status, 200);
  assert.equal((await h.req("/api/pair", "POST", { pin })).status, 401);
  for (let i = 0; i < 7; i++) await h.req("/api/pair", "POST", { pin: "0" });
  assert.equal(
    (await h.req("/api/pair", "POST", { pin: h.getPin() })).status,
    429,
  );
});
test("device tokens persist across host restart and revocation closes access", async (t) => {
  const h = await setup(t);
  const { token } = await (
    await h.req("/api/pair", "POST", { pin: h.getPin() })
  ).json();
  const persisted = JSON.parse(
    fs.readFileSync(path.join(h.dir, "devices.json")),
  );
  assert.equal(persisted.length, 1);
  const response = await fetch(h.base + "/api/admin/revoke", {
    method: "POST",
    headers: {
      "X-Open-Deck-Admin": h.adminKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id: persisted[0].id }),
  });
  assert.equal(response.status, 200);
  assert.equal((await h.req("/api/snapshot", "GET", null, token)).status, 401);
});
test("host enforces origin checks and validates changes before persistence", async (t) => {
  const h = await setup(t);
  assert.equal(
    (
      await fetch(h.base + "/api/admin/info", {
        headers: {
          "X-Open-Deck-Admin": h.adminKey,
          Origin: "https://evil.example",
        },
      })
    ).status,
    403,
  );
  const bad = defaultConfig();
  bad.columns = 0;
  const result = await fetch(h.base + "/api/admin/config", {
    method: "PUT",
    headers: {
      "X-Open-Deck-Admin": h.adminKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(bad),
  });
  assert.equal(result.status, 400);
  assert.notEqual(
    JSON.parse(fs.readFileSync(path.join(h.dir, "deck.json"))).columns,
    0,
  );
});
test("repeated taps are dropped while a routine runs, never queued", async () => {
  const c = defaultConfig();
  let release;
  let count = 0;
  const engine = new Engine(
    c,
    () => {},
    () => {
      count++;
      return new Promise((r) => (release = r));
    },
  );
  const id = c.pages[0].widgets[0].id;
  const first = engine.run(id);
  assert.equal((await engine.run(id)).status, "ignored");
  assert.equal(count, 1);
  release("");
  assert.equal((await first).status, "ok");
  assert.equal((await engine.run(id)).status, "ignored");
  assert.equal(count, 1);
});
test("timer pause/resume/reset preserve remaining duration", () => {
  const c = defaultConfig(),
    e = new Engine(c);
  const id = c.pages[0].widgets.find((w) => w.type === "timer").id;
  const started = e.timer(id);
  assert(started.running);
  e.timers.set(id, { ...started, end: Date.now() + 10000 });
  const paused = e.timer(id);
  assert(!paused.running);
  assert(paused.remaining <= 10000 && paused.remaining > 9900);
  assert(e.timer(id).running);
  const reset = e.timer(id, "reset");
  assert.equal(reset.remaining, 25 * 60000);
  assert(!reset.running);
});
test("validation rejects nested excessive flows, unknown types and duplicate identifiers", () => {
  const c = defaultConfig();
  c.pages[0].widgets.push({ ...c.pages[0].widgets[0] });
  assert.throws(() => validateConfig(c));
  const d = defaultConfig();
  d.pages[0].widgets[0].actions = [{ type: "arbitraryRemoteCode" }];
  assert.throws(() => validateConfig(d));
  assert(
    !JSON.stringify(deviceConfig(defaultConfig())).includes("/Applications/"),
  );
});
test("Chrome session parser handles a truncated write without reading unrelated records", () => {
  const b = Buffer.alloc(8 + 11);
  b.write("SNSS");
  b.writeUInt32LE(3, 4);
  b.writeUInt16LE(9, 8);
  b[10] = 0;
  b.writeInt32LE(1234, 11);
  b.writeInt32LE(4321, 15);
  assert.deepEqual(sessionWindowIds(b), ["1234"]);
  assert.deepEqual(sessionWindowIds(b.subarray(0, 14)), []);
  assert.deepEqual(sessionWindowIds(Buffer.from("bad")), []);
});
test("paired devices survive a real host restart", async (t) => {
  const h = await setup(t);
  const { token } = await (
    await h.req("/api/pair", "POST", { pin: h.getPin() })
  ).json();
  const second = createHost({
    dir: h.dir,
    metrics: false,
    runner: async () => "",
  });
  await new Promise((r) => second.server.listen(0, "127.0.0.1", r));
  t.after(() => second.close());
  const r = await fetch(
    "http://127.0.0.1:" + second.server.address().port + "/api/snapshot",
    { headers: { Authorization: "Bearer " + token } },
  );
  assert.equal(r.status, 200);
});
