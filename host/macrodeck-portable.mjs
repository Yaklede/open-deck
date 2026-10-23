// Source format: Macro Deck v3.0.0-beta.18 PortableArchive and profile JSON.
// Foreign actions are converted as data only. Import never executes an action.
import { createHash, randomUUID } from "node:crypto";
import { validateConfig } from "./config.mjs";
import { place } from "./public/layout.mjs";
import { readZip, writeZip, safeArchivePath } from "./safe-zip.mjs";
import {
  portableEncryption,
  encryptPortable,
  decryptPortable,
  decryptBackup,
} from "./macrodeck-crypto.mjs";
const digest = (b) => createHash("sha256").update(b).digest("hex");
const json = (b) => {
  if (b.length > 64 * 1024 * 1024) throw Error("JSON content is too large.");
  return JSON.parse(b.toString("utf8"));
};
const dataOf = (w) =>
  typeof w.data === "string" ? json(Buffer.from(w.data)) : w.data || {};
const list = (v) => (Array.isArray(v) ? v : []);
const integer = (v, min, max, fallback) =>
  Number.isInteger(v) && v >= min && v <= max ? v : fallback;
const color = (v) =>
  typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v : undefined;
const text = (v, max = 120) => String(v ?? "").slice(0, max);
const warn = (report, code, location, detail) => {
  if (report.length >= 4096)
    throw Error("Archive has too many unsupported items.");
  report.push({ code, location, detail });
};
function verifyFiles(entries, declarations, { complete = false } = {}) {
  const seen = new Set();
  for (const file of list(declarations)) {
    const name = safeArchivePath(file.path),
      entry = entries.get(name);
    if (
      seen.has(name) ||
      !entry ||
      entry.directory ||
      file.size !== entry.bytes.length ||
      String(file.sha256)
        .replace(/^sha256:/, "")
        .toLowerCase() !== digest(entry.bytes)
    )
      throw Error("Archive file integrity verification failed.");
    seen.add(name);
  }
  if (complete)
    for (const [name, e] of entries)
      if (
        !e.directory &&
        !["manifest.json", "content.json"].includes(name) &&
        !seen.has(name)
      )
        throw Error("Archive contains undeclared files.");
}
function asset(bytes, assets, report, location) {
  const mime = bytes
    .subarray(0, 8)
    .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? "image/png"
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      ? "image/jpeg"
      : bytes.toString("ascii", 0, 4) === "RIFF" &&
          bytes.toString("ascii", 8, 12) === "WEBP"
        ? "image/webp"
        : null;
  if (!mime || bytes.length > 2097152) {
    warn(
      report,
      "asset-unsupported",
      location,
      "Only PNG, JPEG or WebP images up to 2 MiB can be imported.",
    );
    return undefined;
  }
  const id = digest(bytes);
  assets[id] = `data:${mime};base64,${bytes.toString("base64")}`;
  return id;
}
function variableValue(v) {
  if (v.type === "Numeric" || v.type === 1) {
    const n = Number(v.value);
    if (Number.isFinite(n)) return n;
  }
  if (v.type === "Boolean" || v.type === 2)
    return String(v.value).toLowerCase() === "true";
  return text(v.value, 2048);
}
function flowActions(blocks, ctx, location, depth = 0) {
  if (depth > 4 || list(blocks).length > 32) {
    warn(
      ctx.report,
      "action-limit",
      location,
      "Action nesting or count exceeds Open Deck limits.",
    );
    return [];
  }
  const result = [];
  for (const b of list(blocks)) {
    if (b.disabled) continue;
    const p = Object.fromEntries(
      list(b.parameters).map((v) => [v.name, v.value]),
    );
    let action;
    if (b.type === "delay") {
      action = {
        type: "wait",
        value: Math.max(0, Math.min(10000, Number(p.duration) || 0)),
      };
      if (Number(p.duration) > 10000)
        warn(
          ctx.report,
          "delay-adjusted",
          location,
          "Delays longer than 10 seconds were reduced to the routine limit.",
        );
    } else if (
      b.type === "action" &&
      b.integrationId === "app.macro-deck.system"
    ) {
      if (
        b.actionId === "open-website" &&
        typeof p.url === "string" &&
        /^https?:\/\//i.test(p.url)
      )
        action = { type: "openUrl", value: p.url };
      else if (
        b.actionId === "launch-application" &&
        typeof p.path === "string" &&
        p.path.endsWith(".app") &&
        !p.arguments &&
        !p.workingDirectory &&
        !p.runAsAdmin &&
        (!p.mode || p.mode === "start" || p.mode === "start-focus")
      )
        action = { type: "openApp", value: p.path };
      else if (
        b.actionId === "run-command" &&
        typeof p.command === "string" &&
        !p.workingDirectory &&
        !p.outputVariable &&
        !p.showWindow &&
        (!p.shell || ["default", "bash"].includes(p.shell))
      )
        action = { type: "command", value: p.command };
    } else if (
      b.type === "action" &&
      b.integrationId === "app.macro-deck.variables" &&
      b.actionId === "set-variable"
    ) {
      const variable =
        ctx.variableMap.get(`${ctx.widgetId}:${p.variable}`) ||
        ctx.variableMap.get(`:${p.variable}`);
      if (variable) {
        const val = ctx.variables[variable];
        if (!p.operation || p.operation === "set")
          action = {
            type: "setVariable",
            variable,
            value:
              typeof val === "number"
                ? Number(p.value)
                : typeof val === "boolean"
                  ? String(p.value).toLowerCase() === "true"
                  : String(p.value ?? ""),
          };
        else if (p.operation === "add" && typeof val === "number")
          action = { type: "increment", variable, value: Number(p.value) || 0 };
        else if (p.operation === "toggle" && typeof val === "boolean")
          action = { type: "toggleVariable", variable };
      }
    } else if (
      b.type === "action" &&
      b.integrationId === "app.macro-deck.deck" &&
      b.actionId === "change-folder" &&
      ctx.pageMap.has(p.folderId)
    )
      action = { type: "_page", targetPage: ctx.pageMap.get(p.folderId) };
    if (
      action?.type === "setVariable" &&
      typeof action.value === "number" &&
      !Number.isFinite(action.value)
    )
      action = null;
    if (action) result.push(action);
    else
      warn(
        ctx.report,
        "action-not-imported",
        location,
        `Unsupported action ${text(b.integrationId || b.type, 100)} / ${text(b.actionId || b.blockType, 100)} was disabled.`,
      );
  }
  return result;
}
function convertWidget(source, ctx, location) {
  const d = dataOf(source),
    sourceId = source.id || source.sourceId || randomUUID();
  ctx = { ...ctx, widgetId: sourceId };
  const names = {
      1: "ActionButton",
      2: "MusicPlayer",
      3: "Slider",
      4: "Weather",
      5: "HistoryGraph",
      6: "Clock",
    },
    kind = names[source.type] || source.type;
  const label = text(d.label || d.title || kind || "Widget").replace(
    /{{\s*vars\.([a-zA-Z][a-zA-Z0-9_]*)\s*}}/g,
    (whole, name) => {
      const mapped =
        ctx.variableMap.get(`${sourceId}:${name}`) ||
        ctx.variableMap.get(`:${name}`);
      return mapped ? `{{${mapped}}}` : whole;
    },
  );
  const w = {
    id: randomUUID(),
    type: "button",
    label,
    x: integer(source.positionX, 0, 11, 0),
    y: integer(source.positionY, 0, 63, 0),
    w: integer(source.width, 1, 12, 1),
    h: integer(source.height, 1, 12, 1),
    style: {},
    actions: [],
  };
  if (source.isPinned)
    w.pinScope =
      String(source.pinScope).toLowerCase() === "global" ? "global" : "profile";
  if (color(d.backgroundColor)) w.style.background = d.backgroundColor;
  if (color(d.labelColor || d.textColor))
    w.style.textColor = d.labelColor || d.textColor;
  if (["left", "center", "right"].includes(d.textAlign))
    w.style.align = d.textAlign;
  if (["top", "center", "bottom"].includes(d.labelPosition))
    w.style.labelPosition = d.labelPosition;
  if (d.fontSize) w.style.textSize = integer(Math.round(d.fontSize), 9, 36, 14);
  if (d.border?.style && d.border.style !== "none") {
    w.style.borderWidth = 1;
    if (color(d.border.color)) w.style.borderColor = d.border.color;
  }
  if (d.fontFaceId)
    warn(
      ctx.report,
      "font-substitution",
      location,
      "Custom font replaced by the system font.",
    );
  const iconId = d.icon?.reference || d.iconId;
  if (iconId) {
    const entry =
      [...ctx.entries].find(([name]) =>
        name.endsWith(`/${iconId}/master.webp`),
      ) ||
      [...ctx.entries].find(([name]) =>
        new RegExp(
          `/${String(iconId).replace(/[^a-zA-Z0-9-]/g, "")}/[0-9]+\\.webp$`,
        ).test(name),
      );
    if (entry)
      w.image = asset(entry[1].bytes, ctx.assets, ctx.report, location);
    else
      warn(
        ctx.report,
        "icon-unavailable",
        location,
        "The referenced icon is not included in this archive.",
      );
  }
  if (
    !w.image &&
    typeof d.imageUrl === "string" &&
    /^data:image\/(png|jpeg|webp);base64,/.test(d.imageUrl)
  )
    w.image = asset(
      Buffer.from(d.imageUrl.split(",")[1], "base64"),
      ctx.assets,
      ctx.report,
      location,
    );
  const variable =
    ctx.variableMap.get(`${sourceId}:${d.valueVariable}`) ||
    ctx.variableMap.get(`:${d.valueVariable}`);
  if (kind === "ActionButton") {
    const flows =
      typeof d.flows === "string" ? json(Buffer.from(d.flows)) : list(d.flows);
    for (const f of flows) {
      const target = {
        onShortPress: "actions",
        onLongPress: "longActions",
        onDoublePress: "doubleActions",
      }[f.triggerType];
      if (!target) {
        warn(
          ctx.report,
          "trigger-not-imported",
          location,
          `Trigger ${text(f.triggerType)} is unsupported.`,
        );
        continue;
      }
      w[target] = flowActions(f.children, ctx, location);
    }
    if (
      w.actions.length === 1 &&
      w.actions[0].type === "_page" &&
      !w.longActions?.length &&
      !w.doubleActions?.length
    ) {
      w.type = "page";
      w.targetPage = w.actions[0].targetPage;
      w.actions = [];
    }
    for (const k of ["actions", "longActions", "doubleActions"])
      w[k] = list(w[k]).filter((a) => {
        if (a.type !== "_page") return true;
        warn(
          ctx.report,
          "navigation-not-imported",
          location,
          "Folder navigation combined with other actions needs manual review.",
        );
        return false;
      });
    if (list(d.states).length > 1 || (d.stateMode && d.stateMode !== "single"))
      warn(
        ctx.report,
        "states-not-imported",
        location,
        "Multi-state button behavior needs manual review; the base appearance was imported.",
      );
  } else if (kind === "Clock") {
    w.type = "clock";
    if (d.timeZone || d.style === "analog")
      warn(
        ctx.report,
        "clock-options",
        location,
        "Clock uses this device’s local digital display.",
      );
  } else if (kind === "Countdown") {
    w.type = "timer";
    w.minutes = Math.max(
      1,
      Math.min(
        1440,
        (Number(d.durationHours) || 0) * 60 +
          (Number(d.durationMinutes) || 0) +
          (Number(d.durationSeconds) || 0) / 60,
      ),
    );
    if (d.mode === "ask")
      warn(
        ctx.report,
        "timer-options",
        location,
        "Interactive duration mode uses the imported fixed duration.",
      );
  } else if (
    kind === "Slider" &&
    variable &&
    typeof ctx.variables[variable] === "number"
  ) {
    w.type = "slider";
    w.binding = variable;
    w.min = Number.isFinite(Number(d.min)) ? Number(d.min) : 0;
    w.max = Number.isFinite(Number(d.max)) ? Number(d.max) : 100;
    w.step =
      Number.isFinite(Number(d.step)) && Number(d.step) > 0
        ? Number(d.step)
        : 1;
  } else if (kind === "HistoryGraph" && variable) {
    w.type = "graph";
    w.binding = variable;
    w.unit = text(d.unit, 20);
  } else if (kind === "Gauges") {
    w.type = "gauges";
    warn(
      ctx.report,
      "gauges-local",
      location,
      "The imported gauge shows Mac CPU and memory, not plugin variables.",
    );
  } else {
    w.type = "text";
    w.text = `${kind}: configuration required`;
    warn(
      ctx.report,
      "widget-not-supported",
      location,
      `Widget ${text(kind)} is preserved as an inert text placeholder.`,
    );
  }
  if (
    d.iconDisplay &&
    ((d.iconDisplay.zoom !== undefined && d.iconDisplay.zoom !== 100) ||
      d.iconDisplay.offsetX ||
      d.iconDisplay.offsetY)
  )
    warn(
      ctx.report,
      "icon-transform",
      location,
      "Icon crop/offset uses the Open Deck fit setting.",
    );
  return w;
}
function convertContent(content, entries, report) {
  const assets = {},
    variables = {},
    variableMap = new Map(),
    pageMap = new Map();
  const nativeProfiles = list(content.profiles).length
    ? content.profiles
    : content.profile
      ? [content.profile]
      : [
          {
            id: randomUUID(),
            name: content.name || "Imported Macro Deck",
            defaultColumns: 4,
            defaultRows: 4,
            folders: content.folders || [
              {
                id: randomUUID(),
                name: "Imported widgets",
                widgets: content.widgets || [],
              },
            ],
          },
        ];
  for (const v of list(content.variables)) {
    if (v.template) {
      warn(
        report,
        "variable-template",
        "variables",
        "Template variables need manual configuration.",
      );
      continue;
    }
    let name = String(v.name || "value").replace(/[^a-zA-Z0-9_]/g, "_");
    if (!/^[a-zA-Z]/.test(name)) name = "v_" + name;
    name = name.slice(0, 52);
    const base = name;
    let n = 1;
    while (Object.hasOwn(variables, name)) name = `${base}_${++n}`;
    if (Object.keys(variables).length >= 128)
      throw Error("The archive contains more than 128 variables.");
    variables[name] = variableValue(v);
    variableMap.set(`${v.widgetId || ""}:${v.name}`, name);
  }
  for (const p of nativeProfiles)
    for (const f of list(p.folders)) {
      if (pageMap.has(f.id)) throw Error("Duplicate source folder IDs.");
      pageMap.set(f.id, randomUUID());
    }
  const config = {
    version: 2,
    name: "Imported Macro Deck",
    columns: 4,
    pages: [],
    profiles: [],
    variables,
    integrations: [],
    automations: [],
  };
  for (const source of nativeProfiles) {
    const profile = {
      id: randomUUID(),
      name: text(source.name || "Imported profile", 80),
      pageIds: [],
      focusApps: [],
    };
    for (const folder of [...list(source.folders)].sort(
      (a, b) => (a.order || 0) - (b.order || 0),
    )) {
      const location = `${profile.name} / ${text(folder.name, 80)}`,
        columns = integer(folder.columns ?? source.defaultColumns, 2, 12, 4),
        page = {
          id: pageMap.get(folder.id),
          name: text(folder.name || "Page", 80),
          columns,
          rows: integer(folder.rows ?? source.defaultRows, 1, 64, 4),
          gap: integer(
            folder.widgetSpacing ?? source.defaultWidgetSpacing,
            0,
            32,
            12,
          ),
          radius: integer(
            folder.widgetBorderRadius ?? source.defaultWidgetBorderRadius,
            0,
            40,
            13,
          ),
          theme: "midnight",
          widgets: [],
          inheritProfileDesign: false,
        };
      if (
        (folder.columns ?? source.defaultColumns ?? 4) !== page.columns ||
        (folder.rows ?? source.defaultRows ?? 4) !== page.rows
      )
        warn(
          report,
          "layout-limits",
          location,
          "Grid dimensions were adapted to Open Deck limits (2–12 columns, 1–64 rows).",
        );
      if (folder.parentId) {
        if (!pageMap.has(folder.parentId)) {
          warn(
            report,
            "parent-unavailable",
            location,
            "Parent folder is outside this archive.",
          );
        } else page.parentId = pageMap.get(folder.parentId);
      }
      if (color(folder.backgroundColor || source.defaultBackgroundColor))
        page.background =
          folder.backgroundColor || source.defaultBackgroundColor;
      page.showEmptyCells =
        (folder.emptyCellStyle ?? source.defaultEmptyCellStyle) !== "none";
      if (typeof source.defaultWidgetShadows === "boolean")
        page.shadow = source.defaultWidgetShadows;
      if (folder.viewId)
        warn(
          report,
          "folder-view",
          location,
          "Custom folder view replaced by the widget grid.",
        );
      if (list(folder.focusRules).length)
        warn(
          report,
          "focus-rule",
          location,
          "Automatic focus rules are not activated by import.",
        );
      const ctx = { entries, assets, report, variables, variableMap, pageMap };
      page.widgets = list(folder.widgets).map((w, i) =>
        convertWidget(w, ctx, `${location} / ${i + 1}`),
      );
      const old = JSON.stringify(page.widgets.map((w) => [w.x, w.y, w.w, w.h]));
      page.rows = place(page.widgets, columns, page.rows, true);
      if (old !== JSON.stringify(page.widgets.map((w) => [w.x, w.y, w.w, w.h])))
        warn(
          report,
          "layout-adjusted",
          location,
          "Overlapping/out-of-range widgets were moved to free cells.",
        );
      profile.pageIds.push(page.id);
      if (folder.isDefault) profile.defaultPageId = page.id;
      config.pages.push(page);
    }
    if (profile.pageIds.length) {
      profile.defaultPageId ??= profile.pageIds[0];
      config.profiles.push(profile);
    }
  }
  if (!config.pages.length)
    throw Error("No importable profiles or widgets were found.");
  config.defaultProfileId = config.profiles[0].id;
  for (const kind of ["scripts", "secrets", "fonts"])
    if (list(content[kind]).length)
      warn(
        report,
        `${kind}-excluded`,
        kind,
        `${content[kind].length} ${kind} entries were excluded from this import.`,
      );
  return { config: validateConfig(config), assets, report };
}
export async function importMacroDeck(input, { password, recoveryKey } = {}) {
  const bytes = Buffer.from(input);
  if (bytes.length > 192 * 1024 * 1024) throw Error("Archive is too large.");
  let entries, manifest, content;
  const report = [];
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    entries = readZip(bytes);
    const manifestBytes = entries.get("manifest.json")?.bytes;
    if (manifestBytes) {
      if (manifestBytes.length > 65536)
        throw Error("Archive manifest is too large.");
      manifest = json(manifestBytes);
      if (manifest.encryption?.cipher === "AES-256-GCM-STREAM") {
        if (manifest.formatVersion !== 1)
          throw Error("Unsupported Macro Deck backup version.");
        const encrypted = entries.get("payload.enc")?.bytes;
        if (!encrypted) throw Error("Backup payload is missing.");
        entries = readZip(
          decryptBackup(encrypted, recoveryKey, manifestBytes, manifest),
        );
        const index = json(
          entries.get("content.json")?.bytes || Buffer.from("{}"),
        );
        verifyFiles(
          entries,
          [...list(index.entries), ...(index.database ? [index.database] : [])],
          { complete: true },
        );
        if (
          entries.get("manifest.json") &&
          !entries.get("manifest.json").bytes.equals(manifestBytes)
        )
          throw Error("Backup manifests do not match.");
        const profiles = [...entries]
          .filter(([name]) =>
            /^files\/data\/profiles\/[^/]+\.json$/i.test(name),
          )
          .map(([, e]) => json(e.bytes));
        const storedVariables = entries.get("files/data/user-variables.json");
        const variables = storedVariables
          ? list(json(storedVariables.bytes))
              .filter(
                (v) =>
                  !v.ownerIntegrationId && !v.fileSource && !v.templateSource,
              )
              .map((v) => ({ ...v, widgetId: v.scopeRefId || "" }))
          : [];
        content = { profiles, variables };
        warn(
          report,
          "backup-scope",
          "backup",
          "Only profile/layout/image data is migrated. Accounts, credentials, plugin binaries, host preferences and database contents are excluded.",
        );
      } else {
        if (
          ![1, 2].includes(manifest.formatVersion) ||
          !["Profile", "Folder", "Widgets"].includes(manifest.kind)
        )
          throw Error("Unsupported Macro Deck portable format.");
        if (manifest.encryption) {
          const payload = entries.get("payload.enc")?.bytes;
          if (!payload) throw Error("Encrypted payload is missing.");
          entries = readZip(
            await decryptPortable(
              payload,
              password,
              manifestBytes,
              manifest.encryption,
            ),
          );
        } else if (manifest.files)
          verifyFiles(entries, manifest.files, { complete: true });
        content = json(entries.get("content.json")?.bytes || Buffer.from("{}"));
        if (content.kind !== manifest.kind)
          throw Error("Archive kind does not match its content.");
      }
    } else {
      content = legacyZip(entries, report);
      manifest = { kind: "Legacy", formatVersion: 2 };
    }
  } else {
    content = legacyJson(json(bytes), report);
    entries = new Map();
    manifest = { kind: "Legacy", formatVersion: 2 };
  }
  const result = convertContent(content, entries, report);
  return {
    ...result,
    source: {
      application: "Macro Deck",
      kind: manifest.kind || "Backup",
      formatVersion: manifest.formatVersion,
      encrypted: !!manifest.encryption,
    },
    summary: {
      profiles: result.config.profiles.length,
      pages: result.config.pages.length,
      widgets: result.config.pages.reduce((n, p) => n + p.widgets.length, 0),
      assets: Object.keys(result.assets).length,
      warnings: report.length,
    },
  };
}
function legacyJson(value, report) {
  const lower = (v) =>
    Object.fromEntries(
      Object.entries(v || {}).map(([k, x]) => [k.toLowerCase(), x]),
    );
  const p = lower(value);
  if (p.id && p.folders && !p.profileid) return { profile: value };
  if (!p.profileid || !Array.isArray(p.folders))
    throw Error(
      "Select a Macro Deck portable archive, backup, or profile JSON.",
    );
  const folders = p.folders.map((raw) => {
    const f = lower(raw);
    return {
      id: f.folderid,
      name: f.displayname === "*Root*" ? "Home" : f.displayname,
      isDefault: f.displayname === "*Root*",
      widgets: list(f.actionbuttons).map((rawButton) => {
        const b = lower(rawButton),
          l = lower(b.labeloff);
        if (list(b.actions).length || list(b.actionslongpress).length)
          warn(
            report,
            "legacy-actions",
            text(l.labeltext),
            "Macro Deck 2 action configurations need manual review and were not executed.",
          );
        return {
          id: b.guid,
          type: "ActionButton",
          positionX: Number(b.position_x) || 0,
          positionY: Number(b.position_y) || 0,
          width: 1,
          height: 1,
          data: JSON.stringify({
            label: l.labeltext,
            backgroundColor: b.backcoloroff,
            labelColor: l.labelcolor,
            labelPosition:
              ["top", "center", "bottom"][l.labelposition] || "bottom",
          }),
        };
      }),
    };
  });
  for (let i = 0; i < p.folders.length; i++)
    for (const child of list(lower(p.folders[i]).childs)) {
      const f = folders.find((x) => x.id === child);
      if (f) f.parentId = folders[i].id;
    }
  warn(
    report,
    "legacy-scope",
    "Macro Deck 2",
    "Profiles, folders, positions and labels are migrated. Plugin actions, icon packs and database variables need manual setup.",
  );
  return {
    profile: {
      id: p.profileid,
      name: p.displayname,
      defaultRows: Number(p.rows) || 4,
      defaultColumns: Number(p.columns) || 4,
      defaultWidgetSpacing: Number(p.buttonspacing) || 0,
      defaultWidgetBorderRadius: Number(p.buttonradius) || 0,
      folders,
    },
  };
}
function legacyZip(entries, report) {
  const profiles = [];
  for (const [name, e] of entries)
    if (/(^|\/)profiles\/[^/]+\.json$/i.test(name)) {
      const result = legacyJson(json(e.bytes), report);
      profiles.push(...(result.profiles || [result.profile]));
    }
  if (!profiles.length)
    throw Error(
      "This backup has no supported profile JSON. Export profiles from Macro Deck first.",
    );
  return { profiles };
}
const parameter = (name, value) => ({
  name,
  type: typeof value === "number" ? "number" : "string",
  value,
});
function exportAction(a, report, location) {
  let integrationId,
    actionId,
    parameters = [];
  if (a.type === "wait")
    return {
      id: randomUUID(),
      type: "delay",
      parameters: [parameter("duration", Number(a.value) || 0)],
      children: [],
    };
  if (a.type === "openUrl") {
    integrationId = "app.macro-deck.system";
    actionId = "open-website";
    parameters = [parameter("url", a.value)];
  } else if (a.type === "openApp") {
    integrationId = "app.macro-deck.system";
    actionId = "launch-application";
    parameters = [parameter("path", a.value), parameter("mode", "start-focus")];
  } else if (a.type === "command") {
    integrationId = "app.macro-deck.system";
    actionId = "run-command";
    parameters = [parameter("command", a.value), parameter("shell", "bash")];
  } else if (["setVariable", "increment", "toggleVariable"].includes(a.type)) {
    integrationId = "app.macro-deck.variables";
    actionId = "set-variable";
    parameters = [
      parameter("variable", a.variable),
      parameter(
        "operation",
        a.type === "setVariable"
          ? "set"
          : a.type === "increment"
            ? "add"
            : "toggle",
      ),
      parameter("value", a.value ?? ""),
    ];
  } else {
    warn(
      report,
      "action-not-exported",
      location,
      `Open Deck action ${a.type} is not supported by Macro Deck portable export.`,
    );
    return null;
  }
  return {
    id: randomUUID(),
    type: "action",
    integrationId,
    actionId,
    parameters,
    children: [],
  };
}
export async function exportMacroDeck(
  raw,
  {
    kind = "Profile",
    profileId,
    pageId,
    widgetIds,
    assets = {},
    password,
  } = {},
) {
  const config = validateConfig(raw),
    report = [],
    source = config.profiles.find(
      (p) => p.id === (profileId || config.defaultProfileId),
    );
  if (!source || !["Profile", "Folder", "Widgets"].includes(kind))
    throw Error("Choose a valid profile and export kind.");
  const chosen =
    kind === "Profile"
      ? config.pages.filter((p) => source.pageIds.includes(p.id))
      : config.pages.filter((p) => p.id === (pageId || source.defaultPageId));
  if (!chosen.length) throw Error("No selected pages.");
  const ids = new Map(chosen.map((p) => [p.id, randomUUID()])),
    variables = [],
    folders = [],
    name = kind === "Profile" ? source.name : chosen[0].name;
  for (const page of chosen) {
    const widgets = [];
    for (const w of page.widgets.filter(
      (w) => kind !== "Widgets" || !widgetIds || widgetIds.includes(w.id),
    )) {
      const id = randomUUID(),
        location = `${page.name} / ${w.label}`,
        d = {
          label: w.label,
          backgroundColor: w.style.background || w.color,
          labelColor: w.style.textColor,
          textAlign: w.style.align,
          labelPosition: w.style.labelPosition,
          fontSize: w.style.textSize,
        };
      let type = "ActionButton";
      if (w.image) {
        const value = assets[w.image];
        if (
          typeof value === "string" &&
          /^data:image\/(png|jpeg|webp);base64,/.test(value) &&
          digest(Buffer.from(value.split(",")[1], "base64")) === w.image
        )
          d.imageUrl = value;
        else
          warn(
            report,
            "image-missing",
            location,
            "An image was not supplied for export.",
          );
      }
      if (w.type === "clock") type = "Clock";
      else if (w.type === "timer") {
        type = "Countdown";
        d.mode = "fixed";
        d.durationHours = 0;
        d.durationMinutes = Math.floor(w.minutes);
        d.durationSeconds = Math.round((w.minutes % 1) * 60);
      } else if (w.type === "slider") {
        type = "Slider";
        Object.assign(d, {
          valueVariable: w.binding,
          min: w.min,
          max: w.max,
          step: w.step,
        });
      } else if (w.type === "graph") {
        type = "HistoryGraph";
        Object.assign(d, {
          title: w.label,
          valueVariable: w.binding,
          unit: w.unit,
        });
      } else if (w.type === "gauges") type = "Gauges";
      else if (w.type === "page" && ids.has(w.targetPage))
        d.flows = [
          {
            triggerId: randomUUID(),
            triggerType: "onShortPress",
            children: [
              {
                id: randomUUID(),
                type: "action",
                integrationId: "app.macro-deck.deck",
                actionId: "change-folder",
                parameters: [parameter("folderId", ids.get(w.targetPage))],
                children: [],
              },
            ],
          },
        ];
      else if (["button", "toggle"].includes(w.type))
        d.flows = [
          ["actions", "onShortPress"],
          ["longActions", "onLongPress"],
          ["doubleActions", "onDoublePress"],
        ].map(([k, triggerType]) => ({
          triggerId: randomUUID(),
          triggerType,
          children: list(w[k])
            .map((a) => exportAction(a, report, location))
            .filter(Boolean),
        }));
      else
        warn(
          report,
          "widget-not-exported",
          location,
          `Open Deck ${w.type} is exported as an inactive action button.`,
        );
      for (const [variable, value] of Object.entries(config.variables).filter(
        ([name]) =>
          w.binding === name ||
          JSON.stringify([w.actions, w.longActions, w.doubleActions]).includes(
            '\"variable\":\"' + name + '\"',
          ),
      ))
        variables.push({
          widgetId: id,
          name: variable,
          type:
            typeof value === "number"
              ? "Numeric"
              : typeof value === "boolean"
                ? "Boolean"
                : "Text",
          value: String(value),
        });
      widgets.push({
        id,
        type,
        positionX: w.x,
        positionY: w.y,
        width: w.w,
        height: w.h,
        data: JSON.stringify(d),
        isPinned: !!w.pinScope && w.pinScope !== "none",
        pinScope: w.pinScope === "global" ? "Global" : "Profile",
      });
    }
    folders.push({
      id: ids.get(page.id),
      name: page.name,
      parentId: ids.get(page.parentId) || null,
      order: folders.length,
      rows: page.rows,
      columns: page.columns,
      backgroundColor: page.background,
      widgetSpacing: page.gap,
      widgetBorderRadius: page.radius,
      emptyCellStyle: page.showEmptyCells === false ? "none" : "dashed",
      isDefault: page.id === source.defaultPageId,
      createdAt: new Date().toISOString(),
      widgets,
    });
  }
  const profile = {
    id: randomUUID(),
    name: source.name,
    order: 0,
    layoutType: "Grid",
    defaultRows: chosen[0].rows,
    defaultColumns: chosen[0].columns,
    folders,
  };
  const content = {
    kind,
    icons: [],
    scripts: [],
    secrets: [],
    variables,
    scriptVariables: [],
    fonts: [],
  };
  if (kind === "Profile") content.profile = profile;
  else if (kind === "Folder") content.folders = folders;
  else
    content.widgets = folders.flatMap((f) =>
      f.widgets.map(({ id, isPinned, pinScope, ...w }) => ({
        ...w,
        sourceId: id,
      })),
    );
  const files = new Map([
      ["content.json", Buffer.from(JSON.stringify(content))],
    ]),
    manifest = {
      formatVersion: 2,
      kind,
      appVersion: "3.0.0",
      createdAt: new Date().toISOString(),
      includesSecrets: false,
      contents: {
        name,
        folderCount: folders.length,
        widgetCount: folders.reduce((n, f) => n + f.widgets.length, 0),
        iconCount: 0,
        scriptCount: 0,
        secretCount: 0,
        variableCount: variables.length,
        fontCount: 0,
        integrations: [],
      },
    };
  let bytes;
  if (password) {
    manifest.encryption = portableEncryption();
    const manifestBytes = Buffer.from(JSON.stringify(manifest)),
      payload = await encryptPortable(
        writeZip(files),
        password,
        manifestBytes,
        manifest.encryption,
      );
    bytes = writeZip({
      "manifest.json": manifestBytes,
      "payload.enc": payload,
    });
  } else {
    manifest.encryption = null;
    manifest.files = [...files].map(([path, b]) => ({
      path,
      sha256: "sha256:" + digest(b),
      size: b.length,
    }));
    files.set("manifest.json", Buffer.from(JSON.stringify(manifest)));
    bytes = writeZip(files);
  }
  return {
    bytes,
    filename: `${text(name, 80).replace(/[^a-zA-Z0-9가-힣 _.-]/g, "_") || "Open Deck"}.macroDeck${kind === "Widgets" ? "Widget" : kind}`,
    report,
  };
}

