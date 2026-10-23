import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EditorLock } from "../host/editor-lock.mjs";
import { defaultSettings } from "../host/settings.mjs";
test("editor lock uses salted hashes, survives restart locked, expires on idle and throttles invalid passwords", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "od-lock-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let at = 1000;
  const settings = defaultSettings();
  settings.security.idleLockMinutes = 1;
  const lock = new EditorLock(
    dir,
    () => settings,
    () => at,
  );
  assert.equal(lock.status().configured, false);
  lock.configure("temporary-test-password");
  const stored = fs.readFileSync(path.join(dir, "editor-lock.json"), "utf8");
  assert(!stored.includes("temporary-test-password"));
  assert.equal(
    fs.statSync(path.join(dir, "editor-lock.json")).mode & 0o777,
    0o600,
  );
  assert.equal(lock.status().locked, false);
  at += 60001;
  assert.equal(lock.status().locked, true);
  lock.unlock("temporary-test-password");
  assert.equal(lock.status().locked, false);
  const restarted = new EditorLock(
    dir,
    () => settings,
    () => at,
  );
  assert.equal(restarted.status().locked, true);
  for (let i = 0; i < 5; i++)
    assert.throws(
      () => restarted.unlock("wrong"),
      (e) => e.status === 403,
    );
  assert.throws(
    () => restarted.unlock("temporary-test-password"),
    (e) => e.status === 429,
  );
  at += 60001;
  restarted.unlock("temporary-test-password");
  restarted.configure("new-test-password", "temporary-test-password");
  assert.throws(() => restarted.disable("temporary-test-password"));
  restarted.disable("new-test-password");
  assert.equal(restarted.status().configured, false);
});
