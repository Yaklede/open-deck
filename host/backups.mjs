import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { validateConfig } from "./config.mjs";
import {
  APP_VERSION as appVersion,
  defaultSettings,
  mergeSettings,
} from "./settings.mjs";

export const MAX_BACKUP_BYTES = 64 * 1024 * 1024;
const KIND = "open-deck-backup";
const ENCRYPTED_KIND = "open-deck-backup-encrypted";
const AAD = Buffer.from("Open Deck backup v1");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const object = (v) =>
  v !== null &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
const digest = (bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");
const CONFIG_FIELDS = [
  "version",
  "name",
  "columns",
  "pages",
  "variables",
  "integrations",
  "automations",
  "extensions",
  "profiles",
  "defaultProfileId",
];

function boundedJson(value) {
  const json = JSON.stringify(value);
  if (typeof json !== "string" || Buffer.byteLength(json) > MAX_BACKUP_BYTES)
    throw Error("백업은 64MB 이하여야 합니다.");
  return json;
}

function privateDirectory(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw Error("안전한 백업 폴더가 필요합니다.");
  fs.chmodSync(dir, 0o700);
}

function readPrivate(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const info = fs.fstatSync(fd);
    if (
      !info.isFile() ||
      info.size > MAX_BACKUP_BYTES ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw Error("백업 파일의 크기 또는 소유자를 확인하세요.");
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writePrivate(file, bytes) {
  privateDirectory(path.dirname(file));
  if (fs.existsSync(file)) {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink())
      throw Error("안전한 일반 파일만 저장할 수 있습니다.");
  }
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
    fs.chmodSync(file, 0o600);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function configCopy(input) {
  if (!object(input)) throw Error("덱 설정이 필요합니다.");
  // Runtime files, pairing records, and Keychain credentials are deliberately not a backup source.
  return validateConfig(
    Object.fromEntries(
      CONFIG_FIELDS.filter((key) => Object.hasOwn(input, key)).map((key) => [
        key,
        structuredClone(input[key]),
      ]),
    ),
  );
}

function profiles(config) {
  return (
    config.profiles || [
      {
        id: "default",
        name: config.name || "기본 프로필",
        pageIds: config.pages.map((p) => p.id),
        defaultPageId: config.pages[0]?.id,
        focusApps: [],
      },
    ]
  );
}

function assetIds(config) {
  const ids = new Set();
  for (const p of config.pages) {
    if (p.backgroundImage) ids.add(p.backgroundImage);
    for (const w of p.widgets) if (w.image) ids.add(w.image);
  }
  for (const id of ids)
    if (!HASH.test(id)) throw Error("이미지 식별자를 확인하세요.");
  return ids;
}

function imageMime(bytes) {
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";
  if (
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  throw Error("백업 이미지의 형식을 확인하세요.");
}

function imageBytes(id, encoded) {
  if (!HASH.test(id) || typeof encoded !== "string" || encoded.length > 2800000)
    throw Error("백업 이미지가 잘못되었습니다.");
  const match =
    /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(
      encoded,
    );
  if (!match) throw Error("백업 이미지가 잘못되었습니다.");
  const bytes = Buffer.from(match[2], "base64");
  if (
    bytes.length > 2097152 ||
    bytes.toString("base64") !== match[2] ||
    digest(bytes) !== id ||
    imageMime(bytes) !== match[1]
  )
    throw Error("백업 이미지 검증에 실패했습니다.");
  return bytes;
}

function stateCopy(raw, config) {
  if (raw === undefined || raw === null) return null;
  if (!object(raw) || !object(raw.variables || {}) || !object(raw.todos || {}))
    throw Error("저장 상태를 확인하세요.");
  const variables = {};
  for (const [key, value] of Object.entries(raw.variables || {})) {
    if (!Object.hasOwn(config.variables, key)) continue;
    if (
      typeof value !== typeof config.variables[key] ||
      (typeof value === "number" && !Number.isFinite(value)) ||
      (typeof value === "string" && value.length > 2048)
    )
      throw Error("백업 변수의 형식이 다릅니다.");
    variables[key] = value;
  }
  const ids = new Set(
    config.pages.flatMap((p) =>
      p.widgets.filter((w) => w.type === "todo").map((w) => w.id),
    ),
  );
  const todos = {};
  for (const [id, items] of Object.entries(raw.todos || {})) {
    if (!ids.has(id)) continue;
    if (
      !Array.isArray(items) ||
      items.length > 50 ||
      items.some(
        (v) =>
          !object(v) ||
          typeof v.id !== "string" ||
          !v.id ||
          v.id.length > 128 ||
          typeof v.text !== "string" ||
          !v.text.trim() ||
          v.text.length > 160 ||
          typeof v.done !== "boolean",
      ) ||
      new Set(items.map((v) => v.id)).size !== items.length
    )
      throw Error("백업 할 일의 형식을 확인하세요.");
    todos[id] = items.map(({ id, text, done }) => ({ id, text, done }));
  }
  return { variables, todos };
}

function preferencesCopy(value) {
  return value === undefined || value === null
    ? null
    : mergeSettings(defaultSettings(), value);
}

function selectedConfig(input, selectedIds) {
  const config = configCopy(input);
  if (selectedIds === undefined || selectedIds === null) return config;
  if (
    !Array.isArray(selectedIds) ||
    selectedIds.length === 0 ||
    selectedIds.length > 40 ||
    selectedIds.some((id) => typeof id !== "string")
  )
    throw Error("복원할 프로필을 선택하세요.");
  const selected = new Set(selectedIds),
    allProfiles = profiles(config);
  if ([...selected].some((id) => !allProfiles.some((p) => p.id === id)))
    throw Error("백업에서 프로필을 찾을 수 없습니다.");
  config.profiles = allProfiles.filter((p) => selected.has(p.id));
  const pages = new Set(config.profiles.flatMap((p) => p.pageIds));
  config.pages = config.pages.filter((p) => pages.has(p.id));
  if (!config.pages.length) throw Error("선택한 프로필에 페이지가 없습니다.");
  if (!selected.has(config.defaultProfileId))
    config.defaultProfileId = config.profiles[0].id;
  for (const p of config.pages) {
    if (p.parentId && !pages.has(p.parentId))
      throw Error("상위 페이지가 있는 프로필도 함께 선택하세요.");
    for (const w of p.widgets)
      if (w.type === "page" && !pages.has(w.targetPage))
        throw Error("페이지 연결 대상의 프로필도 함께 선택하세요.");
  }
  const widgetIds = new Set(
    config.pages.flatMap((p) => p.widgets.map((w) => w.id)),
  );
  config.automations = (config.automations || []).filter((a) =>
    widgetIds.has(a.widgetId),
  );
  const usedVariables = new Set(),
    usedIntegrations = new Set();
  const scan = (value) => {
    if (typeof value === "string")
      for (const match of value.matchAll(
        /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g,
      ))
        usedVariables.add(match[1]);
    else if (Array.isArray(value)) value.forEach(scan);
    else if (object(value))
      for (const [key, child] of Object.entries(value)) {
        if (["binding", "variable"].includes(key) && typeof child === "string")
          usedVariables.add(child);
        if (key === "integrationId" && typeof child === "string")
          usedIntegrations.add(child);
        scan(child);
      }
  };
  scan(config.pages);
  scan(config.automations);
  let previous;
  do {
    previous = `${usedVariables.size}/${usedIntegrations.size}`;
    for (const i of config.integrations)
      if (usedIntegrations.has(i.id) || usedVariables.has(i.variable)) {
        usedIntegrations.add(i.id);
        scan(i);
      }
  } while (previous !== `${usedVariables.size}/${usedIntegrations.size}`);
  config.variables = Object.fromEntries(
    Object.entries(config.variables).filter(([key]) => usedVariables.has(key)),
  );
  config.integrations = config.integrations.filter((i) =>
    usedIntegrations.has(i.id),
  );
  return configCopy(config);
}

function mergeSelected(current, incoming, selectedIds) {
  const out = configCopy(current),
    selected = selectedConfig(incoming, selectedIds);
  const chosen = new Set(profiles(selected).map((p) => p.id));
  const oldPages = new Set(
    profiles(out)
      .filter((p) => chosen.has(p.id))
      .flatMap((p) => p.pageIds),
  );
  const untouched = out.pages.filter((p) => !oldPages.has(p.id));
  const liveIds = new Set(
    untouched.flatMap((p) => [p.id, ...p.widgets.map((w) => w.id)]),
  );
  if (
    selected.pages.some(
      (p) => liveIds.has(p.id) || p.widgets.some((w) => liveIds.has(w.id)),
    )
  )
    throw Error(
      "다른 프로필의 페이지 또는 위젯 ID와 충돌합니다. 전체 복원을 사용하거나 원본을 먼저 확인하세요.",
    );
  out.pages = [...untouched, ...selected.pages];
  out.profiles = [
    ...profiles(out).filter((p) => !chosen.has(p.id)),
    ...profiles(selected),
  ];
  for (const [key, value] of Object.entries(selected.variables)) {
    if (
      Object.hasOwn(out.variables, key) &&
      typeof out.variables[key] !== typeof value
    )
      throw Error(`변수 형식이 충돌합니다: ${key}`);
    if (!Object.hasOwn(out.variables, key)) out.variables[key] = value;
  }
  for (const integration of selected.integrations) {
    const existing = out.integrations.find((i) => i.id === integration.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(integration))
      throw Error(`HTTP 연동 설정이 충돌합니다: ${integration.id}`);
    if (!existing) out.integrations.push(integration);
  }
  const keptWidgetIds = new Set(
    untouched.flatMap((p) => p.widgets.map((w) => w.id)),
  );
  out.automations = (out.automations || []).filter((a) =>
    keptWidgetIds.has(a.widgetId),
  );
  for (const automation of selected.automations || []) {
    if (out.automations.some((a) => a.id === automation.id))
      throw Error("다른 프로필의 자동화 ID와 충돌합니다.");
    out.automations.push(automation);
  }
  return configCopy(out);
}

function seal(payload) {
  const normalized = JSON.parse(boundedJson(payload));
  return { ...normalized, checksum: digest(boundedJson(normalized)) };
}

function validated(archive) {
  if (
    !object(archive) ||
    archive.kind !== KIND ||
    archive.formatVersion !== 1 ||
    !HASH.test(archive.checksum || "")
  )
    throw Error("지원하지 않는 Open Deck 백업입니다.");
  const { checksum, ...payload } = archive;
  if (digest(boundedJson(payload)) !== checksum)
    throw Error("백업 체크섬이 일치하지 않습니다.");
  if (
    typeof payload.createdAt !== "string" ||
    !Number.isFinite(Date.parse(payload.createdAt)) ||
    typeof payload.appVersion !== "string" ||
    payload.appVersion.length > 64 ||
    typeof payload.reason !== "string" ||
    payload.reason.length > 80
  )
    throw Error("백업 정보를 확인하세요.");
  const config = configCopy(payload.config);
  if (!object(payload.assets)) throw Error("백업 이미지 목록을 확인하세요.");
  const required = assetIds(config);
  if (
    Object.keys(payload.assets).length !== required.size ||
    [...required].some((id) => !Object.hasOwn(payload.assets, id))
  )
    throw Error("필요한 이미지가 백업에 없습니다.");
  for (const [id, encoded] of Object.entries(payload.assets))
    imageBytes(id, encoded);
  const state = stateCopy(payload.state, config);
  return seal({
    kind: KIND,
    formatVersion: 1,
    createdAt: payload.createdAt,
    appVersion: payload.appVersion,
    reason: payload.reason,
    config,
    state,
    preferences: preferencesCopy(payload.preferences),
    assets: payload.assets,
  });
}

function passwordKey(password, salt) {
  if (
    typeof password !== "string" ||
    password.length < 8 ||
    Buffer.byteLength(password) > 4096
  )
    throw Error("백업 암호는 8자 이상이어야 합니다.");
  return crypto.scryptSync(password, salt, 32, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
}

function decode64(value, length) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
    throw Error("암호화 백업 형식을 확인하세요.");
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.toString("base64") !== value ||
    (length !== undefined && bytes.length !== length)
  )
    throw Error("암호화 백업 형식을 확인하세요.");
  return bytes;
}

function decrypt(archive, password) {
  if (
    archive.formatVersion !== 1 ||
    archive.algorithm !== "aes-256-gcm" ||
    archive.kdf !== "scrypt"
  )
    throw Error("지원하지 않는 백업 암호화 형식입니다.");
  const salt = decode64(archive.salt, 16),
    iv = decode64(archive.iv, 12),
    tag = decode64(archive.tag, 16),
    bytes = decode64(archive.data);
  const key = passwordKey(password, salt);
  try {
    const cipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(AAD);
    cipher.setAuthTag(tag);
    return JSON.parse(
      Buffer.concat([cipher.update(bytes), cipher.final()]).toString("utf8"),
    );
  } catch {
    throw Error("백업 암호가 다르거나 암호화 파일이 손상되었습니다.");
  } finally {
    key.fill(0);
  }
}

function metadata(id, archive, size) {
  const entries = profiles(archive.config).map((p) => {
    const pages = archive.config.pages.filter((page) =>
      p.pageIds.includes(page.id),
    );
    return {
      id: p.id,
      name: p.name,
      pageCount: pages.length,
      widgetCount: pages.reduce((sum, page) => sum + page.widgets.length, 0),
    };
  });
  const counts = {
    profiles: entries.length,
    pages: archive.config.pages.length,
    widgets: archive.config.pages.reduce((sum, p) => sum + p.widgets.length, 0),
    variables: Object.keys(archive.config.variables).length,
    todos: Object.values(archive.state?.todos || {}).reduce(
      (sum, rows) => sum + rows.length,
      0,
    ),
    assets: Object.keys(archive.assets).length,
  };
  return {
    id,
    name: `${archive.reason} · ${archive.createdAt}`,
    createdAt: archive.createdAt,
    reason: archive.reason,
    appVersion: archive.appVersion,
    sizeBytes: size,
    encrypted: false,
    hasState: archive.state !== null,
    hasPreferences:
      archive.preferences !== null && archive.preferences !== undefined,
    profiles: entries,
    counts,
    storage: "private-plaintext",
  };
}

export class Backups {
  constructor({
    dir,
    getConfig,
    getSettings = () => ({}),
    applyConfig,
    getState,
    applyState,
    getPreferences,
    applyPreferences,
    now = Date.now,
  }) {
    this.dir = dir;
    this.root = path.join(dir, "backups");
    privateDirectory(this.root);
    this.getConfig = getConfig;
    this.getSettings = getSettings;
    this.applyConfig = applyConfig;
    this.getState = getState;
    this.applyState = applyState;
    this.getPreferences = getPreferences;
    this.applyPreferences = applyPreferences;
    this.now = now;
    this.cache = new Map();
    this.scheduleFile = path.join(this.root, "schedule.json");
    this.scheduleState = { lastRunAt: null, lastSlot: null };
    if (fs.existsSync(this.scheduleFile)) {
      const saved = JSON.parse(readPrivate(this.scheduleFile));
      if (object(saved) && Number.isFinite(saved.lastRunAt))
        this.scheduleState = {
          lastRunAt: saved.lastRunAt,
          lastSlot: typeof saved.lastSlot === "string" ? saved.lastSlot : null,
        };
    }
  }

  file(id) {
    if (typeof id !== "string" || !UUID.test(id))
      throw Error("백업 식별자를 확인하세요.");
    return path.join(this.root, `${id}.json`);
  }

  settings() {
    const value = this.getSettings() || {},
      s = value.backups || value;
    return {
      enabled: s.enabled === true,
      retention: Number.isInteger(s.retention)
        ? Math.min(100, Math.max(1, s.retention))
        : 14,
      intervalHours: Number.isInteger(s.intervalHours)
        ? Math.min(168, Math.max(1, s.intervalHours))
        : 24,
      schedule: ["interval", "daily", "weekly", "monthly"].includes(s.schedule)
        ? s.schedule
        : "interval",
      time: /^([01]\d|2[0-3]):[0-5]\d$/.test(s.time || "") ? s.time : "03:00",
      dayOfWeek: Number.isInteger(s.dayOfWeek)
        ? Math.min(6, Math.max(0, s.dayOfWeek))
        : 0,
      dayOfMonth: Number.isInteger(s.dayOfMonth)
        ? Math.min(28, Math.max(1, s.dayOfMonth))
        : 1,
    };
  }

  read(id) {
    return validated(JSON.parse(readPrivate(this.file(id)).toString("utf8")));
  }

  list() {
    const entries = fs
      .readdirSync(this.root)
      .filter(
        (name) =>
          UUID.test(name.replace(/\.json$/, "")) && name.endsWith(".json"),
      );
    if (entries.length > 1000) throw Error("백업 파일이 너무 많습니다.");
    const rows = entries.map((name) => {
      const id = name.slice(0, -5),
        info = fs.lstatSync(this.file(id));
      if (info.isSymbolicLink() || !info.isFile())
        throw Error("안전한 백업 파일이 필요합니다.");
      const cache = this.cache.get(id),
        stamp = `${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
      if (cache?.stamp === stamp) return structuredClone(cache.meta);
      let meta;
      try {
        meta = metadata(id, this.read(id), info.size);
      } catch {
        // A damaged old archive must not prevent a new safety snapshot or scheduled backup.
        // Keep it visible and removable, but never treat it as a usable restore point.
        meta = {
          id,
          name: "손상된 백업",
          createdAt: info.mtime.toISOString(),
          reason: "unreadable",
          appVersion: "—",
          sizeBytes: info.size,
          encrypted: false,
          hasState: false,
          hasPreferences: false,
          profiles: [],
          counts: {
            profiles: 0,
            pages: 0,
            widgets: 0,
            variables: 0,
            todos: 0,
            assets: 0,
          },
          storage: "private-plaintext",
          corrupt: true,
          error: "백업 검증에 실패했습니다. 이 파일은 복원할 수 없습니다.",
        };
      }
      this.cache.set(id, { stamp, meta });
      return meta;
    });
    return rows.sort(
      (a, b) =>
        Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
        b.id.localeCompare(a.id),
    );
  }

  collect(config) {
    const assets = {};
    for (const id of assetIds(config)) {
      const root = path.join(this.dir, "assets");
      const info = fs.lstatSync(root);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw Error("안전한 이미지 폴더가 필요합니다.");
      const bytes = readPrivate(path.join(root, id));
      if (bytes.length > 2097152 || digest(bytes) !== id)
        throw Error("이미지 파일의 체크섬이 일치하지 않습니다.");
      assets[id] =
        `data:${imageMime(bytes)};base64,${bytes.toString("base64")}`;
    }
    return assets;
  }

  store(archive) {
    const id = crypto.randomUUID(),
      json = boundedJson(archive);
    writePrivate(this.file(id), json);
    this.enforceRetention(id);
    return metadata(id, archive, Buffer.byteLength(json));
  }

  create(reason = "manual", { profileIds } = {}, at = this.now()) {
    if (
      typeof reason !== "string" ||
      !reason.trim() ||
      reason.length > 80 ||
      /[\x00-\x1f]/.test(reason) ||
      !Number.isFinite(at)
    )
      throw Error("백업 정보를 확인하세요.");
    const config = selectedConfig(this.getConfig(), profileIds);
    return this.store(
      seal({
        kind: KIND,
        formatVersion: 1,
        createdAt: new Date(at).toISOString(),
        appVersion,
        reason,
        config,
        state: stateCopy(this.getState?.(), config),
        preferences: profileIds
          ? null
          : preferencesCopy(this.getPreferences?.()),
        assets: this.collect(config),
      }),
    );
  }

  preview(id) {
    const archive = this.read(id);
    return metadata(id, archive, fs.statSync(this.file(id)).size);
  }

  remove(id) {
    const file = this.file(id),
      info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink())
      throw Error("안전한 백업 파일이 필요합니다.");
    fs.unlinkSync(file);
    this.cache.delete(id);
    return { ok: true };
  }

  enforceRetention(preserveId) {
    const keep = this.settings().retention;
    const rows = this.list().filter((row) => !row.corrupt),
      ordered = [
        rows.find((row) => row.id === preserveId),
        ...rows.filter((row) => row.id !== preserveId),
      ].filter(Boolean);
    for (const row of ordered.slice(keep)) this.remove(row.id);
  }

  restore(id, { profileIds, restoreState = false, restorePreferences } = {}) {
    if (typeof this.applyConfig !== "function")
      throw Error("이 환경에서는 백업을 복원할 수 없습니다.");
    if (typeof restoreState !== "boolean")
      throw Error("상태 복원 옵션을 확인하세요.");
    if (
      restorePreferences !== undefined &&
      typeof restorePreferences !== "boolean"
    )
      throw Error("앱 설정 복원 옵션을 확인하세요.");
    const archive = this.read(id),
      original = configCopy(this.getConfig());
    const selected = profileIds !== undefined && profileIds !== null;
    const incoming = selected
      ? selectedConfig(archive.config, profileIds)
      : archive.config;
    const candidate = selected
      ? mergeSelected(original, archive.config, profileIds)
      : configCopy(incoming);
    const previousState = stateCopy(this.getState?.(), original);
    const previousPreferences = preferencesCopy(this.getPreferences?.());
    const nextPreferences =
      (restorePreferences ?? !selected)
        ? preferencesCopy(archive.preferences)
        : null;
    if (
      nextPreferences &&
      (typeof this.applyPreferences !== "function" ||
        previousPreferences === null)
    )
      throw Error("이 환경에서는 앱 설정을 복원할 수 없습니다.");
    let nextState = null;
    if (restoreState) {
      if (typeof this.applyState !== "function" || archive.state === null)
        throw Error("이 백업에는 복원 가능한 변수·할 일 상태가 없습니다.");
      const saved = stateCopy(archive.state, incoming);
      if (selected) {
        nextState = stateCopy(previousState || {}, candidate);
        Object.assign(nextState.variables, saved.variables);
        for (const p of incoming.pages)
          for (const w of p.widgets)
            if (w.type === "todo")
              nextState.todos[w.id] = saved.todos[w.id] || [];
      } else nextState = saved;
    } else if (previousState && typeof this.applyState === "function") {
      // Applying a restored config can reset runtime values when their defaults
      // changed. Keep compatible live state, using the restored defaults only
      // for new variables or variables whose type changed.
      const variables = { ...candidate.variables };
      for (const [key, value] of Object.entries(previousState.variables))
        if (
          Object.hasOwn(candidate.variables, key) &&
          typeof candidate.variables[key] === typeof value
        )
          variables[key] = value;
      nextState = stateCopy({ variables, todos: previousState.todos }, candidate);
    }
    // All bytes and references are checked before making a safety snapshot or changing live data.
    const images = Object.entries(archive.assets).map(([key, value]) => [
      key,
      imageBytes(key, value),
    ]);
    const safetyBackup = this.create("before-restore");
    for (const [key, bytes] of images)
      writePrivate(path.join(this.dir, "assets", key), bytes);
    try {
      this.applyConfig(candidate);
      if (nextState) this.applyState(nextState);
      if (nextPreferences) this.applyPreferences(nextPreferences);
    } catch (error) {
      let rolledBack = false;
      try {
        this.applyConfig(original);
        if (previousState && this.applyState) this.applyState(previousState);
        if (previousPreferences && this.applyPreferences)
          this.applyPreferences(previousPreferences);
        rolledBack = true;
      } catch {}
      throw Error(
        rolledBack
          ? "복원에 실패하여 기존 데이터로 되돌렸습니다."
          : `복원에 실패했습니다. 안전 백업 ${safetyBackup.id}에서 기존 데이터를 복구하세요.`,
        { cause: error },
      );
    }
    const restored = metadata(
      id,
      {
        ...archive,
        config: incoming,
        state: stateCopy(archive.state, incoming),
        assets: Object.fromEntries(
          Object.entries(archive.assets).filter(([key]) =>
            assetIds(incoming).has(key),
          ),
        ),
      },
      0,
    ).counts;
    return {
      ok: true,
      safetyBackupId: safetyBackup.id,
      restored,
      profiles: profiles(incoming).map((p) => p.id),
      stateRestored: restoreState && nextState !== null,
      preferencesRestored: nextPreferences !== null,
    };
  }

  export(id, password, { profileIds } = {}) {
    let archive = this.read(id);
    if (profileIds !== undefined) {
      const config = selectedConfig(archive.config, profileIds),
        required = assetIds(config);
      const { checksum, ...payload } = archive;
      archive = seal({
        ...payload,
        config,
        state: stateCopy(archive.state, config),
        preferences: null,
        assets: Object.fromEntries(
          Object.entries(archive.assets).filter(([key]) => required.has(key)),
        ),
      });
    }
    if (password === undefined || password === null || password === "")
      return archive;
    const salt = crypto.randomBytes(16),
      iv = crypto.randomBytes(12),
      key = passwordKey(password, salt);
    try {
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(AAD);
      const bytes = Buffer.concat([
        cipher.update(boundedJson(archive), "utf8"),
        cipher.final(),
      ]);
      const encrypted = {
        kind: ENCRYPTED_KIND,
        formatVersion: 1,
        algorithm: "aes-256-gcm",
        kdf: "scrypt",
        salt: salt.toString("base64"),
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        data: bytes.toString("base64"),
      };
      boundedJson(encrypted);
      return encrypted;
    } finally {
      key.fill(0);
    }
  }

  import(input, password) {
    let archive;
    if (typeof input === "string") {
      if (Buffer.byteLength(input) > MAX_BACKUP_BYTES)
        throw Error("백업은 64MB 이하여야 합니다.");
      archive = JSON.parse(input);
    } else archive = JSON.parse(boundedJson(input));
    if (archive?.kind === ENCRYPTED_KIND) archive = decrypt(archive, password);
    if (
      object(archive) &&
      [1, 2].includes(archive.version) &&
      Array.isArray(archive.pages)
    ) {
      const config = configCopy(archive);
      archive = seal({
        kind: KIND,
        formatVersion: 1,
        createdAt: new Date(this.now()).toISOString(),
        appVersion: "legacy",
        reason: "imported",
        config,
        state: null,
        assets: archive.assets || {},
      });
    }
    const checked = validated(archive),
      { checksum, ...payload } = checked;
    return this.store(seal({ ...payload, reason: "imported" }));
  }

  dueSlot(now) {
    const s = this.settings(),
      [hour, minute] = s.time.split(":").map(Number),
      date = new Date(now);
    date.setHours(hour, minute, 0, 0);
    if (s.schedule === "daily") {
      if (date.getTime() > now) date.setDate(date.getDate() - 1);
    } else if (s.schedule === "weekly") {
      date.setDate(date.getDate() - ((date.getDay() - s.dayOfWeek + 7) % 7));
      if (date.getTime() > now) date.setDate(date.getDate() - 7);
    } else if (s.schedule === "monthly") {
      date.setDate(s.dayOfMonth);
      if (date.getTime() > now) date.setMonth(date.getMonth() - 1);
    }
    return date.getTime();
  }

  nextScheduledAt(now = this.now()) {
    const s = this.settings();
    if (!s.enabled) return null;
    if (s.schedule === "interval")
      return new Date(
        Math.max(
          now,
          (this.scheduleState.lastRunAt ?? now) + s.intervalHours * 3600000,
        ),
      ).toISOString();
    const date = new Date(this.dueSlot(now));
    if (s.schedule === "daily") date.setDate(date.getDate() + 1);
    if (s.schedule === "weekly") date.setDate(date.getDate() + 7);
    if (s.schedule === "monthly") date.setMonth(date.getMonth() + 1);
    return date.toISOString();
  }

  tick(now = this.now()) {
    if (!Number.isFinite(now)) throw Error("백업 시각을 확인하세요.");
    const s = this.settings();
    if (!s.enabled) return null;
    let slot;
    if (s.schedule === "interval") {
      if (
        this.scheduleState.lastRunAt !== null &&
        now - this.scheduleState.lastRunAt < s.intervalHours * 3600000
      )
        return null;
      slot = `interval:${now}`;
    } else {
      const due = this.dueSlot(now);
      slot = `${s.schedule}:${due}`;
      if (
        this.scheduleState.lastSlot === slot ||
        (this.scheduleState.lastRunAt !== null &&
          this.scheduleState.lastRunAt >= due)
      )
        return null;
    }
    const result = this.create("scheduled", {}, now);
    this.scheduleState = { lastRunAt: now, lastSlot: slot };
    writePrivate(this.scheduleFile, boundedJson(this.scheduleState));
    return result;
  }
}
