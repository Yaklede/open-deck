import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHost } from "../host/server.mjs";

const password = "fixture-admin-password";
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "od-account-api-"));
  const host = createHost({ dir, metrics: false, runner: async () => "" });
  await new Promise((resolve) => host.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await host.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${host.server.address().port}`;
  const request = async (
    route,
    { method = "GET", body, cookie, deviceToken, headers = {} } = {},
  ) => {
    const response = await fetch(url + route, {
      method,
      headers: {
        ...(deviceToken
          ? { Authorization: `Bearer ${deviceToken}` }
          : { "X-Open-Deck-Admin": host.adminKey }),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return {
      status: response.status,
      data: await response.json(),
      cookie: response.headers.get("set-cookie")?.split(";")[0],
      cookieHeader: response.headers.get("set-cookie"),
    };
  };
  const account = (body, cookie) =>
    request("/api/admin/account", { method: "POST", body, cookie });
  const setup = () =>
    account({ operation: "setup", username: "fixture-owner", password });
  const pair = async () =>
    (
      await request("/api/pair", {
        method: "POST",
        body: { pin: host.getPin() },
      })
    ).data.token;
  return { host, dir, url, request, account, setup, pair };
}
test("account API enforces persistent login beyond native bootstrap and preserves paired devices", async (t) => {
  const { host, dir, request, setup, pair } = await fixture(t),
    deviceToken = await pair(),
    created = await setup();
  assert.equal(created.status, 200);
  assert.equal(created.data.sessionToken, undefined);
  assert.match(created.cookieHeader, /HttpOnly/);
  assert.match(created.cookieHeader, /SameSite=Strict/);
  for (const route of [
    "/api/admin/info",
    "/api/admin/settings",
    "/api/admin/diagnostics",
    "/api/snapshot",
    "/api/admin/vault",
  ]) {
    const result = await request(route);
    assert.equal(result.status, 401, route);
    assert.equal(result.data.code, "ACCOUNT_LOGIN_REQUIRED");
  }
  assert.equal(
    (await request("/api/action", { method: "POST", body: { id: "missing" } }))
      .status,
    401,
  );
  assert.equal((await request("/api/admin/lock-status")).status, 200);
  assert.equal(
    (await request("/api/admin/info", { cookie: created.cookie })).status,
    200,
  );
  assert.equal((await request("/api/snapshot", { deviceToken })).status, 200);
  assert.equal(
    (await request("/api/admin/account", { deviceToken })).status,
    403,
  );
  const state = await request("/api/admin/account", { cookie: created.cookie });
  assert.equal(state.data.username, "fixture-owner");
  assert.equal(state.data.sessions.length, 1);
  assert.equal(state.data.sessions[0].tokenHash, undefined);
  assert.equal(
    fs.readFileSync(path.join(dir, "account.json"), "utf8").includes(password),
    false,
  );
  assert.equal(
    (
      await request("/api/admin/settings", {
        cookie: created.cookie,
        headers: { Origin: "https://hostile.invalid" },
      })
    ).status,
    403,
  );
  assert.ok(host.adminKey);
});
test("sessions can be listed and individually revoked, and revocation closes only unauthorized editor streams", async (t) => {
  const { host, url, account, setup, pair, request } = await fixture(t),
    deviceToken = await pair(),
    first = await setup(),
    second = await account({
      operation: "login",
      username: "fixture-owner",
      password,
      name: "Second browser",
    });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = await fetch(url + "/api/events", {
      headers: { "X-Open-Deck-Admin": host.adminKey, Cookie: first.cookie },
      signal: controller.signal,
    }),
    reader = stream.body.getReader();
  await reader.read();
  const deviceStream = await fetch(url + "/api/events", {
      headers: { Authorization: `Bearer ${deviceToken}` },
      signal: controller.signal,
    }),
    deviceReader = deviceStream.body.getReader();
  await deviceReader.read();
  const state = (await request("/api/admin/account", { cookie: second.cookie }))
      .data,
    other = state.sessions.find((s) => !s.current);
  assert.equal(
    (
      await account(
        { operation: "revoke-session", id: other.id },
        second.cookie,
      )
    ).status,
    200,
  );
  assert.equal(
    (await request("/api/admin/info", { cookie: first.cookie })).status,
    401,
  );
  assert.equal(
    (await request("/api/admin/info", { cookie: second.cookie })).status,
    200,
  );
  let done = false;
  for (let i = 0; i < 5 && !done; i++) done = (await reader.read()).done;
  assert.equal(done, true);
  assert.equal((await deviceReader.read()).done, false);
  await deviceReader.cancel();
  await account({ operation: "revoke-all" }, second.cookie);
  assert.equal(
    (await request("/api/admin/info", { cookie: second.cookie })).status,
    401,
  );
  assert.equal((await request("/api/snapshot", { deviceToken })).status, 200);
});
test("recovery resets the account and compatible editor lock without exposing credentials in logs", async (t) => {
  const { account, setup, request, dir } = await fixture(t),
    created = await setup();
  const prepared = await account(
    { operation: "recovery-prepare", password },
    created.cookie,
  );
  assert.equal(prepared.status, 200);
  assert.equal(
    (
      await account(
        { operation: "recovery-confirm", ...prepared.data },
        created.cookie,
      )
    ).status,
    200,
  );
  await account({ operation: "logout" }, created.cookie);
  const recovered = await account({
    operation: "recover",
    username: "fixture-owner",
    password: "fixture-recovered-password",
    recoveryKey: prepared.data.recoveryKey,
  });
  assert.equal(recovered.status, 200);
  assert.ok(recovered.cookie);
  assert.equal(
    (await request("/api/admin/info", { cookie: recovered.cookie })).status,
    200,
  );
  const locked = await request("/api/admin/lock", {
    method: "POST",
    cookie: recovered.cookie,
    body: { operation: "lock" },
  });
  assert.equal(locked.status, 200);
  assert.equal(
    (
      await request("/api/admin/lock", {
        method: "POST",
        cookie: recovered.cookie,
        body: { operation: "unlock", password: "fixture-recovered-password" },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request("/api/admin/lock", {
        method: "POST",
        cookie: recovered.cookie,
        body: { operation: "disable", password: "fixture-recovered-password" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await account({
        operation: "recover",
        username: "fixture-owner",
        password: "another-password",
        recoveryKey: prepared.data.recoveryKey,
      })
    ).status,
    403,
  );
  const logs = JSON.stringify(
    (await request("/api/admin/diagnostics", { cookie: recovered.cookie }))
      .data,
  );
  for (const secret of [
    password,
    "fixture-recovered-password",
    prepared.data.recoveryKey,
  ])
    assert.equal(logs.includes(secret), false);
  assert.equal(
    fs
      .readFileSync(path.join(dir, "editor-lock.json"), "utf8")
      .includes("fixture-recovered-password"),
    false,
  );
});
test("vault API encrypts local backups and exposes only secret metadata while enforcing locked state", async (t) => {
  const { request, setup, dir } = await fixture(t),
    { cookie } = await setup();
  const vault = (body) =>
    request("/api/admin/vault", { method: "POST", cookie, body });
  assert.equal(
    (await vault({ operation: "setup", password: "fixture-vault-password" }))
      .status,
    200,
  );
  await vault({
    operation: "secret-set",
    id: "fixture_secret",
    label: "Fixture secret",
    value: "private-token-sentinel",
  });
  const state = await request("/api/admin/vault", { cookie });
  assert.equal(state.data.secrets[0].value, undefined);
  assert.equal(state.data.secretCount, 1);
  const recovery = (await vault({ operation: "recovery-prepare" })).data;
  assert.equal(
    (await vault({ operation: "recovery-confirm", ...recovery })).status,
    200,
  );
  assert.equal(
    (await vault({ operation: "encryption", enabled: true })).status,
    200,
  );
  const backup = await request("/api/admin/backups", {
    method: "POST",
    cookie,
    body: { operation: "create" },
  });
  assert.equal(backup.status, 200);
  const list = (await request("/api/admin/backups", { cookie })).data.backups;
  assert.equal(list[0].encrypted, true);
  const exported = await request("/api/admin/backups", {
    method: "POST",
    cookie,
    body: { operation: "export", id: list[0].id, recoveryProtected: true },
  });
  assert.ok(exported.data.archive.recovery);
  assert.equal(
    JSON.stringify(exported.data).includes("private-token-sentinel"),
    false,
  );
  await vault({ operation: "lock" });
  const blocked = await request("/api/admin/backups", {
    method: "POST",
    cookie,
    body: { operation: "create" },
  });
  assert.equal(blocked.status, 423);
  assert.equal(blocked.data.code, "VAULT_LOCKED");
  assert.equal(
    (await request("/api/admin/vault", { cookie })).data.secrets.length,
    0,
  );
  assert.equal((await request("/api/admin/info", { cookie })).status, 200);
  await vault({ operation: "unlock", password: "fixture-vault-password" });
  assert.equal(
    (
      await request("/api/admin/backups", {
        method: "POST",
        cookie,
        body: { operation: "preview", id: list[0].id },
      })
    ).status,
    200,
  );
  const bytes = fs.readFileSync(path.join(dir, "vault-secrets.json"), "utf8");
  assert.equal(bytes.includes("private-token-sentinel"), false);
});
