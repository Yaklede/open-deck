import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHost } from "../host/server.mjs";
import { importMacroDeck } from "../host/macrodeck-portable.mjs";

test("portable API preview, encrypted export and safe merge preserve the current deck and require confirmation", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "od-migration-api-"));
  let executions = 0;
  const host = createHost({
    dir,
    metrics: false,
    runner: async () => {
      executions++;
    },
  });
  await new Promise((resolve) => host.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await host.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${host.server.address().port}`;
  const call = async (route, value) => {
    const response = await fetch(url + route, {
      method: value ? "POST" : "GET",
      headers: {
        "X-Open-Deck-Admin": host.adminKey,
        "Content-Type": "application/json",
      },
      body: value ? JSON.stringify(value) : undefined,
    });
    return { status: response.status, data: await response.json() };
  };
  const before = (await call("/api/admin/info")).data.config;
  const exported = await call("/api/admin/migration", {
    operation: "export",
    kind: "Profile",
    password: "fixture-password",
  });
  assert.equal(exported.status, 200);
  const raw = Buffer.from(exported.data.data, "base64");
  assert.ok(
    (await importMacroDeck(raw, { password: "fixture-password" })).summary
      .pages,
  );
  assert.equal(
    (
      await call("/api/admin/migration", {
        operation: "preview",
        data: exported.data.data,
        password: "wrong",
      })
    ).status,
    400,
  );
  const preview = await call("/api/admin/migration", {
    operation: "preview",
    data: exported.data.data,
    password: "fixture-password",
  });
  assert.equal(preview.status, 200);
  assert.deepEqual((await call("/api/admin/info")).data.config, before);
  assert.equal(
    (
      await call("/api/admin/migration", {
        operation: "import",
        previewId: preview.data.previewId,
      })
    ).status,
    400,
  );
  const applied = await call("/api/admin/migration", {
    operation: "import",
    previewId: preview.data.previewId,
    confirmed: true,
  });
  assert.equal(applied.status, 200);
  assert.ok(applied.data.safetyBackup.id);
  assert.equal(applied.data.config.defaultProfileId, before.defaultProfileId);
  assert.deepEqual(
    applied.data.config.pages.slice(0, before.pages.length),
    before.pages,
  );
  assert.equal(
    applied.data.config.profiles.length,
    before.profiles.length + preview.data.summary.profiles,
  );
  assert.equal(executions, 0, "import never executes an action");
  assert.equal(
    (
      await call("/api/admin/migration", {
        operation: "import",
        previewId: preview.data.previewId,
        confirmed: true,
      })
    ).status,
    400,
  );
  const bad = await call("/api/admin/migration", {
    operation: "preview",
    data: "not base64",
  });
  assert.equal(bad.status, 400);
  assert.deepEqual(
    (await call("/api/admin/info")).data.config,
    applied.data.config,
  );
  const diagnostics = JSON.stringify(
    (await call("/api/admin/diagnostics")).data,
  );
  assert.ok(!diagnostics.includes("fixture-password"));
});
