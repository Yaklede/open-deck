import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHost } from "../host/server.mjs";
import { deviceDefaults } from "../host/public/device-drafts.mjs";
import { locales } from "../host/public/i18n.mjs";

const otherProfile = "p".repeat(80),
  otherPage = "q".repeat(80);
const values = Object.fromEntries(
  Object.entries(deviceDefaults).map(([key, value]) => [
    key,
    typeof value === "boolean" ? [true, false] : [value],
  ]),
);
Object.assign(values, {
  orientation: ["auto", "landscape", "portrait"],
  theme: ["system", "light", "dark"],
  language: locales.map((item) => item.code),
  timeFormat: ["24h", "12h"],
  renderMode: ["standard", "simple"],
  brightness: [-1, 0, 100],
  textScale: [100, 80, 160],
  vibrationMs: [80, 20, 200],
  screenSaverMinutes: [0, 120],
  dimPercent: [10, 5, 50],
  screenSaverMode: ["dim", "clock"],
  iconResolution: [0, 128, 256, 512],
  profileId: ["", otherProfile],
  startPageId: ["", otherPage],
});
const invalidValues = Object.fromEntries(
  Object.entries(deviceDefaults).map(([key, value]) => [
    key,
    [
      null,
      {},
      [],
      typeof value === "boolean"
        ? "false"
        : typeof value === "number"
          ? "100"
          : false,
    ],
  ]),
);
Object.assign(
  invalidValues,
  Object.fromEntries(
    [
      ["brightness", [-2, 101, 0.5]],
      ["textScale", [79, 161, 80.5]],
      ["vibrationMs", [19, 201, 20.5]],
      ["dimPercent", [4, 51, 5.5]],
      ["screenSaverMinutes", [-1, 121, 0.5]],
      ["iconResolution", [-1, 64, 1024]],
      ["profileId", ["missing", "p".repeat(81), "p\r"]],
      ["startPageId", ["missing", "q".repeat(81), "q\t"]],
      ["orientation", ["sideways"]],
      ["theme", ["blue"]],
      ["language", ["unknown"]],
      ["timeFormat", ["seconds"]],
      ["renderMode", ["fast"]],
      ["screenSaverMode", ["off"]],
    ].map(([key, extra]) => [key, [...invalidValues[key], ...extra]]),
  ),
);

