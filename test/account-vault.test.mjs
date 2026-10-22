import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AccountManager } from "../host/account.mjs";
import { SecretVault } from "../host/secret-vault.mjs";
import { Backups } from "../host/backups.mjs";
import { validateConfig } from "../host/config.mjs";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "od-security-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let at = Date.now();
  return { dir, now: () => at, advance: (n) => (at += n) };
}
const pass = "fixture-password-7342";
test("account passwords and sessions persist hashed, expire, and support targeted revocation", (t) => {
  const f = fixture(t),
    a = new AccountManager(f.dir, f.now);
  assert.equal(a.authenticate(undefined), true);
  const first = a.setup({ username: "owner", password: pass, sessionHours: 2 }),
    second = a.login({ username: "owner", password: pass, name: "Browser" });
  const text = fs.readFileSync(a.file, "utf8");
  assert.equal(text.includes(pass), false);
  assert.equal(text.includes(first.sessionToken), false);
  assert.equal(fs.statSync(a.file).mode & 0o777, 0o600);
  const restarted = new AccountManager(f.dir, f.now);
  assert.equal(restarted.authenticate(first.sessionToken), true);
  assert.equal(restarted.sessions(first.sessionToken).length, 2);
  restarted.revoke(first.sessionToken, { id: second.sessionId });
  assert.equal(restarted.authenticate(second.sessionToken), false);
  f.advance(2 * 3600000 + 1);
  assert.equal(restarted.authenticate(first.sessionToken), false);
});
test("account updates require current password and password change revokes other sessions", (t) => {
  const f = fixture(t),
    a = new AccountManager(f.dir, f.now),
    s = a.setup({ username: "owner", password: pass }),
    other = a.login({ username: "owner", password: pass });
  assert.throws(() =>
    a.update(s.sessionToken, { currentPassword: "wrong", username: "new" }),
  );
  a.update(s.sessionToken, {
    currentPassword: pass,
    username: "new",
    password: "replacement-password",
    sessionHours: 4,
  });
  assert.equal(a.authenticate(other.sessionToken), false);
  assert.equal(a.authenticate(s.sessionToken), true);
  assert.throws(() =>
    a.login({ username: "owner", password: "replacement-password" }),
  );
  assert.equal(
    a.login({ username: "new", password: "replacement-password" })
      .authenticated,
    true,
  );
  a.revoke(s.sessionToken, { all: true });
  assert.equal(a.authenticate(s.sessionToken), false);
});
test("account recovery requires confirmed one-time key; rotates and consumes on reset", (t) => {
  const f = fixture(t),
    a = new AccountManager(f.dir, f.now),
    s = a.setup({ username: "owner", password: pass });
  const unconfirmed = a.prepareRecovery(s.sessionToken, pass);
  assert.equal(a.status(s.sessionToken).recoveryConfigured, false);
  assert.throws(() =>
    a.recover({
      username: "owner",
      recoveryKey: unconfirmed.recoveryKey,
      password: "next-password",
    }),
  );
  a.confirmRecovery(s.sessionToken, unconfirmed);
  const rotated = a.prepareRecovery(s.sessionToken, pass);
  a.confirmRecovery(s.sessionToken, rotated);
  assert.throws(() =>
    a.recover({
      username: "owner",
      recoveryKey: unconfirmed.recoveryKey,
      password: "next-password",
    }),
  );
  assert.equal(
    fs.readFileSync(a.file, "utf8").includes(rotated.recoveryKey),
    false,
  );
  const recovered = a.recover({
    username: "owner",
    recoveryKey: rotated.recoveryKey,
    password: "next-password",
  });
  assert.equal(a.authenticate(s.sessionToken), false);
  assert.equal(recovered.recoveryConfigured, false);
  assert.throws(() =>
    a.recover({
      username: "owner",
      recoveryKey: rotated.recoveryKey,
      password: "third-password",
    }),
  );
});
test("failed authentication is throttled, including recovery", (t) => {
  const f = fixture(t),
    a = new AccountManager(f.dir, f.now);
  a.setup({ username: "owner", password: pass });
  for (let i = 0; i < 5; i++)
    assert.throws(() => a.login({ username: "owner", password: "wrong" }), {
      status: 403,
    });
  assert.throws(() => a.login({ username: "owner", password: pass }), {
    status: 429,
  });
  f.advance(60001);
  assert.equal(
    a.login({ username: "owner", password: pass }).authenticated,
    true,
  );
});
test("vault keeps master key, passwords and secrets encrypted and stays locked after restart", (t) => {
  const f = fixture(t),
    v = new SecretVault(f);
  v.setup(pass);
  v.setSecret({
    id: "test",
    label: "Test connector",
    value: "secret-token-sentinel",
  });
  const stored =
    fs.readFileSync(v.file, "utf8") + fs.readFileSync(v.secretFile, "utf8");
  assert.equal(stored.includes(pass), false);
  assert.equal(stored.includes("secret-token-sentinel"), false);
  assert.equal(stored.includes(v.key.toString("base64")), false);
  assert.deepEqual(
    v.listSecrets().map((s) => Object.keys(s).sort()),
    [["id", "label", "updatedAt"]],
  );
  const restart = new SecretVault(f);
  assert.equal(restart.status().unlocked, false);
  assert.throws(() => restart.readSecret("test"), { code: "VAULT_LOCKED" });
  restart.unlock(pass);
  assert.equal(restart.readSecret("test"), "secret-token-sentinel");
  restart.lock();
  assert.equal(restart.hasSecret("test"), true);
  assert.equal(restart.hasSecret("other_id"), false);
  restart.unlock(pass);
  restart.changePassword(pass, "different-password");
  restart.lock();
  assert.throws(() => restart.unlock(pass));
  restart.unlock("different-password");
  restart.removeSecret("test");
  for (const id of ["__proto__", "constructor", "toString"]) {
    restart.setSecret({ id, label: "Reserved object name", value: "preserved-value" });
    restart.lock();
    restart.unlock("different-password");
    assert.equal(restart.hasSecret(id), true);
    assert.equal(restart.readSecret(id), "preserved-value");
    assert.ok(restart.listSecrets().some((s) => s.id === id));
    restart.removeSecret(id);
  }
  assert.equal(restart.status().secretCount, 0);
});
test("vault recovery has confirmation, rotation, lost-password recovery and portable backup decryption", (t) => {
  const f = fixture(t),
    v = new SecretVault(f);
  v.setup(pass);
  assert.throws(() => v.setBackupEncryption(true));
  const key = v.prepareRecovery();
  v.confirmRecovery(key);
  v.setBackupEncryption(true);
  const archive = {
      createdAt: new Date().toISOString(),
      reason: "manual",
      privateValue: "sentinel",
    },
    portable = v.encryptBackup(archive, { recoveryProtected: true });
  const anotherDir = fs.mkdtempSync(path.join(os.tmpdir(), "od-recover-"));
  t.after(() => fs.rmSync(anotherDir, { recursive: true, force: true }));
  const other = new SecretVault({ dir: anotherDir });
  assert.deepEqual(other.decryptBackup(portable, key.recoveryKey), archive);
  assert.throws(() =>
    other.decryptBackup(
      { ...portable, data: Buffer.from("broken").toString("base64") },
      key.recoveryKey,
    ),
  );
  const rotated = v.prepareRecovery();
  v.confirmRecovery(rotated);
  v.lock();
  assert.throws(() =>
    v.recover({ recoveryKey: key.recoveryKey, password: "new-password" }),
  );
  v.recover({ recoveryKey: rotated.recoveryKey, password: "new-password" });
  assert.equal(v.status().recoveryConfigured, false);
  assert.equal(v.status().unlocked, true);
  assert.equal(
    fs.readFileSync(v.file, "utf8").includes(rotated.recoveryKey),
    false,
  );
});
test("local backup encryption migrates plaintext and never falls back to plaintext while locked", (t) => {
  const f = fixture(t),
    v = new SecretVault(f),
    config = validateConfig({
      version: 2,
      name: "Sensitive deck sentinel",
      columns: 4,
      pages: [{ id: "main", name: "Main", columns: 4, rows: 1, widgets: [] }],
      variables: {},
    });
  const b = new Backups({
    ...f,
    getConfig: () => config,
    applyConfig: () => {},
    vault: v,
    getSettings: () => ({ enabled: true, retention: 10 }),
  });
  const plain = b.create();
  assert.equal(b.preview(plain.id).encrypted, false);
  v.setup(pass);
  const key = v.prepareRecovery();
  v.confirmRecovery(key);
  v.setBackupEncryption(true);
  assert.equal(b.encryptExisting().converted, 1);
  assert.equal(
    fs
      .readFileSync(b.file(plain.id), "utf8")
      .includes("Sensitive deck sentinel"),
    false,
  );
  assert.equal(b.preview(plain.id).encrypted, true);
  const protectedExport = b.export(plain.id, undefined, {
    recoveryProtected: true,
  });
  assert.ok(protectedExport.recovery);
  v.lock();
  assert.throws(() => b.create(), { code: "VAULT_LOCKED" });
  assert.throws(() => b.tick(), { code: "VAULT_LOCKED" });
  assert.equal(
    b.list().every((row) => row.locked),
    true,
  );
  v.unlock(pass);
  assert.equal(b.read(plain.id).config.name, config.name);
  assert.equal(b.import(protectedExport, key.recoveryKey).encrypted, true);
});
test("security file symlinks are rejected", (t) => {
  const f = fixture(t),
    target = path.join(f.dir, "target.json");
  fs.writeFileSync(target, "{}");
  fs.symlinkSync(target, path.join(f.dir, "account.json"));
  assert.throws(() => new AccountManager(f.dir));
});

