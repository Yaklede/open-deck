import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Backups, MAX_BACKUP_BYTES } from "../host/backups.mjs";
import { validateConfig } from "../host/config.mjs";
import { saveAsset } from "../host/assets.mjs";
import { defaultSettings } from "../host/settings.mjs";
import { Engine } from "../host/engine.mjs";

const baseConfig = () => validateConfig({
  version: 2, name: "Test deck", columns: 4,
  profiles: [
    { id: "work", name: "Work", pageIds: ["work-page"], defaultPageId: "work-page", focusApps: [] },
    { id: "home", name: "Home", pageIds: ["home-page"], defaultPageId: "home-page", focusApps: [] },
  ],
  defaultProfileId: "work",
  pages: [
    { id: "work-page", name: "Work", columns: 4, rows: 2, theme: "midnight", gap: 12, radius: 13, widgets: [
      { id: "work-button", type: "button", label: "Count {{count}}", x: 0, y: 0, w: 1, h: 1, actions: [{ type: "increment", variable: "count", value: 1 }] },
      { id: "work-todo", type: "todo", label: "Tasks", x: 1, y: 0, w: 1, h: 1 },
    ] },
    { id: "home-page", name: "Home", columns: 4, rows: 1, theme: "paper", gap: 8, radius: 8, widgets: [
      { id: "home-button", type: "button", label: "Home", x: 0, y: 0, w: 1, h: 1, actions: [{ type: "toggleVariable", variable: "enabled" }] },
      { id: "home-todo", type: "todo", label: "Home tasks", x: 1, y: 0, w: 1, h: 1 },
    ] },
  ],
  variables: { count: 0, enabled: true }, integrations: [], extensions: {}, automations: [],
});

function setup(t, initial = baseConfig()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "od-backup-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const live = {
    config: initial,
    state: { variables: { count: 7, enabled: false }, todos: { "work-todo": [{ id: "todo-1", text: "Finish report", done: false }], "home-todo": [{ id: "todo-2", text: "Groceries", done: true }] } },
    settings: defaultSettings(),
    at: new Date(2026, 9, 22, 10, 0).getTime(), writes: 0,
  };
  const options = { dir, getConfig: () => live.config, getSettings: () => live.settings, getPreferences: () => live.settings, applyPreferences: (settings) => { live.settings = structuredClone(settings); }, getState: () => live.state, applyConfig: (config) => { live.config = structuredClone(config); live.writes++; }, applyState: (state) => { live.state = structuredClone(state); }, now: () => live.at };
  return { dir, live, options, backups: new Backups(options) };
}

function addImage(dir, config) {
  const data = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cCioAAAAASUVORK5CYII=";
  const { id } = saveAsset(dir, data);
  config.pages[0].widgets[0].image = id;
  return { id, data };
}

test("manual backup has preview, private files, verified assets and no runtime secrets", (t) => {
  const { dir, live, backups } = setup(t);
  const { id: assetId } = addImage(dir, live.config);
  live.config.adminKey = "runtime-secret";
  live.config.devices = [{ token: "device-secret" }];
  live.state.notifications = [{ text: "private-system-message" }];
  fs.writeFileSync(path.join(dir, "runtime.json"), '{"adminKey":"runtime-secret"}');
  const meta = backups.create();
  assert.deepEqual(meta.counts, { profiles: 2, pages: 2, widgets: 4, variables: 2, todos: 2, assets: 1 });
  assert.equal(meta.storage, "private-plaintext");
  assert.equal(meta.hasPreferences, true);
  assert.equal(backups.list()[0].id, meta.id);
  assert.equal(backups.preview(meta.id).hasState, true);
  const archive = backups.export(meta.id);
  assert.ok(archive.assets[assetId]);
  assert.equal(archive.config.adminKey, undefined);
  assert.equal(archive.config.devices, undefined);
  assert.equal(archive.state.notifications, undefined);
  assert.equal(fs.statSync(path.join(dir, "backups", `${meta.id}.json`)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, "backups")).mode & 0o777, 0o700);
  backups.remove(meta.id);
  assert.deepEqual(backups.list(), []);
});

