import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DeviceDrafts, deviceDefaults } from "../host/public/device-drafts.mjs";

const device = (id = "tablet", settingsRevision = 1, settings = {}) => ({
  id,
  name: id,
  settingsRevision,
  settings,
});

test("tablet updates merge around local edits and only changed fields are submitted", () => {
  const drafts = new DeviceDrafts();
  drafts.ingest([
    device("a", 1, { theme: "dark", textScale: 100, sound: false }),
  ]);
  drafts.set("a", "textScale", 125);
  drafts.ingest([
    device("a", 2, { theme: "light", textScale: 100, sound: true }),
  ]);
  assert.deepEqual(drafts.view("a").settings, {
    theme: "light",
    textScale: 125,
    sound: true,
  });
  assert.deepEqual(drafts.patch("a"), {
    id: "a",
    settings: { textScale: 125 },
  });
  // Recreating the panel from its model preserves all edited values.
  assert.equal(drafts.list()[0].settings.textScale, 125);
});

test("acknowledging one device preserves other drafts and edits made during save", () => {
  const drafts = new DeviceDrafts();
  drafts.ingest([device("a"), device("b")]);
  drafts.set("a", "name", "Renamed");
  drafts.set("a", "textScale", 120);
  drafts.set("b", "sound", true);
  const sent = drafts.patch("a");
  drafts.set("a", "textScale", 130);
  drafts.acknowledge(sent, {
    ...device("a", 2, { textScale: 120 }),
    name: "Renamed",
  });
  assert.deepEqual(drafts.patch("a"), {
    id: "a",
    settings: { textScale: 130 },
  });
  assert.deepEqual(drafts.patch("b"), { id: "b", settings: { sound: true } });
  assert.equal(drafts.dirty, true);
});

test("late HTTP responses cannot roll back newer tablet settings received by SSE", () => {
  const drafts = new DeviceDrafts();
  drafts.ingest([device("a", 1, { theme: "dark" })]);
  drafts.set("a", "sound", true);
  const sent = drafts.patch("a");
  drafts.ingest([device("a", 3, { theme: "light", sound: true })]);
  drafts.acknowledge(sent, device("a", 2, { theme: "dark", sound: true }));
  assert.equal(drafts.view("a").settings.theme, "light");
  assert.equal(drafts.dirty, false);
});

test("discarding edits retains the newest server state and removing a device drops its patch", () => {
  const drafts = new DeviceDrafts();
  drafts.ingest([device("a", 1, { sound: false }), device("b")]);
  drafts.set("a", "sound", true);
  drafts.ingest([
    device("a", 2, { sound: false, textScale: 140 }),
    device("b"),
  ]);
  drafts.discard();
  assert.equal(drafts.view("a").settings.sound, false);
  assert.equal(drafts.view("a").settings.textScale, 140);
  drafts.set("b", "name", "Changed");
  drafts.ingest([device("a", 2, {})], { replace: true });
  assert.equal(drafts.view("b"), null);
  assert.equal(drafts.dirty, false);
});

test("an A-to-B-to-A edit survives an older acknowledgement with the same value", () => {
  const drafts = new DeviceDrafts();
  drafts.ingest([device("a", 1, { textScale: 100 })]);
  drafts.set("a", "textScale", 120);
  const sent = drafts.patch("a");
  drafts.set("a", "textScale", 140);
  drafts.set("a", "textScale", 120);
  drafts.ingest([device("a", 3, { textScale: 90 })]);
  drafts.acknowledge(sent, device("a", 2, { textScale: 120 }));
  assert.equal(drafts.view("a").settings.textScale, 120);
  assert.deepEqual(drafts.patch("a").settings, { textScale: 120 });
});

test("returning to the original value during a save remains a pending edit", () => {
  const drafts = new DeviceDrafts();
  drafts.ingest([device("a", 1, { textScale: 100 })]);
  drafts.set("a", "textScale", 120);
  drafts.set("a", "name", "First rename");
  const sent = drafts.patch("a");
  drafts.set("a", "textScale", 100);
  drafts.set("a", "name", "a");
  drafts.acknowledge(sent, {
    ...device("a", 2, { textScale: 120 }),
    name: "First rename",
  });
  assert.equal(drafts.view("a").settings.textScale, 100);
  assert.equal(drafts.view("a").name, "a");
  assert.deepEqual(drafts.patch("a"), {
    id: "a",
    name: "a",
    settings: { textScale: 100 },
  });
});

test("Mac device controls use the same defaults as the Android settings policy", () => {
  const java = fs.readFileSync(
    new URL(
      "../android/app/src/main/java/app/opendeck/client/ClientSettingsPolicy.java",
      import.meta.url,
    ),
    "utf8",
  );
  const android = Object.fromEntries(
    [...java.matchAll(/v\.put\("([^"]+)", (true|false|-?\d+|"[^"]*")\);/g)].map(
      ([, key, value]) => [key, JSON.parse(value)],
    ),
  );
  assert.deepEqual(deviceDefaults, android);
});