test("lost recovery keys are invalidated and lost/consumed state survives restart", (t) => {
  const f = fixture(t),
    a = new AccountManager(f.dir, f.now),
    login = a.setup({ username: "owner", password: pass });
  const accountKey = a.prepareRecovery(login.sessionToken, pass);
  a.confirmRecovery(login.sessionToken, accountKey);
  a.markRecoveryLost(login.sessionToken, pass);
  assert.equal(
    new AccountManager(f.dir, f.now).status(login.sessionToken).recoveryState,
    "lost",
  );
  assert.throws(() =>
    a.recover({
      username: "owner",
      recoveryKey: accountKey.recoveryKey,
      password: "replacement-password",
    }),
  );
  const v = new SecretVault(f);
  v.setup(pass);
  const key = v.prepareRecovery();
  v.confirmRecovery(key);
  v.markRecoveryLost();
  assert.equal(new SecretVault(f).status().recoveryState, "lost");
  assert.throws(() =>
    v.recover({
      recoveryKey: key.recoveryKey,
      password: "replacement-password",
    }),
  );
  const nextKey = v.prepareRecovery();
  v.confirmRecovery(nextKey);
  v.recover({
    recoveryKey: nextKey.recoveryKey,
    password: "replacement-password",
  });
  assert.equal(new SecretVault(f).status().recoveryState, "consumed");
});