test("restore applies config and optional persistent state after a safety backup", (t) => {
  const { live, backups } = setup(t);
  const original = structuredClone(live.config), state = structuredClone(live.state), meta = backups.create();
  live.at += 1000;
  live.config.pages[0].name = "Changed";
  live.state.variables.count = 98;
  const result = backups.restore(meta.id, { restoreState: true });
  assert.equal(result.ok, true);
  assert.equal(result.stateRestored, true);
  assert.deepEqual(live.config, original);
  assert.deepEqual(live.state, state);
  assert.equal(backups.preview(result.safetyBackupId).reason, "before-restore");
  assert.equal(backups.export(result.safetyBackupId).config.pages[0].name, "Changed");
});

test("without state restore changing the config does not rewind live variables", (t) => {
  const { live, backups } = setup(t);
  const meta = backups.create();
  live.state.variables.count = 42;
  const result = backups.restore(meta.id);
  assert.equal(result.stateRestored, false);
  assert.equal(live.state.variables.count, 42);
});

test("restoring config through the real engine preserves only compatible live variables and tasks", (t) => {
  const initial = baseConfig();
  initial.variables.returning = 7;
  initial.variables.changedType = 0;
  const { dir } = setup(t, initial);
  let config = initial;
  const engine = new Engine(config);
  const backups = new Backups({
    dir,
    getConfig: () => config,
    getState: () => ({ variables: engine.variables, todos: engine.todos }),
    applyConfig: (next) => { config = next; engine.configure(next); },
    applyState: (state) => { Object.assign(engine.variables, state.variables); engine.todos = state.todos; },
  });
  const archive = backups.create();
  const current = structuredClone(config);
  current.variables.count = 10;
  current.variables.changedType = "new type";
  current.variables.removed = 123;
  delete current.variables.returning;
  current.pages[0].widgets = current.pages[0].widgets.filter((w) => w.id !== "work-todo");
  current.pages[0].widgets.push({ id: "removed-todo", type: "todo", label: "Recent", x: 1, y: 0, w: 1, h: 1 });
  config = validateConfig(current);
  engine.configure(config);
  engine.variables.count = 99;
  engine.variables.enabled = false;
  engine.variables.changedType = "live value";
  engine.todos = {
    "home-todo": [{ id: "home-current", text: "Keep current task", done: true }],
    "removed-todo": [{ id: "removed-current", text: "No longer a widget", done: false }],
  };
  const result = backups.restore(archive.id, { restoreState: false });
  assert.equal(result.stateRestored, false);
  assert.deepEqual(engine.variables, { count: 99, enabled: false, returning: 7, changedType: 0 });
  assert.deepEqual(engine.todos, { "home-todo": [{ id: "home-current", text: "Keep current task", done: true }] });
  assert.equal(engine.config.variables.count, 0);
});

test("full restore includes validated app preferences while profile-only restore leaves them intact", (t) => {
  const { live, backups } = setup(t);
  live.settings.appearance.themeMode = "light";
  const meta = backups.create();
  live.settings.appearance.themeMode = "dark";
  assert.equal(backups.restore(meta.id, { profileIds: ["work"] }).preferencesRestored, false);
  assert.equal(live.settings.appearance.themeMode, "dark");
  assert.equal(backups.restore(meta.id).preferencesRestored, true);
  assert.equal(live.settings.appearance.themeMode, "light");
  live.settings.appearance.themeMode = "dark";
  assert.equal(backups.restore(meta.id, { restorePreferences: false }).preferencesRestored, false);
  assert.equal(live.settings.appearance.themeMode, "dark");
  const archive = backups.export(meta.id);
  archive.preferences.auth = { token: "forbidden" };
  const { checksum, ...payload } = archive;
  archive.checksum = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  assert.throws(() => backups.import(archive), /지원하지 않는 설정/);
});

