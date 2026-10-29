import fs from "node:fs";
import path from "node:path";
import { writeJson } from "./config.mjs";

export const APP_VERSION = "0.15.0";
export const defaultSettings = () => ({
  appearance: {
    themeMode: "dark",
    accentColor: "#a6acff",
    fontFamily: "system",
    uiScale: 100,
    language: "ko",
    timeFormat: "24h",
    palette: [],
  },
  startup: { autostart: true, openMinimized: true, showDockIcon: true },
  network: {
    wifiEnabled: true,
    wifiPort: 8841,
    discoveryEnabled: true,
    tlsEnabled: true,
    tlsMode: "Replace",
    tlsHttpsPort: 8842,
  },
  usb: {
    enabled: true,
    executablePath: "",
    defaultDeviceSerial: "",
    autoConnect: true,
    stopServerOnExit: false,
    companionAutoUpdate: false,
  },
  backups: {
    enabled: true,
    beforeUpdate: true,
    intervalHours: 24,
    retention: 14,
    schedule: "interval",
    time: "03:00",
    dayOfWeek: 0,
    dayOfMonth: 1,
  },
  logging: { minimumLevel: "info" },
  http: { userAgent: "OpenDeck/" + APP_VERSION },
  developer: { enabled: false },
  security: { idleLockMinutes: 0 },
});
const bool = (v) => typeof v === "boolean";
const str = (max) => (v) =>
  typeof v === "string" && v.length <= max && !/[\x00-\x1f]/.test(v);
const num = (min, max) => (v) => Number.isInteger(v) && v >= min && v <= max;
const one =
  (...values) =>
  (v) =>
    values.includes(v);
const color = (v) =>
  typeof v === "string" && /^#[a-f0-9]{6}([a-f0-9]{2})?$/i.test(v);
const schema = {
  appearance: {
    themeMode: one("dark", "light", "system"),
    accentColor: (v) =>
      color(v) ||
      (typeof v === "string" && /^{{[a-zA-Z][a-zA-Z0-9_]{0,63}}}$/.test(v)),
    fontFamily: (v) => str(120)(v) && v.length > 0 && !/[;{}<>]/.test(v),
    uiScale: num(80, 140),
    language: one(
      "system",
      "ar",
      "pt-BR",
      "cs",
      "nl",
      "en",
      "fr",
      "de",
      "hi",
      "id",
      "it",
      "ja",
      "ko",
      "pl",
      "ru",
      "zh",
      "es",
      "zh-TW",
      "tr",
      "uk",
    ),
    timeFormat: one("24h", "12h"),
    palette: (v) => Array.isArray(v) && v.length <= 24 && v.every(color),
  },
  startup: { autostart: bool, openMinimized: bool, showDockIcon: bool },
  network: {
    wifiEnabled: bool,
    wifiPort: num(1024, 65535),
    discoveryEnabled: bool,
    tlsEnabled: bool,
    tlsMode: one("Replace", "Additional"),
    tlsHttpsPort: num(1024, 65535),
  },
  usb: {
    enabled: bool,
    executablePath: (v) => str(2048)(v) && (!v || v.startsWith("/")),
    defaultDeviceSerial: str(128),
    autoConnect: bool,
    stopServerOnExit: bool,
    companionAutoUpdate: bool,
  },
  backups: {
    enabled: bool,
    beforeUpdate: bool,
    intervalHours: num(1, 168),
    retention: num(1, 100),
    schedule: one("interval", "daily", "weekly", "monthly"),
    time: (v) => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v),
    dayOfWeek: num(0, 6),
    dayOfMonth: num(1, 28),
  },
  logging: { minimumLevel: one("debug", "info", "warn", "error") },
  http: { userAgent: str(256) },
  developer: { enabled: bool },
  security: { idleLockMinutes: num(0, 120) },
};
export const isObject = (v) =>
  v !== null &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
