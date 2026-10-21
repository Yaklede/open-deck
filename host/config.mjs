import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { migrate, overlaps, themes } from "./public/layout.mjs";

export const dataDir =
  process.env.OPEN_DECK_DATA ||
  path.join(os.homedir(), "Library/Application Support/OpenDeck");
export const uid = () => crypto.randomUUID();
const button = (label, icon, color, actions) => ({
  id: uid(),
  type: "button",
  label,
  icon,
  color,
  actions,
});
export function defaultConfig() {
  return migrate({
    version: 1,
    name: "Open Deck",
    columns: 4,
    pages: [
      {
        id: "home",
        name: "Workspace",
        widgets: [
          button("업무 시작", "power", "#aaa0ff", [
            { type: "openApp", value: "/Applications/Safari.app" },
          ]),
          { id: uid(), type: "clock", label: "WORKSPACE", color: "#81b6ff" },
          { id: uid(), type: "gauges", label: "Mac · LIVE", color: "#ad9bff" },
          {
            id: uid(),
            type: "timer",
            label: "집중 · 25분",
            minutes: 25,
            color: "#81a8ff",
          },
          button("브라우저", "globe", "#83b7ff", [
            { type: "openApp", value: "/Applications/Safari.app" },
          ]),
          button("메일", "mail", "#ff9f8c", [
            { type: "openApp", value: "/System/Applications/Mail.app" },
          ]),
          button("메모", "note", "#f5c66a", [
            { type: "openApp", value: "/System/Applications/Notes.app" },
          ]),
          button("음악", "music", "#78d2a6", [
            { type: "openApp", value: "/System/Applications/Music.app" },
          ]),
          { id: uid(), type: "volume", label: "Mac 음량", color: "#83b7ff" },
          button("음소거 전환", "volume", "#8fc9ff", [{ type: "mute" }]),
        ],
      },
    ],
    automations: [],
  });
}
const types = new Set([
  "button",
  "clock",
  "gauges",
  "timer",
  "volume",
  "text",
  "toggle",
  "slider",
  "graph",
  "calendar",
  "todo",
  "image",
  "spacer",
  "page",
  "agenda",
  "inbox",
  "notification-feed",
]);
const actionTypes = new Set([
  "openApp",
  "openUrl",
  "chrome",
  "command",
  "wait",
  "mute",
  "volume",
  "if",
  "setVariable",
  "increment",
  "toggleVariable",
  "http",
  "plugin",
  "extension",
]);
const color = (v) => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
const integer = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const plain = (v) =>
  v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