async function fixture(t) {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "opendeck-settings-matrix-"),
  );
  let host, base, adminStream, tabletStream;
  const streams = new Set();
  const start = async () => {
    host = createHost({ dir, metrics: false, runner: async () => "" });
    await new Promise((resolve) => host.server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${host.server.address().port}`;
  };
  await start();
  t.after(async () => {
    for (const stream of [...streams]) await stream.close();
    await host.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const request = async (route, method = "GET", body, token) => {
    const response = await fetch(base + route, {
      method,
      headers: {
        ...(token
          ? { Authorization: `Bearer ${token}` }
          : { "X-Open-Deck-Admin": host.adminKey }),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };
  const api = async (...args) => {
    const result = await request(...args);
    assert.equal(
      result.status,
      200,
      `${args[0]}: ${JSON.stringify(result.body)}`,
    );
    return result.body;
  };
  const a = (
    await api("/api/pair", "POST", {
      pin: host.getPin(),
      name: "Matrix tablet A",
    })
  ).token;
  const b = (
    await api("/api/pair", "POST", {
      pin: host.getPin(),
      name: "Matrix tablet B",
    })
  ).token;
  const config = (await api("/api/admin/info")).config;
  config.pages.push({
    ...structuredClone(config.pages[0]),
    id: otherPage,
    name: "Matrix second page",
    widgets: [],
  });
  config.profiles.push({
    id: otherProfile,
    name: "Matrix second profile",
    pageIds: [otherPage],
    defaultPageId: otherPage,
    focusApps: [],
  });
  await api("/api/admin/config", "PUT", config);
  const seeded = await api(
    "/api/device/settings",
    "PUT",
    { settings: deviceDefaults },
    a,
  );
  const id = seeded.device.id;
  let expectedName = "Matrix tablet A",
    expected = { ...deviceDefaults },
    revision = seeded.device.settingsRevision;

  const openStream = async (token) => {
    const controller = new AbortController();
    const response = await fetch(base + "/api/events", {
      headers: token
        ? { Authorization: `Bearer ${token}` }
        : { "X-Open-Deck-Admin": host.adminKey },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let buffer = "";
    const stream = {
      close: async () => {
        streams.delete(stream);
        controller.abort();
        await reader.cancel().catch(() => {});
      },
      next: async (predicate) => {
        const timer = setTimeout(() => controller.abort(), 3000);
        try {
          for (;;) {
            const boundary = buffer.indexOf("\n\n");
            if (boundary >= 0) {
              const frame = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const line = frame
                .split("\n")
                .find((line) => line.startsWith("data: "));
              if (line) {
                const snapshot = JSON.parse(line.slice(6));
                if (predicate(snapshot)) return snapshot;
              }
              continue;
            }
            const part = await reader.read();
            assert.equal(
              part.done,
              false,
              "SSE ended before the expected settings revision",
            );
            buffer += decoder.decode(part.value, { stream: true });
          }
        } finally {
          clearTimeout(timer);
        }
      },
    };
    streams.add(stream);
    return stream;
  };
  const connect = async () => {
    adminStream = await openStream();
    tabletStream = await openStream(a);
  };
  const verifyStreams = async () => {
    const admin = await adminStream.next((snapshot) =>
      snapshot.devices?.some(
        (d) => d.id === id && d.settingsRevision >= revision,
      ),
    );
    const tablet = await tabletStream.next(
      (snapshot) => snapshot.device?.settingsRevision >= revision,
    );
    assert.deepEqual(admin.devices.find((d) => d.id === id).settings, expected);
    assert.equal(admin.devices.find((d) => d.id === id).name, expectedName);
    assert.deepEqual(tablet.device.settings, expected);
    assert.equal(tablet.device.name, expectedName);
    assert.equal(Object.hasOwn(tablet, "devices"), false);
    for (const row of admin.devices) {
      assert.equal(Object.hasOwn(row, "hash"), false);
      assert.equal(Object.hasOwn(row, "token"), false);
    }
    assert.ok(!JSON.stringify(admin).includes(a));
    assert.ok(!JSON.stringify(admin).includes(b));
  };
  const verifyReads = async () => {
    const own = (await api("/api/device/settings", "GET", undefined, a)).device;
    const list = (await api("/api/admin/info")).devices;
    assert.deepEqual(own.settings, expected);
    assert.equal(own.name, expectedName);
    assert.equal(own.settingsRevision, revision);
    assert.deepEqual(list.find((d) => d.id === id).settings, expected);
    assert.equal(list.find((d) => d.id === id).name, expectedName);
    assert.deepEqual(
      (await api("/api/snapshot", "GET", undefined, a)).device.settings,
      expected,
    );
    assert.deepEqual(
      (await api("/api/device/settings", "GET", undefined, b)).device.settings,
      {},
    );
    const stored = JSON.parse(
      fs.readFileSync(path.join(dir, "devices.json")),
    ).find((d) => d.id === id);
    assert.deepEqual(stored.settings, expected);
    assert.equal(stored.settingsRevision, revision);
    assert.equal(
      fs.statSync(path.join(dir, "devices.json")).mode & 0o777,
      0o600,
    );
  };
  await connect();
  await verifyStreams();
  return {
    request,
    api,
    token: a,
    id,
    dir,
    rename: async (direction, name) => {
      const result =
        direction === "admin"
          ? await api("/api/admin/devices", "PUT", { id, name })
          : await api("/api/device/settings", "PUT", { name }, a);
      expectedName = name.trim();
      assert.equal(result.device.name, expectedName);
      assert.ok(result.device.settingsRevision > revision);
      revision = result.device.settingsRevision;
      await verifyStreams();
      await verifyReads();
    },
    update: async (direction, patch) => {
      const result =
        direction === "admin"
          ? await api("/api/admin/devices", "PUT", { id, settings: patch })
          : await api("/api/device/settings", "PUT", { settings: patch }, a);
      Object.assign(expected, patch);
      assert.ok(result.device.settingsRevision > revision);
      revision = result.device.settingsRevision;
      assert.deepEqual(result.device.settings, expected);
      await verifyStreams();
      await verifyReads();
    },
    reject: async (direction, patch) => {
      const before = fs.readFileSync(path.join(dir, "devices.json"), "utf8");
      const result =
        direction === "admin"
          ? await request("/api/admin/devices", "PUT", { id, settings: patch })
          : await request(
              "/api/device/settings",
              "PUT",
              { settings: patch },
              a,
            );
      assert.equal(result.status, 400, JSON.stringify(patch));
      assert.equal(
        fs.readFileSync(path.join(dir, "devices.json"), "utf8"),
        before,
      );
      await verifyReads();
    },
    restartEditorConnection: async () => {
      await adminStream.close();
      adminStream = await openStream();
      const data = await adminStream.next((snapshot) =>
        snapshot.devices?.some((d) => d.id === id),
      );
      assert.deepEqual(
        data.devices.find((d) => d.id === id).settings,
        expected,
      );
      await verifyReads();
    },
    restartTabletConnection: async () => {
      await tabletStream.close();
      tabletStream = await openStream(a);
      const data = await tabletStream.next(
        (snapshot) => snapshot.device?.id === id,
      );
      assert.deepEqual(data.device.settings, expected);
      await verifyReads();
    },
    restartAll: async () => {
      const previousKey = host.adminKey;
      for (const stream of [...streams]) await stream.close();
      await host.close();
      await start();
      assert.notEqual(host.adminKey, previousKey);
      await verifyReads();
      await connect();
      await verifyStreams();
    },
  };
}

test(
  "all shared settings round-trip through both writers, SSE, fresh client connections and host restart",
  { timeout: 120000 },
  async (t) => {
    assert.deepEqual(
      Object.keys(values).sort(),
      Object.keys(deviceDefaults).sort(),
    );
    const source = fs.readFileSync(
      new URL("../host/settings.mjs", import.meta.url),
      "utf8",
    );
    const schemaSource = source.slice(
      source.indexOf("const deviceSchema = {"),
      source.indexOf("export function validateDeviceSettings"),
    );
    const schemaKeys = [...schemaSource.matchAll(/^  ([a-zA-Z]+):/gm)].map(
      (match) => match[1],
    );
    assert.deepEqual(
      schemaKeys.sort(),
      Object.keys(values).sort(),
      "every host device-schema field must have matrix coverage",
    );
    for (const [field, valid] of Object.entries(values)) {
      await t.test(field, async (t) => {
        const f = await fixture(t);
        for (const direction of ["admin", "tablet"]) {
          for (const value of valid) {
            const patch = { [field]: value };
            if (field === "profileId") patch.startPageId = "";
            if (field === "startPageId") patch.profileId = otherProfile;
            await f.update(direction, patch);
          }
          await f.restartEditorConnection();
          await f.restartTabletConnection();
          await f.restartAll();
          for (const invalid of invalidValues[field])
            await f.reject(direction, { [field]: invalid });
        }
        await f.update("admin", deviceDefaults);
        await f.restartAll();
      });
    }
  },
);

test("mixed invalid batches and unknown fields cannot partially persist valid changes", async (t) => {
  const f = await fixture(t);
  for (const direction of ["admin", "tablet"]) {
    await f.reject(direction, { sound: true, textScale: null });
    await f.reject(direction, { brightness: 0, unknownSetting: true });
    await f.reject(direction, { awake: false, orientation: "invalid" });
    await f.reject(direction, {
      profileId: otherProfile,
      startPageId: "missing",
    });
  }
  await f.restartAll();
});

test("explicit null/falsy settings wrappers reject without incrementing revision or changing disk", async (t) => {
  const f = await fixture(t);
  for (const direction of ["admin", "tablet"])
    for (const shape of [null, false, 0, "", [], "not-settings"])
      await f.reject(direction, shape);
  await f.restartAll();
});

test("a rejected tablet settings update cannot change model/version metadata in memory or on disk", async (t) => {
  const f = await fixture(t);
  const before = (await f.api("/api/admin/info")).devices;
  const saved = fs.readFileSync(path.join(f.dir, "devices.json"), "utf8");
  const result = await f.request(
    "/api/device/settings",
    "PUT",
    {
      model: "rejected-update-model",
      appVersion: "99.0.0",
      settings: { textScale: null },
    },
    f.token,
  );
  assert.equal(result.status, 400);
  assert.deepEqual((await f.api("/api/admin/info")).devices, before);
  assert.equal(
    fs.readFileSync(path.join(f.dir, "devices.json"), "utf8"),
    saved,
  );
  await f.restartAll();
});

test("device names trim consistently in both directions and retain their maximum length through restart", async (t) => {
  const f = await fixture(t);
  for (const direction of ["admin", "tablet"]) {
    for (const name of [
      "  Trimmed fixture name  ",
      "기기 이름 · Fixture",
      "N".repeat(80),
    ])
      await f.rename(direction, name);
    await f.restartEditorConnection();
    await f.restartTabletConnection();
    await f.restartAll();
    for (const name of [null, false, 0, "", "   ", "N".repeat(81)]) {
      const before = (await f.api("/api/admin/info")).devices;
      const saved = fs.readFileSync(path.join(f.dir, "devices.json"), "utf8");
      const result =
        direction === "admin"
          ? await f.request("/api/admin/devices", "PUT", { id: f.id, name })
          : await f.request("/api/device/settings", "PUT", { name }, f.token);
      assert.equal(result.status, 400);
      assert.deepEqual((await f.api("/api/admin/info")).devices, before);
      assert.equal(
        fs.readFileSync(path.join(f.dir, "devices.json"), "utf8"),
        saved,
      );
    }
  }
});

test("non-object top-level device payloads reject without mutation", async (t) => {
  const f = await fixture(t);
  const before = (await f.api("/api/admin/info")).devices;
  const saved = fs.readFileSync(path.join(f.dir, "devices.json"), "utf8");
  for (const route of ["/api/admin/devices", "/api/device/settings"])
    for (const body of [null, false, 0, "", [], ["name"]]) {
      const result = await f.request(
        route,
        "PUT",
        body,
        route === "/api/device/settings" ? f.token : undefined,
      );
      assert.equal(result.status, 400, `${route}: ${JSON.stringify(body)}`);
      assert.deepEqual((await f.api("/api/admin/info")).devices, before);
      assert.equal(
        fs.readFileSync(path.join(f.dir, "devices.json"), "utf8"),
        saved,
      );
    }
});