test("selective restore replaces only chosen profiles and preserves unrelated state and settings", (t) => {
  const { live, backups } = setup(t);
  const meta = backups.create();
  live.at += 1000;
  live.config.pages[0].name = "Changed work";
  live.config.pages[1].name = "Keep new home";
  live.config.variables.enabled = false;
  live.state.variables.count = 88;
  live.state.variables.enabled = true;
  live.state.todos["home-todo"][0].text = "Keep my new home task";
  const untouched = structuredClone(live.config.pages[1]);
  const result = backups.restore(meta.id, { profileIds: ["work"], restoreState: true });
  assert.deepEqual(result.profiles, ["work"]);
  assert.equal(result.restored.pages, 1);
  assert.equal(result.restored.widgets, 2);
  assert.deepEqual(live.config.pages.find((p) => p.id === "home-page"), untouched);
  assert.equal(live.config.pages.find((p) => p.id === "work-page").name, "Work");
  assert.equal(live.config.variables.enabled, false);
  assert.equal(live.state.variables.enabled, true);
  assert.equal(live.state.variables.count, 7);
  assert.equal(live.state.todos["home-todo"][0].text, "Keep my new home task");
});

test("selective create/export include only selected profile, image and required variable dependencies", (t) => {
  const { live, backups, dir } = setup(t);
  addImage(dir, live.config);
  const whole = backups.create(), selected = backups.export(whole.id, undefined, { profileIds: ["home"] });
  assert.equal(selected.config.profiles.length, 1);
  assert.equal(selected.config.pages[0].id, "home-page");
  assert.deepEqual(selected.config.variables, { enabled: true });
  assert.deepEqual(selected.assets, {});
  assert.equal(selected.preferences, null);
  assert.equal(selected.state.todos["work-todo"], undefined);
  const imported = backups.import(selected);
  assert.equal(imported.counts.pages, 1);
  assert.equal(imported.counts.variables, 1);
  const created = backups.create("portable", { profileIds: ["work"] });
  assert.equal(created.counts.profiles, 1);
  assert.equal(created.counts.assets, 1);
  assert.deepEqual(backups.export(created.id).config.variables, { count: 0 });
});

test("selective archives retain HTTP and variable dependencies while leaving unrelated integrations out", (t) => {
  const { live, backups } = setup(t);
  live.config.variables.remote = 0;
  live.config.variables.other = 1;
  live.config.integrations = [
    { id: "work-api", name: "API", type: "http", url: "https://example.com/status", variable: "remote" },
    { id: "other-api", name: "Other", type: "http", url: "https://example.com/other", variable: "other" },
  ];
  live.config.pages[0].widgets[0].actions = [{ type: "http", integrationId: "work-api" }];
  const archive = backups.export(backups.create("portable", { profileIds: ["work"] }).id);
  assert.deepEqual(archive.config.integrations.map((i) => i.id), ["work-api"]);
  assert.deepEqual(archive.config.variables, { count: 0, remote: 0 });
});

test("cross-profile references and identifier/type collisions are rejected before changing live data", (t) => {
  const { live, backups } = setup(t);
  live.config.pages[0].widgets.push({ id: "cross-link", type: "page", targetPage: "home-page", label: "Home", x: 2, y: 0, w: 1, h: 1 });
  assert.throws(() => backups.create("portable", { profileIds: ["work"] }), /연결 대상/);
  live.config.pages[0].widgets.pop();
  const meta = backups.create();
  live.config.pages[1].widgets[0].id = "work-button";
  live.config.pages[0].widgets[0].id = "new-work-button";
  assert.throws(() => backups.restore(meta.id, { profileIds: ["work"] }), /충돌/);
  assert.equal(live.writes, 0);
  live.config.pages[1].widgets[0].id = "home-button";
  live.config.variables.count = "wrong-type";
  live.config.pages[0].widgets[0].actions = [];
  assert.throws(() => backups.restore(meta.id, { profileIds: ["work"] }), /형식.*충돌/);
  assert.equal(live.writes, 0);
});

