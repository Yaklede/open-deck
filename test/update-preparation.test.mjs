import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHost } from "../host/server.mjs";
async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "od-update-prepare-"));
  const host = createHost({
    dir,
    metrics: false,
    runner: async () => {
      throw Error("No device/app actions in this test");
    },
  });
  await new Promise((resolve) => host.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await host.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${host.server.address().port}`;
  const api = async (route, method = "GET", input, admin = true) => {
    const response = await fetch(origin + route, {
      method,
      headers: {
        ...(admin ? { "X-Open-Deck-Admin": host.adminKey } : {}),
        "Content-Type": "application/json",
      },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    return { status: response.status, data: await response.json() };
  };
  return { dir, api };
}
test("update preparation creates a before-update safety backup before the installer opens and respects opt-out", async (t) => {
  const { api } = await setup(t);
  assert.equal(
    (await api("/api/admin/update/prepare", "POST", {}, false)).status,
    403,
  );
  const before = (await api("/api/admin/info")).data.config;
  const prepared = await api("/api/admin/update/prepare", "POST", {});
  assert.equal(prepared.status, 200);
  assert.equal(prepared.data.ok, true);
  assert.equal(prepared.data.backup.reason, "before-update");
  const entries = (await api("/api/admin/backups")).data.backups;
  assert.equal(entries.length, 1);
  assert.deepEqual((await api("/api/admin/info")).data.config, before);
  assert.equal(
    (
      await api("/api/admin/settings", "PUT", {
        backups: { beforeUpdate: false },
      })
    ).status,
    200,
  );
  const skipped = await api("/api/admin/update/prepare", "POST", {});
  assert.equal(skipped.status, 200);
  assert.equal(skipped.data.backup, null);
  assert.equal((await api("/api/admin/backups")).data.backups.length, 1);
});
test("locked encrypted backups prevent update preparation without creating plaintext fallback", async (t) => {
  const { api, dir } = await setup(t);
  const vault = (input) => api("/api/admin/vault", "POST", input);
  assert.equal(
    (await vault({ operation: "setup", password: "public-fixture-password" }))
      .status,
    200,
  );
  const recovery = (await vault({ operation: "recovery-prepare" })).data;
  assert.equal(
    (await vault({ operation: "recovery-confirm", ...recovery })).status,
    200,
  );
  assert.equal(
    (await vault({ operation: "encryption", enabled: true })).status,
    200,
  );
  assert.equal((await vault({ operation: "lock" })).status, 200);
  const result = await api("/api/admin/update/prepare", "POST", {});
  assert.equal(result.status, 423);
  assert.equal((await api("/api/admin/backups")).data.backups.length, 0);
});