export function mergeSettings(current, patch) {
  if (!isObject(patch)) throw Error("설정 객체가 필요합니다.");
  const out = structuredClone(current);
  for (const [section, values] of Object.entries(patch)) {
    if (!Object.hasOwn(schema, section) || !isObject(values))
      throw Error("지원하지 않는 설정 영역입니다.");
    for (const [key, value] of Object.entries(values)) {
      if (!Object.hasOwn(schema[section], key) || !schema[section][key](value))
        throw Error(`설정 값을 확인하세요: ${section}.${key}`);
      out[section][key] = value;
    }
  }
  if (out.network.wifiPort === 8840 || out.network.tlsHttpsPort === 8840)
    throw Error("8840은 맥 편집기 전용 포트입니다.");
  if (
    out.network.tlsEnabled &&
    out.network.tlsMode === "Additional" &&
    out.network.wifiPort === out.network.tlsHttpsPort
  )
    throw Error("HTTP와 HTTPS 포트는 서로 달라야 합니다.");
  return out;
}
export function loadSettings(dir) {
  const file = path.join(dir, "preferences.json");
  if (!fs.existsSync(file)) {
    const value = defaultSettings();
    writeJson(file, value);
    return value;
  }
  return mergeSettings(
    defaultSettings(),
    JSON.parse(fs.readFileSync(file, "utf8")),
  );
}
const deviceSchema = {
  language: one(
    "system",
    "ar",
    "pt-BR",
    "cs",
    "nl",
    "en",
    "fr",
    "de",
    "hi",
    "id",
    "it",
    "ja",
    "ko",
    "pl",
    "ru",
    "zh",
    "es",
    "zh-TW",
    "tr",
    "uk",
  ),
  profileId: str(80),
  startPageId: str(80),
  settingsButtonHidden: bool,
  screenSaverMinutes: num(0, 120),
  screenSaverMode: one("dim", "clock"),
  awake: bool,
  orientation: one("auto", "landscape", "portrait"),
  brightness: num(-1, 100),
  textScale: num(80, 160),
  fullscreen: bool,
  haptics: bool,
  sound: bool,
  swipeEnabled: bool,
  reducedMotion: bool,
  showHeader: bool,
  showNavigation: bool,
  rememberPage: bool,
  osNotifications: bool,
  monitorNotifications: bool,
  theme: one("system", "light", "dark"),
  fixedVibration: bool,
  vibrationMs: num(20, 200),
  dimPercent: num(5, 50),
  firstTouchWakes: bool,
  iconResolution: one(0, 128, 256, 512),
  notificationBanner: bool,
  renderMode: one("standard", "simple"),
  timeFormat: one("24h", "12h"),
  allowInsecureWifi: bool,
};
export function validateDeviceSettings(current, patch, config) {
  if (!isObject(patch)) throw Error("기기 설정 객체가 필요합니다.");
  const out = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(deviceSchema, key) || !deviceSchema[key](value))
      throw Error(`기기 설정 값을 확인하세요: ${key}`);
    out[key] = value;
  }
  if (out.profileId && !config.profiles.some((p) => p.id === out.profileId))
    throw Error("프로필을 찾을 수 없습니다.");
  const profile = config.profiles.find(
    (p) => p.id === (out.profileId || config.defaultProfileId),
  );
  if (out.startPageId && !profile?.pageIds.includes(out.startPageId)) {
    if (Object.hasOwn(patch, "startPageId"))
      throw Error("시작 페이지가 선택한 프로필에 없습니다.");
    out.startPageId = "";
  }
  return out;
}
export class Diagnostics {
  constructor(dir, getSettings) {
    this.file = path.join(dir, "diagnostics.jsonl");
    this.getSettings = getSettings;
  }
  log(level, event, fields = {}) {
    const levels = ["debug", "info", "warn", "error"];
    if (
      levels.indexOf(level) <
      levels.indexOf(this.getSettings().logging.minimumLevel)
    )
      return;
    const safe = {
      at: Date.now(),
      level,
      event: String(event)
        .replace(/[^a-z0-9_.-]/gi, "")
        .slice(0, 80),
    };
    for (const k of [
      "status",
      "durationMs",
      "count",
      "revision",
      "transport",
      "reason",
    ])
      if (
        typeof fields[k] === "number" ||
        typeof fields[k] === "boolean" ||
        (typeof fields[k] === "string" &&
          /^[a-zA-Z0-9_. -]{0,80}$/.test(fields[k]))
      )
        safe[k] = fields[k];
    try {
      if (fs.existsSync(this.file) && fs.statSync(this.file).size > 524288)
        fs.renameSync(this.file, this.file + ".1");
      fs.appendFileSync(this.file, JSON.stringify(safe) + "\n", {
        mode: 0o600,
      });
      fs.chmodSync(this.file, 0o600);
    } catch {}
  }
  entries() {
    try {
      return fs
        .readFileSync(this.file, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .slice(-500)
        .map((x) => JSON.parse(x));
    } catch {
      return [];
    }
  }
}
export function nativeStatus(dir) {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(dir, "native-status.json"), "utf8"),
    );
  } catch {
    return { available: false };
  }
}
export async function releaseInfo(fetcher = fetch) {
  const r = await fetcher(
    "https://api.github.com/repos/Yaklede/open-deck/releases/latest",
    {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "OpenDeck/" + APP_VERSION,
      },
      signal: AbortSignal.timeout(8000),
    },
  );
  if (!r.ok) throw Error("업데이트 확인 실패 (HTTP " + r.status + ")");
  const d = await r.json();
  if (
    !/^v\d+\.\d+\.\d+$/.test(d.tag_name) ||
    !String(d.html_url).startsWith(
      "https://github.com/Yaklede/open-deck/releases/",
    )
  )
    throw Error("릴리즈 정보를 확인할 수 없습니다.");
  const latestVersion = d.tag_name.slice(1);
  const newer =
    latestVersion
      .split(".")
      .reduce(
        (acc, n, i) =>
          acc || Math.sign(Number(n) - Number(APP_VERSION.split(".")[i])),
        0,
      ) > 0;
  return {
    version: APP_VERSION,
    latestVersion,
    updateAvailable: newer,
    url: d.html_url,
    publishedAt: d.published_at,
    assets: (d.assets || [])
      .filter(
        (a) =>
          [
            "Open-Deck-macOS-arm64.zip",
            "Open-Deck-Android.apk",
            "SHA256SUMS.txt",
          ].includes(a.name) &&
          String(a.browser_download_url).startsWith(
            "https://github.com/Yaklede/open-deck/releases/download/",
          ),
      )
      .map((a) => ({
        name: a.name,
        url: a.browser_download_url,
        size: a.size,
      })),
    checkedAt: Date.now(),
  };
}