test("AES-GCM portable archive roundtrips and detects wrong passwords and tampering", (t) => {
  const { backups } = setup(t);
  const meta = backups.create(), password = "correct horse battery";
  assert.throws(() => backups.export(meta.id, "short"), /8자/);
  const encrypted = backups.export(meta.id, password);
  assert.equal(encrypted.kind, "open-deck-backup-encrypted");
  assert.equal(encrypted.config, undefined);
  assert.ok(!JSON.stringify(encrypted).includes("Finish report"));
  assert.equal(backups.import(encrypted, password).counts.pages, 2);
  assert.throws(() => backups.import(encrypted, "incorrect password"), /암호가 다르거나/);
  const tampered = structuredClone(encrypted), bytes = Buffer.from(tampered.data, "base64");
  bytes[4] ^= 1;
  tampered.data = bytes.toString("base64");
  assert.throws(() => backups.import(tampered, password), /손상/);
  assert.equal(backups.list().length, 2);
});

test("plain archive checksum and image-content hashes are verified before storing or restoring", (t) => {
  const { backups, dir, live } = setup(t);
  addImage(dir, live.config);
  const meta = backups.create(), archive = backups.export(meta.id);
  archive.config.pages[0].name = "Tampered";
  assert.throws(() => backups.import(archive), /체크섬/);
  const damaged = backups.export(meta.id);
  const id = Object.keys(damaged.assets)[0];
  damaged.assets[id] = damaged.assets[id].replace("iVBOR", "aVBOR");
  const { checksum, ...payload } = damaged;
  damaged.checksum = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  assert.throws(() => backups.import(damaged), /이미지/);
  assert.equal(backups.list().length, 1);
  assert.equal(live.writes, 0);
});

test("import accepts the prior v1/v2 JSON format, migrates, and never applies automatically", (t) => {
  const { backups, live } = setup(t);
  const legacy = { version: 1, name: "Legacy", columns: 4, pages: [{ id: "old", name: "Old", widgets: [{ id: "old-button", type: "button", label: "Old", actions: [] }] }], automations: [] };
  const imported = backups.import(JSON.stringify(legacy));
  const archive = backups.export(imported.id);
  assert.equal(archive.config.version, 2);
  assert.equal(archive.config.pages[0].widgets[0].x, 0);
  assert.equal(archive.config.pages[0].widgets[0].w, 1);
  assert.equal(archive.appVersion, "legacy");
  assert.equal(live.writes, 0);
  assert.throws(() => backups.restore(imported.id, { restoreState: true }), /상태가 없습니다/);
});

test("restore materializes hash-verified portable images in a fresh installation", (t) => {
  const source = setup(t), target = setup(t);
  const { id } = addImage(source.dir, source.live.config);
  const archive = source.backups.export(source.backups.create().id);
  const imported = target.backups.import(archive);
  assert.ok(!fs.existsSync(path.join(target.dir, "assets", id)));
  target.backups.restore(imported.id);
  const bytes = fs.readFileSync(path.join(target.dir, "assets", id));
  assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), id);
  assert.equal(fs.statSync(path.join(target.dir, "assets", id)).mode & 0o777, 0o600);
});