export function validateConfig(input) {
  const c = migrate(input);
  delete c.assets;
  if (!Array.isArray(c.pages) || !c.pages.length || c.pages.length > 40)
    throw Error("1~40개의 페이지가 필요합니다.");
  if (!integer(c.columns, 2, 12)) throw Error("열 수는 2~12입니다.");
  c.extensions ??= {};
  if (
    !plain(c.extensions) ||
    Object.keys(c.extensions).some((k) => k !== "jimin-os")
  )
    throw Error("지원하지 않는 연결입니다.");
  const os = c.extensions["jimin-os"];
  if (
    os &&
    (!plain(os) ||
      (os.enabled !== undefined && typeof os.enabled !== "boolean") ||
      (os.notifications !== undefined &&
        typeof os.notifications !== "boolean") ||
      !integer(os.reminderMinutes ?? 10, 1, 120))
  )
    throw Error("Jimin OS 알림 설정을 확인하세요.");
  const ids = new Set(),
    pageIds = new Set(c.pages.map((p) => p.id));
  let count = 0;
  const validateActions = (actions, depth = 0) => {
    if (!Array.isArray(actions) || actions.length > 32 || depth > 4)
      throw Error("동작 단계가 너무 많습니다.");
    for (const a of actions) {
      if (!a || !actionTypes.has(a.type))
        throw Error("지원하지 않는 동작입니다.");
      if (typeof a.value === "string" && a.value.length > 8192)
        throw Error("동작 값이 너무 깁니다.");
      if (
        a.type === "plugin" &&
        (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/.test(a.pluginId) ||
          typeof a.actionId !== "string" ||
          a.actionId.length > 128 ||
          !plain(a.parameters || {}) ||
          JSON.stringify(a.parameters || {}).length > 16384)
      )
        throw Error("플러그인 동작 정보를 확인하세요.");
      if (
        a.type === "extension" &&
        (a.extensionId !== "jimin-os" ||
          !["navigate", "refresh"].includes(a.operation) ||
          !plain(a.parameters || {}))
      )
        throw Error("Jimin OS 동작을 확인하세요.");
      if (a.type === "if") {
        validateActions(a.then || [], depth + 1);
        validateActions(a.else || [], depth + 1);
      }
      if (
        ["setVariable", "increment", "toggleVariable"].includes(a.type) &&
        !Object.hasOwn(c.variables, a.variable)
      )
        throw Error("등록된 변수를 선택하세요.");
      if (a.type === "increment" && typeof c.variables[a.variable] !== "number")
        throw Error("증감에는 숫자 변수를 선택하세요.");
      if (
        a.type === "toggleVariable" &&
        typeof c.variables[a.variable] !== "boolean"
      )
        throw Error("토글에는 Boolean 변수를 선택하세요.");
      if (
        a.type === "setVariable" &&
        typeof c.variables[a.variable] !== typeof a.value
      )
        throw Error("변수 값의 형식이 다릅니다.");
      if (
        a.type === "http" &&
        !c.integrations.some((i) => i.id === a.integrationId)
      )
        throw Error("등록된 연동을 선택하세요.");
    }
  };
  if (!plain(c.variables) || Object.keys(c.variables).length > 128)
    throw Error("변수는 최대 128개입니다.");
  for (const [k, v] of Object.entries(c.variables)) {
    if (
      !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(k) ||
      !["string", "boolean", "number"].includes(typeof v) ||
      (typeof v === "string" && v.length > 2048) ||
      (typeof v === "number" && !Number.isFinite(v))
    )
      throw Error("변수 이름 또는 값이 잘못되었습니다.");
  }
  if (!Array.isArray(c.integrations) || c.integrations.length > 32)
    throw Error("연동은 최대 32개입니다.");
  const integrationIds = new Set();
  for (const i of c.integrations) {
    if (
      !/^[a-zA-Z0-9_-]{1,80}$/.test(i.id) ||
      integrationIds.has(i.id) ||
      i.type !== "http" ||
      typeof i.name !== "string"
    )
      throw Error("잘못된 연동입니다.");
    integrationIds.add(i.id);
    let u;
    try {
      u = new URL(i.url);
    } catch {
      throw Error("연동 URL을 확인하세요.");
    }
    if (
      !["http:", "https:"].includes(u.protocol) ||
      u.username ||
      u.password ||
      i.url.length > 2048
    )
      throw Error("HTTP/HTTPS 주소가 필요합니다.");
    if (!integer(i.intervalSeconds ?? 60, 5, 86400))
      throw Error("갱신 주기는 5~86400초입니다.");
    if (i.variable && !Object.hasOwn(c.variables, i.variable))
      throw Error("연동의 저장 변수를 선택하세요.");
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(i.method || "GET"))
      throw Error("HTTP 메서드를 확인하세요.");
    if (i.body && String(i.body).length > 8192)
      throw Error("요청 본문이 너무 큽니다.");
  }
  for (const p of c.pages) {
    if (
      !p.id ||
      ids.has(p.id) ||
      typeof p.name !== "string" ||
      p.name.length > 80 ||
      !Array.isArray(p.widgets) ||
      p.widgets.length > 128
    )
      throw Error("잘못된 페이지입니다.");
    ids.add(p.id);
    if (
      !integer(p.columns, 2, 12) ||
      !integer(p.rows, 1, 64) ||
      !integer(p.gap, 0, 32) ||
      !integer(p.radius, 0, 40) ||
      !themes[p.theme]
    )
      throw Error("페이지 배치 값을 확인하세요.");
    if (
      (p.background && !color(p.background)) ||
      (p.gradient && !color(p.gradient))
    )
      throw Error("배경색을 확인하세요.");
    if (p.backgroundImage && !/^[a-f0-9]{64}$/.test(p.backgroundImage))
      throw Error("배경 이미지가 잘못되었습니다.");
    if (
      p.portrait &&
      (!integer(p.portrait.columns, 2, 12) || !integer(p.portrait.rows, 1, 64))
    )
      throw Error("세로 배치를 확인하세요.");
    if (p.parentId && !pageIds.has(p.parentId))
      throw Error("상위 페이지가 없습니다.");
    let parent = p,
      seen = new Set([p.id]);
    while (parent.parentId) {
      if (seen.has(parent.parentId)) throw Error("페이지 계층이 순환합니다.");
      seen.add(parent.parentId);
      parent = c.pages.find((x) => x.id === parent.parentId);
    }
    const boxes = [];
    for (const w of p.widgets) {
      if (
        !w.id ||
        ids.has(w.id) ||
        !types.has(w.type) ||
        typeof w.label !== "string" ||
        w.label.length > 120
      )
        throw Error("잘못된 위젯입니다.");
      ids.add(w.id);
      count++;
      if (
        !integer(w.x, 0, 11) ||
        !integer(w.y, 0, 63) ||
        !integer(w.w, 1, 12) ||
        !integer(w.h, 1, 12) ||
        w.x + w.w > p.columns ||
        w.y + w.h > p.rows ||
        boxes.some((b) => overlaps(b, w))
      )
        throw Error("위젯 배치가 겹치거나 페이지를 벗어납니다.");
      boxes.push(w);
      if (w.provider && w.provider !== "jimin-os")
        throw Error("지원하지 않는 연결입니다.");
      if (w.color && !color(w.color)) throw Error("색상은 #RRGGBB 형식입니다.");
      if (!plain(w.style)) throw Error("잘못된 스타일입니다.");
      for (const k of ["background", "textColor", "borderColor"])
        if (w.style[k] && !color(w.style[k]))
          throw Error("스타일 색상을 확인하세요.");
      for (const [k, min, max] of [
        ["textSize", 9, 36],
        ["iconSize", 10, 65],
        ["borderWidth", 0, 5],
        ["opacity", 20, 100],
      ])
        if (w.style[k] !== undefined && !integer(w.style[k], min, max))
          throw Error("스타일 크기를 확인하세요.");
      if (
        (w.style.labelPosition &&
          !["top", "center", "bottom", "hidden"].includes(
            w.style.labelPosition,
          )) ||
        (w.style.align &&
          !["left", "center", "right"].includes(w.style.align)) ||
        (w.style.font && !["sans", "mono", "serif"].includes(w.style.font))
      )
        throw Error("글자 스타일을 확인하세요.");
      if (w.image && !/^[a-f0-9]{64}$/.test(w.image))
        throw Error("이미지를 확인하세요.");
      if (
        w.type === "timer" &&
        (!Number.isFinite(w.minutes) || w.minutes < 1 || w.minutes > 1440)
      )
        throw Error("타이머는 1~1440분입니다.");
      if (w.type === "page" && !pageIds.has(w.targetPage))
        throw Error("이동할 페이지를 선택하세요.");
      if (
        w.binding &&
        !Object.hasOwn(c.variables, w.binding) &&
        !["cpu", "memory", "volume"].includes(w.binding) &&
        !/^plugin_[a-f0-9]{10}_[A-Za-z0-9_]{1,40}$/.test(w.binding)
      )
        throw Error("등록된 변수를 선택하세요.");
      if (
        ["toggle", "slider"].includes(w.type) &&
        typeof c.variables[w.binding] !==
          (w.type === "toggle" ? "boolean" : "number")
      )
        throw Error("토글은 Boolean, 슬라이더는 숫자 변수에 연결하세요.");
      if (
        w.type === "slider" &&
        (!Number.isFinite(w.min) || !Number.isFinite(w.max) || w.min >= w.max)
      )
        throw Error("슬라이더 범위를 확인하세요.");
      validateActions(w.actions || []);
      validateActions(w.longActions || []);
      validateActions(w.doubleActions || []);
    }
  }
  if (count > 1024) throw Error("위젯은 최대 1024개입니다.");
  if (
    c.automations &&
    (!Array.isArray(c.automations) || c.automations.length > 64)
  )
    throw Error("자동화는 최대 64개입니다.");
  for (const a of c.automations || []) {
    if (
      !c.pages
        .flatMap((p) => p.widgets)
        .some((w) => w.id === a.widgetId && w.type === "button")
    )
      throw Error("자동화 버튼을 선택하세요.");
    if (!a.trigger || a.trigger === "time") {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(a.time))
        throw Error("자동화 시간을 확인하세요.");
    } else if (a.trigger === "variable") {
      if (!Object.hasOwn(c.variables, a.variable))
        throw Error("자동화 변수를 선택하세요.");
      if (
        a.equals !== undefined &&
        typeof a.equals !== typeof c.variables[a.variable]
      )
        throw Error("조건 값의 형식을 확인하세요.");
    } else if (a.trigger === "plugin") {
      if (
        typeof a.pluginId !== "string" ||
        typeof a.eventId !== "string" ||
        a.eventId.length > 128
      )
        throw Error("플러그인 이벤트를 확인하세요.");
    } else throw Error("지원하지 않는 자동화 조건입니다.");
    if (
      a.cooldownSeconds !== undefined &&
      !integer(a.cooldownSeconds, 1, 86400)
    )
      throw Error("재실행 간격을 확인하세요.");
    if (
      a.days &&
      (!Array.isArray(a.days) || !a.days.every((d) => integer(d, 0, 6)))
    )
      throw Error("요일을 확인하세요.");
  }
  return c;
}
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
  fs.chmodSync(file, 0o600);
}
export function loadConfig(dir = dataDir) {
  const file = path.join(dir, "deck.json");
  if (!fs.existsSync(file)) writeJson(file, defaultConfig());
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const config = validateConfig(raw);
  if (raw.version === 1) {
    const backup = path.join(dir, "deck-before-v2.json");
    if (!fs.existsSync(backup)) writeJson(backup, raw);
    writeJson(file, config);
  }
  return config;
}