export function buildInfo() {
  try {
    const value = JSON.parse(
      fs.readFileSync(new URL("./build-info.json", import.meta.url), "utf8"),
    );
    return { version: APP_VERSION, build: value.build, commit: value.commit };
  } catch {
    return { version: APP_VERSION, build: 27, commit: "development" };
  }
}
export const licenseNotices = () => ({
  licenses: [
    {
      name: "Open Deck",
      license: "MIT",
      url: "https://github.com/Yaklede/open-deck/blob/main/LICENSE",
    },
    {
      name: "Node.js",
      license: "MIT and bundled third-party licenses",
      url: "https://github.com/nodejs/node/blob/main/LICENSE",
    },
    {
      name: "ws",
      license: "MIT",
      url: "https://github.com/websockets/ws/blob/master/LICENSE",
    },
    {
      name: "Noto Sans KR",
      license: "SIL Open Font License 1.1",
      url: "https://github.com/notofonts/noto-cjk/blob/main/LICENSE",
    },
    {
      name: "Macro Deck common UI translations",
      license: "Apache-2.0; see bundled localization NOTICE",
      url: "https://github.com/Yaklede/open-deck/blob/codex/jimin-os-integration/docs/licenses/Macro-Deck-Localization-NOTICE.txt",
    },
    {
      name: "Macro Deck protocol schemas",
      license: "See bundled MacroDeck-Protocol-LICENSE and NOTICE",
      url: "https://github.com/Yaklede/open-deck/tree/main/docs/licenses",
    },
  ],
});
