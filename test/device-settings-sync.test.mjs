import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHost } from "../host/server.mjs";

test("admin SSE exposes safe live device settings while tablet streams remain isolated", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opendeck-device-sync-"));
  const host = createHost({ dir, metrics: false, runner: async () => "" });
  await new Promise((resolve) => host.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${host.server.address().port}`;
  const abort = new AbortController();
  t.after(async () => {
    abort.abort();
    await host.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const api = async (route, method = "GET", body, token) => {
    const response = await fetch(base + route, {
      method,
      headers: {
        ...(token
          ? { Authorization: `Bearer ${token}` }
          : { "X-Open-Deck-Admin": host.adminKey }),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const first = await api("/api/pair", "POST", {
    pin: host.getPin(),
    name: "First tablet",
  });
  const second = await api("/api/pair", "POST", {
    pin: host.getPin(),
    name: "Second tablet",
  });
  const openStream = async (token) => {
    const response = await fetch(base + "/api/events", {
      headers: token
        ? { Authorization: `Bearer ${token}` }
        : { "X-Open-Deck-Admin": host.adminKey },
      signal: abort.signal,
    });
    const reader = response.body.getReader();
    let buffer = "";
    const decoder = new TextDecoder();
    return async (predicate) => {
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary >= 0) {
          const part = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = part
            .split("\n")
            .find((line) => line.startsWith("data: "));
          if (data) {
            const parsed = JSON.parse(data.slice(6));
            if (predicate(parsed)) return parsed;
          }
          continue;
        }
        const chunk = await reader.read();
        assert.equal(chunk.done, false, "stream unexpectedly closed");
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    };
  };
  const nextAdmin = await openStream();
  const initial = await nextAdmin((value) => Array.isArray(value.devices));
  assert.equal(initial.devices.length, 2);
  assert.ok(initial.devices.every((d) => !d.online));
  const changed = await api(
    "/api/device/settings",
    "PUT",
    {
      name: "Renamed on tablet",
      model: "Fixture tablet",
      appVersion: "0.10.1",
      settings: { theme: "light", textScale: 135 },
    },
    first.token,
  );
  const update = await nextAdmin((value) =>
    value.devices?.some((d) => d.name === "Renamed on tablet"),
  );
  const own = update.devices.find((d) => d.id === changed.device.id);
  assert.equal(own.settings.textScale, 135);
  assert.equal(own.model, "Fixture tablet");
  for (const forbidden of ["hash", "token", "adminKey", "sessionToken"])
    assert.ok(update.devices.every((d) => !Object.hasOwn(d, forbidden)));
  assert.ok(!JSON.stringify(update).includes(first.token));
  assert.ok(!JSON.stringify(update).includes(second.token));
  const nextTablet = await openStream(first.token);
  const tabletSnapshot = await nextTablet((value) => !!value.device);
  assert.equal(Object.hasOwn(tabletSnapshot, "devices"), false);
  assert.equal(tabletSnapshot.device.id, changed.device.id);
  const online = await nextAdmin((value) =>
    value.devices?.some((d) => d.id === changed.device.id && d.online),
  );
  assert.equal(
    online.devices.find((d) => d.name === "Second tablet").online,
    false,
  );
  await api("/api/admin/devices", "PUT", {
    id: changed.device.id,
    settings: { sound: true },
  });
  const final = (
    await api("/api/device/settings", "GET", undefined, first.token)
  ).device;
  assert.deepEqual(final.settings, {
    theme: "light",
    textScale: 135,
    sound: true,
  });
  assert.equal(final.name, "Renamed on tablet");
  assert.deepEqual(
    (await api("/api/device/settings", "GET", undefined, second.token)).device
      .settings,
    {},
  );
  const pairedSnapshot = await api(
    "/api/snapshot",
    "GET",
    undefined,
    first.token,
  );
  assert.equal(Object.hasOwn(pairedSnapshot, "devices"), false);
});