export function mergeMacroDeckImport(current, result) {
  const base = validateConfig(current),
    incoming = validateConfig(result.config),
    report = [...list(result.report)],
    idMap = new Map(),
    variableMap = new Map();
  for (const p of incoming.profiles) idMap.set(p.id, randomUUID());
  for (const p of incoming.pages) {
    idMap.set(p.id, randomUUID());
    for (const w of p.widgets) idMap.set(w.id, randomUUID());
  }
  for (const [key, value] of Object.entries(incoming.variables)) {
    let name = key,
      n = 1;
    while (Object.hasOwn(base.variables, name))
      name = `${key.slice(0, 55)}_${++n}`;
    variableMap.set(key, name);
    base.variables[name] = value;
    if (name !== key)
      warn(
        report,
        "variable-renamed",
        "variables",
        `Variable ${key} was imported as ${name} to preserve existing values.`,
      );
  }
  const rewrite = (value) => {
    if (typeof value === "string")
      return value.replace(
        /{{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*}}/g,
        (whole, key) =>
          variableMap.has(key) ? `{{${variableMap.get(key)}}}` : whole,
      );
    if (Array.isArray(value)) return value.map(rewrite);
    if (!value || typeof value !== "object") return value;
    const output = {};
    for (const [key, v] of Object.entries(value)) {
      if (
        ["id", "parentId", "targetPage", "defaultPageId"].includes(key) &&
        idMap.has(v)
      )
        output[key] = idMap.get(v);
      else if (key === "pageIds")
        output[key] = v.map((id) => idMap.get(id) || id);
      else if (
        ["variable", "binding", "stateVariable"].includes(key) &&
        variableMap.has(v)
      )
        output[key] = variableMap.get(v);
      else output[key] = rewrite(v);
    }
    return output;
  };
  base.pages.push(...incoming.pages.map(rewrite));
  base.profiles.push(...incoming.profiles.map(rewrite));
  return { config: validateConfig(base), assets: result.assets || {}, report };
}