test("retention and interval scheduling survive restart without duplicate or replayed backups", (t) => {
  const { live, backups, options } = setup(t);
  live.settings.backups.retention = 2;
  const first = backups.tick(live.at);
  assert.ok(first);
  assert.equal(backups.tick(live.at + 1), null);
  const restarted = new Backups(options);
  assert.equal(restarted.tick(live.at + 3600000), null);
  assert.ok(restarted.tick(live.at + 24 * 3600000));
  assert.ok(restarted.tick(live.at + 30 * 24 * 3600000));
  assert.equal(restarted.list().length, 2);
  assert.ok(!restarted.list().some((row) => row.id === first.id));
  assert.equal(restarted.tick(live.at + 30 * 24 * 3600000 + 1), null);
  live.settings.backups.enabled = false;
  assert.equal(restarted.tick(live.at + 100 * 24 * 3600000), null);
  assert.equal(restarted.nextScheduledAt(), null);
});

test("daily, weekly and monthly schedules run only once per local calendar slot", (t) => {
  for (const schedule of ["daily", "weekly", "monthly"]) {
    const { backups, live, options } = setup(t);
    Object.assign(live.settings.backups, { schedule, time: "10:00", dayOfWeek: 4, dayOfMonth: 22 });
    const due = new Date(2026, 9, 22, 10, 0).getTime();
    assert.ok(backups.tick(due));
    assert.equal(new Backups(options).tick(due + 60000), null);
    const next = new Date(backups.nextScheduledAt(due));
    assert.equal(next.getHours(), 10);
    if (schedule === "daily") assert.equal(next.getDate(), 23);
    if (schedule === "weekly") assert.equal(next.getDate(), 29);
    if (schedule === "monthly") { assert.equal(next.getMonth(), 10); assert.equal(next.getDate(), 22); }
    assert.equal(backups.tick(next.getTime() - 1), null);
    assert.ok(backups.tick(next.getTime()));
  }
});

test("state apply failure rolls back the config and leaves a usable safety backup", (t) => {
  const { live, backups, options } = setup(t);
  const meta = backups.create();
  live.config.pages[0].name = "Must survive failed restore";
  const before = structuredClone(live.config), priorState = structuredClone(live.state);
  let failOnce = true;
  const guarded = new Backups({ ...options, applyState: (state) => { if (failOnce) { failOnce = false; throw Error("disk problem"); } live.state = structuredClone(state); } });
  assert.throws(() => guarded.restore(meta.id, { restoreState: true }), /되돌렸습니다/);
  assert.deepEqual(live.config, before);
  assert.deepEqual(live.state, priorState);
  assert.ok(guarded.list().some((row) => row.reason === "before-restore"));
});

test("an unreadable prior backup stays visible without preventing new safety backups", (t) => {
  const { dir, backups } = setup(t);
  const badId = crypto.randomUUID();
  fs.writeFileSync(path.join(dir, "backups", `${badId}.json`), "{bad json", { mode: 0o600 });
  const created = backups.create();
  assert.ok(backups.list().some((row) => row.id === badId && row.corrupt));
  assert.ok(backups.list().some((row) => row.id === created.id && !row.corrupt));
  assert.throws(() => backups.restore(badId));
  backups.remove(badId);
});

test("unsafe IDs, symlink files/directories and oversized inputs are rejected", (t) => {
  const { backups, dir } = setup(t);
  assert.throws(() => backups.preview("../runtime"), /식별자/);
  const id = crypto.randomUUID(), target = path.join(dir, "outside.json");
  fs.writeFileSync(target, "{}");
  fs.symlinkSync(target, path.join(dir, "backups", `${id}.json`));
  assert.throws(() => backups.preview(id));
  assert.throws(() => backups.remove(id), /안전한/);
  assert.ok(fs.existsSync(target));
  assert.throws(() => backups.import(" ".repeat(MAX_BACKUP_BYTES + 1)), /64MB/);
  fs.unlinkSync(path.join(dir, "backups", `${id}.json`));
  const fake = path.join(dir, "fake");
  fs.mkdirSync(fake);
  fs.symlinkSync(path.join(dir, "backups"), path.join(fake, "backups"));
  assert.throws(() => new Backups({ dir: fake, getConfig: baseConfig, applyConfig() {} }), /안전한/);
});
