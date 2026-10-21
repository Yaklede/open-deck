import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

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
  return {
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
  };
}
const types = new Set(["button", "clock", "gauges", "timer", "volume", "text"]);
const actionTypes = new Set([
  "openApp",
  "openUrl",
  "chrome",
  "command",
  "wait",
  "mute",
  "volume",
  "if",
]);
export function validateConfig(c) {
  if (
    !c ||
    c.version !== 1 ||
    !Array.isArray(c.pages) ||
    !c.pages.length ||
    c.pages.length > 20
  )
    throw Error("1~20개의 페이지가 필요합니다.");
  if (!Number.isInteger(c.columns) || c.columns < 2 || c.columns > 8)
    throw Error("열 수는 2~8입니다.");
  const ids = new Set();
  let count = 0;
  const validateActions = (actions, depth = 0) => {
    if (!Array.isArray(actions) || actions.length > 32 || depth > 4)
      throw Error("동작 단계가 너무 많습니다.");
    for (const a of actions) {
      if (!a || !actionTypes.has(a.type))
        throw Error("지원하지 않는 동작입니다.");
      if (typeof a.value === "string" && a.value.length > 8192)
        throw Error("동작 값이 너무 깁니다.");
      if (a.type === "if") {
        validateActions(a.then || [], depth + 1);
        validateActions(a.else || [], depth + 1);
      }
    }
  };
  for (const p of c.pages) {
    if (
      !p.id ||
      ids.has(p.id) ||
      typeof p.name !== "string" ||
      !Array.isArray(p.widgets) ||
      p.widgets.length > 64
    )
      throw Error("잘못된 페이지입니다.");
    ids.add(p.id);
    for (const w of p.widgets) {
      if (
        !w.id ||
        ids.has(w.id) ||
        !types.has(w.type) ||
        typeof w.label !== "string" ||
        w.label.length > 120
      )
        throw Error("잘못된 위젯입니다.");
      if (w.color && !/^#[0-9a-f]{6}$/i.test(w.color))
        throw Error("색상은 #RRGGBB 형식입니다.");
      if (
        w.type === "timer" &&
        (!Number.isFinite(w.minutes) || w.minutes < 1 || w.minutes > 1440)
      )
        throw Error("타이머는 1~1440분입니다.");
      if (w.type === "button") validateActions(w.actions || []);
      ids.add(w.id);
      count++;
    }
  }
  if (count > 256) throw Error("위젯은 최대 256개입니다.");
  if (
    c.automations &&
    (!Array.isArray(c.automations) || c.automations.length > 32)
  )
    throw Error("자동화는 최대 32개입니다.");
  for (const a of c.automations || []) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(a.time) || !ids.has(a.widgetId))
      throw Error("자동화 시간 또는 버튼이 잘못되었습니다.");
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
  return validateConfig(JSON.parse(fs.readFileSync(file, "utf8")));
}
