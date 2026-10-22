import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig, validateConfig } from "../host/config.mjs";
import {
  clonePages,
  portableProfile,
  importProfile,
  profilePages,
} from "../host/public/profile-tools.mjs";

test("profile export contains only its pages and automations", () => {
  const c = defaultConfig();
  const other = {
    id: "other",
    name: "Other",
    columns: 4,
    rows: 1,
    theme: "midnight",
    gap: 12,
    radius: 13,
    widgets: [],
  };
  c.pages.push(other);
  c.profiles.push({
    id: "other-profile",
    name: "Other",
    pageIds: ["other"],
    defaultPageId: "other",
  });
  const exported = portableProfile(c, c.defaultProfileId);
  assert.deepEqual(
    exported.pages.map((p) => p.id),
    c.profiles[0].pageIds,
  );
  assert.equal(exported.profiles.length, 1);
  assert.equal(profilePages(c, "other-profile")[0].id, "other");
  assert.equal(c.pages.length, 2);
});
test("cloning folders remaps parent, navigation targets and widget identities", () => {
  let sequence = 0;
  const original = [
    {
      id: "a",
      name: "A",
      widgets: [{ id: "nav", type: "page", targetPage: "b" }],
    },
    {
      id: "b",
      parentId: "a",
      name: "B",
      widgets: [
        {
          id: "action",
          type: "button",
          actions: [{ type: "openUrl", value: "https://example.com" }],
        },
      ],
    },
  ];
  const cloned = clonePages(original, () => `copy-${++sequence}`);
  assert.notEqual(cloned[0].id, "a");
  assert.equal(cloned[1].parentId, cloned[0].id);
  assert.equal(cloned[0].widgets[0].targetPage, cloned[1].id);
  assert.notEqual(cloned[1].widgets[0].id, "action");
  assert.deepEqual(
    cloned[1].widgets[0].actions,
    original[1].widgets[0].actions,
  );
  assert.equal(original[1].parentId, "a");
});
test("portable profile import preserves actions and disables imported schedules", () => {
  const c = defaultConfig(),
    first = c.pages[0].widgets.find((w) => w.type === "button");
  c.automations = [
    { id: "schedule", enabled: true, time: "09:00", widgetId: first.id },
  ];
  const archive = portableProfile(c, c.defaultProfileId);
  const imported = importProfile(c, archive);
  assert.equal(c.profiles.length, 2);
  const copy = profilePages(c, imported.id)[0].widgets.find(
    (w) => w.type === "button",
  );
  assert.notEqual(copy.id, first.id);
  assert.deepEqual(copy.actions, first.actions);
  const automation = c.automations.find((a) => a.widgetId === copy.id);
  assert.equal(automation.enabled, false);
  validateConfig(c);
});
test("conflicting integration IDs reject before modifying the deck", () => {
  const c = defaultConfig();
  c.integrations = [
    {
      id: "service",
      type: "http",
      name: "Service",
      url: "https://example.com",
      method: "GET",
      intervalSeconds: 60,
    },
  ];
  const archive = portableProfile(c, c.defaultProfileId);
  archive.integrations[0].url = "https://different.example.com";
  const before = structuredClone(c);
  assert.throws(() => importProfile(c, archive), /충돌/);
  assert.deepEqual(c, before);
});
test("conflicting variable types and page capacity reject without data loss", () => {
  const c = defaultConfig();
  c.variables.enabled = true;
  const archive = portableProfile(c, c.defaultProfileId);
  archive.variables.enabled = "wrong";
  const before = structuredClone(c);
  assert.throws(() => importProfile(c, archive), /충돌/);
  assert.deepEqual(c, before);
  archive.variables.enabled = true;
  while (c.pages.length < 40)
    c.pages.push({
      ...structuredClone(c.pages[0]),
      id: `page-${c.pages.length}`,
    });
  const capacity = structuredClone(c);
  assert.throws(() => importProfile(c, archive), /최대/);
  assert.deepEqual(c, capacity);
});

test("portable profile preserves inherited design and disables automatic focus rules", () => {
  const c = defaultConfig();
  c.profiles[0].defaults = {
    theme: "paper",
    gap: 20,
    radius: 5,
    shadow: false,
  };
  c.profiles[0].focusApps = ["com.openai.chat"];
  c.pages[0].inheritProfileDesign = true;
  const archive = portableProfile(c, c.defaultProfileId);
  const imported = importProfile(c, archive);
  assert.deepEqual(imported.defaults, c.profiles[0].defaults);
  assert.deepEqual(imported.focusApps, []);
  assert.equal(profilePages(c, imported.id)[0].inheritProfileDesign, true);
  validateConfig(c);
});
