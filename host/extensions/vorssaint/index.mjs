import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
const exec = promisify(execFile);
const copy = JSON.parse(
  fs.readFileSync(new URL("./copy.json", import.meta.url), "utf8"),
);
export const catalog = JSON.parse(
  fs.readFileSync(new URL("./catalog.json", import.meta.url), "utf8"),
);
const catalogPath = fileURLToPath(new URL("./catalog.json", import.meta.url));
const app = "/Applications/Vorssaint.app";
const fields = new Map(
  catalog.features.flatMap((f) => f.fields.map((x) => [x.key, x])),
);
const error = (code, status = 400) =>
  Object.assign(Error(code), { code, status });
export function validatePatch(group, patch) {
  if (
    !catalog.groups.some((g) => g.id === group) ||
    !patch ||
    typeof patch !== "object" ||
    Array.isArray(patch) ||
    Object.keys(patch).length < 1 ||
    Object.keys(patch).length > fields.size
  )
    throw error("INVALID_PATCH");
  const allowed = new Set(
    catalog.features
      .filter((f) => f.group === group)
      .flatMap((f) => f.fields.map((x) => x.key)),
  );
  for (const [key, value] of Object.entries(patch)) {
    const f = fields.get(key);
    if (!allowed.has(key) || !f) throw error("INVALID_SETTING");
    const valid =
      f.kind === "boolean"
        ? typeof value === "boolean"
        : f.kind === "enum"
          ? typeof value === "string" && f.choices.includes(value)
          : Number.isInteger(value) &&
            value >= (f.min ?? -Infinity) &&
            value <= (f.max ?? Infinity) &&
            (!f.choices || f.choices.includes(value));
    if (!valid) throw error("INVALID_VALUE");
  }
  return patch;
}
export function createNative({
  helper = process.env.OPEN_DECK_VORSSAINT_HELPER ||
    fileURLToPath(new URL("../../../VorssaintPreferences", import.meta.url)),
} = {}) {
  return async (operation, input) => {
    if (operation === "start" || operation === "open-settings") {
      await exec("/usr/bin/open", operation === "start" ? ["-g", app] : [app], {
        timeout: 8000,
        maxBuffer: 65536,
      });
      return { ok: true };
    }
    return await new Promise((resolve, reject) => {
      const child = execFile(
        helper,
        [operation, catalogPath],
        { timeout: 9000, maxBuffer: 1048576 },
        (e, stdout) => {
          let value;
          try {
            value = JSON.parse(stdout);
          } catch {
            reject(error("PREFERENCES_UNAVAILABLE", 503));
            return;
          }
          if (e || !value.ok)
            reject(
              error(
                value.code || "PREFERENCES_UNAVAILABLE",
                value.code === "CONFLICT" ? 409 : 503,
              ),
            );
          else resolve(value);
        },
      );
      child.stdin.on("error", () => {});
      child.stdin.end(input ? JSON.stringify(input) : "");
    });
  };
}
export class Vorssaint {
  constructor({
    dir,
    getOptions = () => ({}),
    onChange = () => {},
    native = createNative(),
    clock = Date.now,
  } = {}) {
    Object.assign(this, { dir, getOptions, onChange, native, clock });
    this.data = null;
    this.error = "";
    this.updatedAt = 0;
    this.busy = false;
    this.reading = null;
    this.closed = false;
    this.lastPoll = 0;
    this.autoStartAttempted = false;
  }
  state() {
    const enabled = this.getOptions().enabled === true;
    return {
      id: "vorssaint",
      name: "Vorssaint",
      version: catalog.upstreamVersion,
      enabled,
      status: !enabled
        ? "disabled"
        : this.error
          ? "unavailable"
          : this.data?.installed
            ? this.data.running
              ? "connected"
              : "stopped"
            : "not-installed",
      appVersion: this.data?.version || "",
      updatedAt: this.updatedAt,
      applying: this.busy,
      error: this.error,
      summaryText: { ko: copy.ko.count, en: copy.en.count },
      groups: catalog.groups.map((g) => ({
        ...g,
        total: catalog.features.filter(
          (f) => f.group === g.id && f.id !== "general",
        ).length,
        available: catalog.features.filter(
          (f) =>
            f.group === g.id &&
            this.data?.values?.["featureAvailable." + f.id] === true,
        ).length,
      })),
    };
  }
  async read() {
    if (this.reading) return this.reading;
    this.reading = this.native("read")
      .then((v) => {
        this.data = v;
        this.updatedAt = this.clock();
        this.error = "";
        return v;
      })
      .catch((e) => {
        this.error = e.code || "PREFERENCES_UNAVAILABLE";
        throw e;
      })
      .finally(() => {
        this.reading = null;
      });
    return this.reading;
  }
  async poll() {
    if (
      this.closed ||
      this.getOptions().enabled !== true ||
      this.busy ||
      this.clock() - this.lastPoll < 5000
    )
      return;
    this.lastPoll = this.clock();
    const before = JSON.stringify(this.state());
    try {
      await this.read();
      if (!this.autoStartAttempted && this.data.installed) {
        this.autoStartAttempted = true;
        if (this.getOptions().autoStart !== false && !this.data.running)
          await this.native("start");
      }
    } catch {}
    if (!this.closed && JSON.stringify(this.state()) !== before)
      this.onChange();
  }
  async settings(group) {
    if (this.getOptions().enabled !== true) throw error("DISABLED", 403);
    if (!catalog.groups.some((g) => g.id === group))
      throw error("INVALID_GROUP");
    const data = await this.read();
    return {
      copy,
      app: {
        installed: data.installed,
        running: data.running,
        version: data.version,
        status: this.state().status,
      },
      revision: data.revision,
      group: catalog.groups.find((g) => g.id === group),
      features: catalog.features.filter((f) => f.group === group),
      values: Object.fromEntries(
        catalog.features
          .filter((f) => f.group === group)
          .flatMap((f) => f.fields.map((x) => [x.key, data.values[x.key]])),
      ),
      applyMode: "restart-app",
      catalogVersion: catalog.upstreamVersion,
    };
  }
  async update(group, revision, patch) {
    validatePatch(group, patch);
    if (this.getOptions().enabled !== true) throw error("DISABLED", 403);
    if (this.busy) throw error("BUSY", 409);
    this.busy = true;
    this.onChange();
    try {
      const before = await this.read();
      if (!before.installed) throw error("NOT_INSTALLED", 503);
      if (revision !== before.revision) throw error("CONFLICT", 409);
      const changed = Object.fromEntries(
        Object.entries(patch).filter(([k, v]) => v !== before.values[k]),
      );
      if (!Object.keys(changed).length)
        return { saved: true, restarted: false, revision: before.revision };
      const backup = {
        at: this.clock(),
        version: before.version,
        values: Object.fromEntries(
          Object.keys(changed).map((k) => [k, before.values[k]]),
        ),
      };
      const folder = path.join(this.dir, "vorssaint-settings-backups");
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
      const file = path.join(
        folder,
        this.clock() + "-" + crypto.randomUUID() + ".json",
      );
      fs.writeFileSync(file, JSON.stringify(backup), { mode: 0o600 });
      for (const old of fs
        .readdirSync(folder)
        .filter((n) => /^[0-9]+-[0-9a-f-]+\.json$/.test(n))
        .sort()
        .slice(0, -20))
        fs.unlinkSync(path.join(folder, old));
      // Quit first: the official app may flush its own defaults during termination.
      // Recheck the native revision after quit before making a narrowly scoped write.
      if (before.running) await this.native("quit");
      try {
        await this.native("write", { revision, patch: changed });
      } catch (e) {
        if (before.running) await this.native("start").catch(() => {});
        throw e;
      }
      let restarted = false,
        launchError = "";
      if (before.running || this.getOptions().autoStart !== false) {
        try {
          await this.native("start");
          restarted = true;
        } catch {
          launchError = "START_FAILED";
        }
      }
      await this.read();
      this.onChange();
      return {
        saved: true,
        restarted,
        launchError,
        revision: this.data.revision,
      };
    } finally {
      this.busy = false;
      this.onChange();
    }
  }
  async invoke(operation) {
    if (this.getOptions().enabled !== true) throw error("DISABLED", 403);
    if (operation === "open-settings" || operation === "start") {
      await this.native(operation);
      await this.read();
      this.onChange();
      return;
    }
    if (operation === "awake-30" || operation === "awake-off") {
      const r = await this.read();
      const patch =
        operation === "awake-30"
          ? {
              "featureAvailable.keepAwake": true,
              keepAwakeAutoStart: true,
              defaultDurationMinutes: 30,
            }
          : { "featureAvailable.keepAwake": false };
      return this.update("energyDisplay", r.revision, patch);
    }
    throw error("INVALID_OPERATION");
  }
  close() {
    this.closed = true;
  }
}
export function vorssaintPage() {
  return {
    id: "vorssaint-page",
    name: "Mac 도구",
    columns: 12,
    rows: 8,
    theme: "graphite",
    background: "#101720",
    gap: 12,
    radius: 16,
    widgets: [
      {
        id: "vorssaint-title",
        type: "text",
        label: "Vorssaint · Mac 도구",
        text: "Vorssaint · Mac 도구",
        provider: "vorssaint",
        x: 0,
        y: 0,
        w: 12,
        h: 1,
        color: "#b6c8dc",
        style: {
          background: "#101720",
          textSize: 24,
          presentation: "utility-header",
        },
      },
      ...[
        ["awake-30", "30분 깨어 있기", "power"],
        ["awake-off", "잠자기 방지 중지", "moon"],
        ["open-settings", "Mac에서 상세 설정", "settings"],
      ].map(([op, label, icon], i) => ({
        id: "vorssaint-" + op,
        type: "button",
        label,
        icon,
        provider: "vorssaint",
        x: i * 4,
        y: 1,
        w: 4,
        h: 1,
        color: "#9cb9d7",
        style: {
          background: "#1b2b3b",
          textSize: 15,
          iconSize: 20,
          labelPosition: "center",
          presentation: "os-action",
          emphasis: "primary",
        },
        actions: [
          { type: "extension", extensionId: "vorssaint", operation: op },
        ],
      })),
      ...catalog.groups.map((g, i) => ({
        id: "vorssaint-group-" + g.id,
        type: "button",
        label: g.label.ko,
        icon: g.icon,
        provider: "vorssaint",
        utilityGroup: g.id,
        x: (i % 3) * 4,
        y: 2 + Math.floor(i / 3) * 2,
        w: 4,
        h: 2,
        color: "#8daac8",
        style: { presentation: "utility", background: "#1a2531", textSize: 18 },
        actions: [],
      })),
    ],
  };
}
