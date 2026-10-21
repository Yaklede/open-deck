import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Plugins } from "../host/plugins.mjs";
async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "od-plugin-")),
    folder = path.join(dir, "fixture");
  fs.mkdirSync(folder);
  fs.writeFileSync(
    path.join(folder, "manifest.json"),
    JSON.stringify({
      id: "test.plugin",
      name: "Test fixture",
      version: "1",
      entrypoints: { "osx-arm64": { executable: "run" } },
    }),
  );
  const fixture = fileURLToPath(
    new URL("./fixtures/plugin.mjs", import.meta.url),
  );
  fs.writeFileSync(
    path.join(folder, "run"),
    "#!/bin/sh\nexec " +
      JSON.stringify(process.execPath) +
      " " +
      JSON.stringify(fixture) +
      "\n",
    { mode: 0o700 },
  );
  const p = new Plugins(dir);
  await p.ready;
  t.after(async () => {
    await p.close();
    await new Promise((r) => setTimeout(r, 50));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { p, dir, folder };
}
test("plugin bridge authenticates sessions, negotiates only supported versions, executes actions and polls real child variables", async (t) => {
  const { p, folder } = await setup(t);
  const base = "http://127.0.0.1:" + p.server.address().port;
  const bad = await fetch(base + "/api/plugins/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(bad.status, 401);
  assert.deepEqual(
    (await (await fetch(base + "/api/plugins/protocol")).json())
      .capabilityKinds,
    ["actions", "variables", "events"],
  );
  const id = p.register(folder);
  await p.start(id);
  for (let n = 0; n < 100 && !p.list()[0].variables.length; n++)
    await new Promise((r) => setTimeout(r, 30));
  const entry = p.list()[0];
  assert.equal(entry.state, "connected");
  assert(entry.capabilities.some((c) => c.kind === "ui" && !c.accepted));
  assert.equal(Object.values(p.values())[0], 7);
  await p.invoke(id, "increase");
  assert.equal(Object.values(p.values())[0], 8);
  await assert.rejects(p.invoke(id, "missing"));
  assert(
    !fs
      .readFileSync(path.join(p.dir, "plugins.json"), "utf8")
      .includes("sessionToken"),
  );
  p.stop(id);
  assert.deepEqual(p.values(), {});
  assert.equal(p.list()[0].enabled, false);
});
test("plugin registration refuses executables escaping the approved folder", async (t) => {
  const { p, folder } = await setup(t);
  const file = path.join(folder, "manifest.json"),
    m = JSON.parse(fs.readFileSync(file));
  m.entrypoints["osx-arm64"].executable = process.execPath;
  fs.writeFileSync(file, JSON.stringify(m));
  assert.throws(() => p.register(folder), /폴더/);
});
