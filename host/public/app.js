import { t, tf, localizedObject, locale as uiLocale, translateError } from "./i18n.mjs";
import {
  ensureEditorUnlocked,
  showEditorLock,
  showAccountLogin,
  startEditorLockMonitor,
} from "./editor-lock.mjs";
import { effectivePages } from "./profiles.mjs";
import { createSettingsCenter, applyAppearanceVariables } from "./settings-ui.mjs";
import {
  activeProfile,
  profilePages,
  clonePages,
  portableProfile,
  importProfile,
} from "./profile-tools.mjs";
import { migrate, place, overlaps, themes } from "./layout.mjs";
import { monitorPage } from "./monitor-layout.mjs";
import { monitorSettings, monitorRuleNames } from "./monitor-rules.mjs";
const $ = (s) => document.querySelector(s),
  uid = () => crypto.randomUUID();
let config,
  pageId,
  profileId,
  selected = null,
  dirty = false,
  info,
  state = { cpu: 0, memory: 0, volume: 50 },
  portrait = false,
  pluginItems = [];
const selectedWidgets = new Set();
let widgetClipboard = [],
  styleClipboard;
let renderedWidgets = new Map(),
  renderedTheme = themes.midnight;
const undo = [],
  redo = [];
let lastEdit = 0;
const paths = {
  mic: "M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0z M5 10v2a7 7 0 0 0 14 0v-2 M12 19v4 M8 23h8",
  refresh: "M20 8a9 9 0 1 0 1 7 M20 2v6h-6",
  calendar: "M3 5h18v16H3z M3 10h18 M8 2v6 M16 2v6",
  clock: "M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18 M12 6v6l4 2",
  power: "M12 2v9 M6 5a9 9 0 1 0 12 0",
  globe:
    "M3 12h18 M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18 M12 3c-5 5-5 13 0 18c5-5 5-13 0-18",
  monitor: "M3 4h18v13H3z M8 21h8 M12 17v4",
  tasks: "M8 6h12 M8 12h12 M8 18h12 M2 5l2 2l2-3 M2 11l2 2l2-3 M2 17l2 2l2-3",
  mail: "M3 5h18v14H3z M3 5l9 8l9-8",
  chat: "M3 3h18v14H9l-6 4z",
  spark: "M13 2L4 14h7l-1 8l10-13h-8z",
  link: "M10 14l4-4 M8 16l-2 2a4 4 0 0 1-5-5l5-5a4 4 0 0 1 5 0 M16 8l2-2a4 4 0 0 0-5-5l-2 2 M13 16a4 4 0 0 0 5 0l5-5",
  code: "M8 6l-6 6l6 6 M16 6l6 6l-6 6 M14 3l-4 18",
  note: "M5 3h14v18H5z M8 8h8 M8 12h8 M8 16h5",
  music: "M9 18V5l11-2v13 M9 5v4l11-2 M9 18a3 3 0 1 1-3-3 M20 16a3 3 0 1 1-3-3",
  volume: "M3 9h4l5-5v16l-5-5H3z M16 8a6 6 0 0 1 0 8 M19 5a10 10 0 0 1 0 14",
};
const names = localizedObject({
  button: "동작 버튼",
  clock: "시계",
  gauges: "CPU · 메모리",
  system: "맥 시스템 상태",
  grafana: "Grafana 대시보드",
  timer: "집중 타이머",
  volume: "Mac 음량",
  text: "텍스트",
  toggle: "토글",
  slider: "슬라이더",
  graph: "기록 그래프",
  calendar: "달력",
  agenda: "OS 일정 목록",
  inbox: "OS 업무 요청",
  "notification-feed": "OS 알림",
  todo: "할 일",
  image: "이미지",
  spacer: "빈 공간",
  page: "페이지 이동",
});
const kinds = localizedObject({
  openApp: "앱 실행",
  openUrl: "웹 주소",
  chrome: "Chrome 프로필 / 기존 탭",
  command: "셸 명령",
  wait: "기다리기 (ms)",
  mute: "Mac 음소거",
  volume: "Mac 음량",
  setVariable: "변수 설정",
  increment: "변수 증감",
  toggleVariable: "변수 토글",
  http: "HTTP 연동 실행",
  plugin: "플러그인 동작",
  extension: "Jimin OS 열기",
  if: "조건 분기 (JSON)",
});
const n = (tag, text, cls) => {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
};
const editorLocale = () =>
  uiLocale();
const editorHour12 = () => document.body.dataset.timeFormat === "12h";
const page = () => config.pages.find((p) => p.id === pageId) || config.pages[0],
  widget = () => page().widgets.find((w) => w.id === selected);
function notice(t, error = false) {
  $("#notice").textContent = t;
  $("#notice").style.color = error ? "#ffa4a4" : "#8fd7b6";
}
async function api(url, method = "GET", body) {
  const r = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json();
  if (r.status === 401 && d.code === "ACCOUNT_LOGIN_REQUIRED") showAccountLogin();
  if (r.status === 423 && d.code !== "VAULT_LOCKED") showEditorLock();
  if (!r.ok) throw Error(translateError(d.error || r.statusText));
  return d;
}
function checkpoint() {
  if (Date.now() - lastEdit > 500) {
    undo.push(JSON.stringify(config));
    if (undo.length > 40) undo.shift();
    redo.length = 0;
  }
  lastEdit = Date.now();
}
function changed() {
  dirty = true;
  $("#saved").textContent = t("저장하지 않은 변경");
  $("#save").textContent = t("변경 저장 ·");
  $("#undo").disabled = !undo.length;
  $("#redo").disabled = !redo.length;
}
function change(fn, full = false) {
  checkpoint();
  fn();
  changed();
  full ? render() : renderBoard();
}
function history(from, to) {
  if (!from.length) return;
  to.push(JSON.stringify(config));
  config = JSON.parse(from.pop());
  lastEdit = 0;
  selected = null;
  changed();
  render();
}
function icon(name) {
  const e = n("div", undefined, "symbol");
  e.innerHTML = `<svg viewBox="0 0 24 24"><path d="${paths[name] || paths.monitor}"/></svg>`;
  return e;
}
function labelText(t) {
  return String(t || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) =>
    String(state.variables?.[k] ?? state[k] ?? "—"),
  );
}
function field(
  parent,
  title,
  value,
  onchange,
  { type = "text", min, max, choices, placeholder } = {},
) {
  const l = n("label", title),
    e = n(choices ? "select" : "input");
  if (choices)
    for (const [v, t] of Object.entries(choices)) {
      const o = n("option", t);
      o.value = v;
      e.append(o);
    }
  else e.type = type;
  if (type === "checkbox") e.checked = !!value;
  else e.value = value ?? "";
  if (min !== undefined) e.min = min;
  if (max !== undefined) e.max = max;
  if (placeholder) e.placeholder = placeholder;
  e.onchange = () =>
    onchange(
      type === "checkbox"
        ? e.checked
        : type === "number" || type === "range"
          ? Number(e.value)
          : e.value,
    );
  l.append(e);
  parent.append(l);
  return e;
}
function button(parent, title, fn, cls = "") {
  const b = n("button", title, cls);
  b.type = "button";
  b.onclick = fn;
  parent.append(b);
  return b;
}
function ensurePlace() {
  page().rows = place(page().widgets, page().columns, page().rows, true);
}
function render() {
  renderProfiles();
  for (const id of selectedWidgets)
    if (!page().widgets.some((w) => w.id === id)) selectedWidgets.delete(id);
  $("#pages").replaceChildren(
    ...profilePages(config, profileId).map((p) => {
      const b = n(
        "button",
        (p.parentId ? "　" : "") + "▦ " + p.name,
        p.id === pageId ? "selected" : "",
      );
      b.onclick = () => {
        pageId = p.id;
        selected = null;
        selectedWidgets.clear();
        render();
      };
      return b;
    }),
  );
  $("#pageTitle").textContent = page().name;
  $("#columns").value = page().columns;
  $("#rows").value = page().rows;
  $("#inspector").hidden = !selected;
  if (selected) inspect();
  pageSettings();
  renderBoard();
  automations();
  variables();
  connectors();
  renderPlugins();
  renderEcosystem();
}
function renderBoard() {
  const p = effectivePages(config).find((p) => p.id === pageId) || page(),
    theme = themes[p.theme] || themes.midnight,
    b = $("#board");
  let items = structuredClone(p.widgets),
    cols = p.columns,
    rows = p.rows;
  if (portrait) {
    cols = p.portrait?.columns || Math.min(2, cols);
    rows = place(items, cols, p.portrait?.rows || 1, false);
  }
  b.style.gridTemplateColumns = `repeat(${cols},minmax(0,1fr))`;
  b.style.gridTemplateRows = `repeat(${rows},minmax(0,1fr))`;
  b.style.aspectRatio = portrait ? "9 / 14" : "16 / 9";
  b.style.gap = p.gap + "px";
  b.style.padding = p.gap + "px";
  b.style.background = p.gradient
    ? `linear-gradient(135deg,${p.background || theme.background},${p.gradient})`
    : p.background || theme.background;
  if (p.backgroundImage) {
    b.style.backgroundImage = `url('/api/assets/${p.backgroundImage}')`;
    b.style.backgroundSize = "cover";
    b.style.backgroundPosition = "center";
  }
  renderedTheme = theme;
  renderedWidgets = new Map(items.map((w) => [w.id, w]));
  b.replaceChildren(
    ...items.map((w) => {
      const s = w.style || {},
        c = n(
          "div",
          undefined,
          "card" +
            (selected === w.id || selectedWidgets.has(w.id)
              ? " selected"
              : "") +
            (w.type === "spacer" ? " spacer" : ""),
        );
      c.tabIndex = 0;
      c.setAttribute("role", "button");
      c.setAttribute("aria-label", w.label + t(" 편집"));
      c.dataset.widgetId = w.id;
      c.dataset.type = w.type;
      c.draggable = !portrait && !w.inheritedPin;
      c.style.gridColumn = `${w.x + 1} / span ${w.w}`;
      c.style.gridRow = `${w.y + 1} / span ${w.h}`;
      c.style.background = s.background || theme.surface;
      c.style.color = w.color || theme.accent;
      c.style.border = `${s.borderWidth ?? (w.type === "button" || w.type === "page" ? 1 : 0)}px solid ${s.borderColor || w.color || theme.accent}`;
      c.style.borderRadius = p.radius + "px";
      c.style.opacity = (s.opacity ?? 100) / 100;
      c.style.boxShadow = p.shadow === false ? "none" : "0 4px 10px #0002";
      c.style.setProperty("--label-color", s.textColor || theme.text);
      c.style.setProperty("--label-size", (s.textSize || 17) + "px");
      c.style.setProperty("--icon-size", (s.iconSize || 32) + "%");
      c.dataset.position = s.labelPosition || "bottom";
      c.dataset.align = s.align || "center";
      c.dataset.font = s.font || "sans";
      const body = n("div", undefined, "tile-content");
      if (w.image && ["button", "page", "image"].includes(w.type)) {
        const img = n("img");
        img.src = "/api/assets/" + w.image;
        img.alt = "";
        img.className = "tile-image";
        img.style.objectFit = w.type === "image" ? "cover" : "contain";
        body.append(img);
      } else if (["button", "page"].includes(w.type)) body.append(icon(w.icon));
      else if (w.type === "clock") body.append(n("div", "—", "clock"));
      else if (w.type === "gauges") body.append(n("div", "—", "gauges"));
      else if (["system", "grafana"].includes(w.type))
        body.append(n("div", "—", "system-reading"));
      else if (w.type === "timer") body.append(n("div", "25:00", "clock"));
      else if (w.type === "volume" || w.type === "slider") {
        const bar = n("input");
        bar.type = "range";
        bar.disabled = true;
        body.append(bar, n("div", "—", "reading"));
      } else if (w.type === "toggle")
        body.append(n("div", "○", "toggle-reading"));
      else if (w.type === "calendar")
        body.append(n("div", "—", "calendar-reading"));
      else if (["agenda", "inbox", "notification-feed"].includes(w.type))
        body.append(n("div", t("연결을 기다리고 있어요."), "os-reading"));
      else if (w.type === "todo")
        body.append(n("div", t("할 일을 태블릿에서 추가하세요."), "todo-reading"));
      else if (w.type === "graph") {
        const plot = n("div", undefined, "graph-bars");
        for (let i = 0; i < 40; i++) plot.append(n("i"));
        body.append(plot);
      }
      c.append(body, n("div", labelText(w.label), "label"));
      const resize = n("button", "↘", "resize-handle");
      resize.setAttribute("aria-label", t("크기 조절"));
      if (!portrait && !w.inheritedPin) {
        c.append(resize);
        resize.onpointerdown = (e) => resizeStart(e, c, w);
      }
      c.onclick = (e) => {
        if (e.target === resize) return;
        if (w.inheritedPin) {
          pageId = w.sourcePageId;
          profileId = config.profiles.find((p) =>
            p.pageIds.includes(pageId),
          )?.id;
          selected = w.id;
          selectedWidgets.clear();
          selectedWidgets.add(w.id);
          render();
          notice(t("고정 위젯의 원본 페이지에서 편집합니다."));
          return;
        }
        if (e.shiftKey || e.metaKey || e.ctrlKey) {
          if (selectedWidgets.has(w.id)) selectedWidgets.delete(w.id);
          else selectedWidgets.add(w.id);
        } else {
          selectedWidgets.clear();
          selectedWidgets.add(w.id);
        }
        selected = selectedWidgets.has(w.id)
          ? w.id
          : selectedWidgets.values().next().value || null;
        $("#inspector").hidden = !selected;
        inspect();
        document
          .querySelectorAll(".card.selected")
          .forEach((e) => e.classList.remove("selected"));
        document
          .querySelectorAll(".card")
          .forEach((card) =>
            card.classList.toggle(
              "selected",
              selectedWidgets.has(card.dataset.widgetId),
            ),
          );
        updateSelection();
      };
      c.onkeydown = (e) => {
        if (
          ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key) &&
          !portrait &&
          !w.inheritedPin
        ) {
          e.preventDefault();
          const real = page().widgets.find((x) => x.id === w.id),
            next = { ...real };
          if (e.altKey) {
            next.w = Math.max(
              1,
              next.w +
                (e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0),
            );
            next.h = Math.max(
              1,
              next.h +
                (e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0),
            );
          } else {
            next.x +=
              e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
            next.y += e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
          }
          move(real, next);
        }
      };
      c.ondragstart = (e) => {
        selected = w.id;
        e.dataTransfer.setData("text/plain", w.id);
      };
      return c;
    }),
  );
  if (p.showEmptyCells)
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < cols; x++)
        if (
          !items.some(
            (w) => x >= w.x && x < w.x + w.w && y >= w.y && y < w.y + w.h,
          )
        ) {
          const empty = n("div", undefined, "empty-grid-cell");
          empty.style.gridColumn = String(x + 1);
          empty.style.gridRow = String(y + 1);
          empty.setAttribute("aria-hidden", "true");
          b.append(empty);
        }
  updateLive();
  updateSelection();
}
function move(w, next) {
  const p = page();
  if (
    next.x < 0 ||
    next.y < 0 ||
    next.x + next.w > p.columns ||
    next.y + next.h > p.rows ||
    p.widgets.some((x) => x.id !== w.id && overlaps(x, next))
  )
    return notice(t("빈 공간에 배치하세요. 위젯은 서로 겹칠 수 없습니다."), true);
  change(() => Object.assign(w, next));
  if (selected) inspect();
}
function resizeStart(e, card, w) {
  e.preventDefault();
  e.stopPropagation();
  const startX = e.clientX,
    startY = e.clientY,
    rect = $("#board").getBoundingClientRect(),
    p = page(),
    sx = (rect.width - p.gap) / p.columns,
    sy = (rect.height - p.gap) / p.rows;
  let next = { ...w };
  const handle = e.target;
  handle.setPointerCapture(e.pointerId);
  handle.onpointermove = (v) => {
    next = {
      ...w,
      w: Math.min(
        p.columns - w.x,
        Math.max(1, w.w + Math.round((v.clientX - startX) / sx)),
      ),
      h: Math.min(
        p.rows - w.y,
        Math.max(1, w.h + Math.round((v.clientY - startY) / sy)),
      ),
    };
    card.style.gridColumn = `${next.x + 1} / span ${next.w}`;
    card.style.gridRow = `${next.y + 1} / span ${next.h}`;
  };
  handle.onpointerup = () => {
    handle.onpointermove = null;
    handle.onpointerup = null;
    move(
      page().widgets.find((x) => x.id === w.id),
      next,
    );
    renderBoard();
  };
}
$("#board").ondragover = (e) => e.preventDefault();
$("#board").ondrop = (e) => {
  e.preventDefault();
  if (portrait) return;
  const p = page(),
    id = e.dataTransfer.getData("text/plain"),
    w = p.widgets.find((x) => x.id === id);
  if (!w) return;
  const r = $("#board").getBoundingClientRect();
  move(w, {
    ...w,
    x: Math.min(
      p.columns - w.w,
      Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * p.columns)),
    ),
    y: Math.min(
      p.rows - w.h,
      Math.max(0, Math.floor(((e.clientY - r.top) / r.height) * p.rows)),
    ),
  });
};
function updateLive() {
  if (!config) return;
  const ws = renderedWidgets;
  for (const c of $("#board").children) {
    const w = ws.get(c.dataset.widgetId);
    if (!w) continue;
    const value = state.variables?.[w.binding] ?? state[w.binding] ?? 0;
    const active = Boolean(
        w.stateVariable && state.variables?.[w.stateVariable] === true,
      ),
      theme = renderedTheme;
    const activeStyle = active
      ? { ...(w.style || {}), ...(w.activeStyle || {}) }
      : w.style || {};
    c.querySelector(".label").textContent = labelText(
      active && w.activeLabel ? w.activeLabel : w.label,
    );
    c.style.background = activeStyle.background || theme.surface;
    c.style.setProperty("--label-color", activeStyle.textColor || theme.text);
    c.style.borderColor = activeStyle.borderColor || w.color || theme.accent;
    if (c.dataset.active !== String(active)) {
      c.dataset.active = String(active);
      const symbol = c.querySelector(".symbol");
      if (symbol) {
        const replacement = icon(
          active && w.activeIcon ? w.activeIcon : w.icon,
        );
        symbol.replaceWith(replacement);
      }
    }
    if (w.type === "clock")
      c.querySelector(".clock").textContent = new Date().toLocaleTimeString(
        editorLocale(),
        { hour: "2-digit", minute: "2-digit", hour12: editorHour12() },
      );
    if (w.type === "system") {
      const target = c.querySelector(".system-reading"),
        s = state.system;
      if (!s || s.status !== "connected")
        target.textContent = t("맥 상태 연결 대기");
      else {
        const bytes = (v) =>
          typeof v === "number"
            ? v >= 1073741824
              ? (v / 1073741824).toFixed(1) + " GiB"
              : (v / 1048576).toFixed(1) + " MiB"
            : "—";
        target.style.whiteSpace = "pre-line";
        target.textContent =
          w.metric === "cpu"
            ? "CPU " + (s.cpu?.percent?.toFixed(1) ?? "—") + "%"
            : w.metric === "memory"
              ? bytes(s.memory?.usedBytes) +
                " / " +
                bytes(s.memory?.totalBytes) +
                t("\n메모리 압력 ") +
                ({ normal: t("정상"), warning: t("주의"), critical: t("높음") }[
                  s.memory?.pressure
                ] || t("확인 중"))
              : w.metric === "disk"
                ? t("여유 ") + bytes(s.disk?.availableBytes)
                : w.metric === "network"
                  ? "↓ " +
                    bytes(s.network?.rxBytesPerSecond) +
                    "/s\n↑ " +
                    bytes(s.network?.txBytesPerSecond) +
                    "/s"
                  : w.metric === "power"
                    ? (s.power?.batteryPercent ?? "—") +
                      "% · " +
                      ({
                        normal: t("발열 정상"),
                        fair: t("발열 약간 높음"),
                        serious: t("발열 높음"),
                        critical: t("발열 매우 높음"),
                      }[s.power?.thermal] || t("확인 중"))
                    : w.metric === "processes"
                      ? (s.processes?.cpu || [])
                          .slice(0, 3)
                          .map(
                            (p) =>
                              p.name + " · " + p.cpuPercent.toFixed(1) + "%",
                          )
                          .join("\n") || t("앱 사용량 비교 중")
                      : (s.model || t("내 Mac")) + t("\n실시간 시스템 상태");
      }
    }
    if (w.type === "grafana") {
      const p =
          w.projects?.find((p) => p.value === w.defaultProject) ||
          w.projects?.[0],
        data = state.grafana?.widgets?.[w.id]?.projects?.[p?.value];
      const disconnected = !state.at || Date.now() - state.at >= 8000;
      const pct = (v) => (v == null ? t("수집 없음") : v.toFixed(1) + "%");
      c.querySelector(".system-reading").textContent =
        (p?.label || t("프로젝트 선택")) +
        "\n" +
        (data?.status === "ready" && !disconnected
          ? w.metric === "system"
            ? t("시스템 CPU ") +
              pct(data.system?.value) +
              t("\n지표 수집 ") +
              (data.collection?.healthy ?? 0) +
              "/" +
              (data.collection?.total ?? 0)
            : (data.database?.nodes?.length
                ? data.database.nodes
                    .slice(0, 5)
                    .map(
                      (node) =>
                        node.name +
                        "  CPU " +
                        pct(node.cpuPercent) +
                        "  MEM " +
                        pct(node.memoryPercent) +
                        " · " +
                        (node.memoryUsedBytes == null
                          ? "—"
                          : (node.memoryUsedBytes / 1073741824).toFixed(1) +
                            " GiB"),
                    )
                    .join("\n")
                : t("DB 노드 지표 수집 없음")) +
              t("\n전체 TPS ") +
              (data.tps.value == null ? "—" : data.tps.value.toFixed(2)) +
              t(" · 전체 QPS ") +
              (data.qps?.value == null ? "—" : data.qps.value.toFixed(2)) +
              t(" · DB 연결 ") +
              (data.database?.connections == null
                ? "—"
                : data.database.connections.toFixed(0))
          : disconnected
            ? t("연결 끊김 · 자동 재연결 중")
            : data?.message || t("지표 조회 대기"));
      const key = w.metric === "system" ? "system" : "cpu",
        source = data?.freshness?.[key];
      const at = source?.sampleAt || source?.lastSampleAt;
      const stamp = at
        ? new Date(at).toLocaleTimeString(editorLocale(), {
            hour12: editorHour12(),
            timeZone: "Asia/Seoul",
          })
        : t("확인 불가");
      const age = at ? Math.max(0, Math.floor((Date.now() - at) / 1000)) : null;
      c.querySelector(".system-reading").textContent +=
        t("\n원본 수집 ") +
        stamp +
        (age == null ? "" : " · " + age + t("초 전")) +
        (source?.status === "delayed"
          ? t(" · 수집 지연")
          : source?.status === "stale"
            ? t(" · 오래된 데이터")
            : "");
      c.classList.toggle(
        "data-stale",
        disconnected ||
          data?.status !== "ready" ||
          ["delayed", "stale", "missing"].includes(source?.status),
      );
      c.querySelector(".system-reading").style.whiteSpace = "pre-line";
    }
    if (w.type === "gauges")
      c.querySelector(".gauges").textContent =
        `${state.cpu ?? 0}% / ${state.memory ?? 0}%`;
    if (w.type === "timer") {
      const t = state.timers?.[w.id],
        sec = Math.ceil(
          (t
            ? t.running
              ? Math.max(0, t.end - Date.now())
              : t.remaining
            : w.minutes * 60000) / 1000,
        );
      c.querySelector(".clock").textContent =
        `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
    }
    if (["volume", "slider"].includes(w.type)) {
      const v = w.type === "volume" ? (state.volume ?? 50) : value;
      const input = c.querySelector("input");
      input.min = w.min ?? 0;
      input.max = w.max ?? 100;
      input.value = v;
      c.querySelector(".reading").textContent = String(v);
    }
    if (w.type === "text" && w.binding)
      c.querySelector(".label").textContent = String(value);
    if (w.type === "toggle")
      c.querySelector(".toggle-reading").textContent = value
        ? t("● 켜짐")
        : t("○ 꺼짐");
    if (w.type === "calendar" && !w.provider)
      c.querySelector(".calendar-reading").textContent =
        new Date().toLocaleDateString(editorLocale(), {
          month: "long",
          day: "numeric",
          weekday: "long",
        });
    if (w.provider === "jimin-os") {
      const provider = state.extensions?.["jimin-os"],
        data = provider?.data;
      const target = c.querySelector(".os-reading,.calendar-reading");
      if (target) {
        if (!data) target.textContent = t("Jimin OS 연결을 기다리고 있어요.");
        else if (w.type === "inbox")
          target.textContent =
            tf("새 업무 요청 {0} · 업데이트 {1}\n", data.counts.requests, data.counts.updates) +
            data.inbox
              .slice(0, 3)
              .map((x) => x.title)
              .join("\n");
        else if (w.type === "notification-feed")
          target.textContent = tf("알림 {0}개", (state.notifications || []).length);
        else
          target.textContent =
            (data.events || [])
              .filter((x) => Date.parse(x.endsAt) > Date.now())
              .slice(0, w.type === "calendar" ? 6 : 3)
              .map(
                (x) =>
                  new Date(x.startsAt).toLocaleString(editorLocale(), {
                    month: "numeric",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  }) +
                  "  " +
                  x.title,
              )
              .join("\n") || t("다가오는 일정이 없어요.");
        if (data) {
          const stale =
            provider.status !== "connected" ||
            Date.now() - data.updatedAt >= 45000;
          const stamp = new Date(data.updatedAt).toLocaleString(
            editorLocale(),
            {
              month: "numeric",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            },
          );
          target.textContent =
            (stale ? t("이전 데이터 · 자동 재연결 중") : t("최신 데이터")) +
            " · " +
            stamp +
            t(" 수집\n") +
            target.textContent;
        }
      }
    }
    if (w.type === "todo")
      c.querySelector(".todo-reading").textContent =
        (state.todos?.[w.id] || [])
          .slice(0, 5)
          .map((x) => (x.done ? "✓ " : "○ ") + x.text)
          .join("\n") || t("할 일을 태블릿에서 추가하세요.");
    if (w.type === "graph") {
      const h = (state.history?.[w.binding || "cpu"] || []).slice(-40),
        bars = c.querySelectorAll("i");
      bars.forEach(
        (bar, i) => (bar.style.height = Math.max(2, h[i] || 0) + "%"),
      );
    }
  }
}
function pageSettings() {
  const p = page(),
    box = $("#pageSettings");
  box.replaceChildren();
  field(box, t("기본 테마"), p.theme, (v) => change(() => (p.theme = v)), {
    choices: Object.fromEntries(Object.keys(themes).map((k) => [k, k])),
  });
  field(
    box,
    t("배경색"),
    p.background || themes[p.theme].background,
    (v) => change(() => (p.background = v)),
    { type: "color" },
  );
  field(
    box,
    t("그라데이션"),
    !!p.gradient,
    (v) =>
      change(() => {
        if (v) p.gradient = "#26345b";
        else delete p.gradient;
      }, true),
    { type: "checkbox" },
  );
  if (p.gradient)
    field(
      box,
      t("두 번째 색"),
      p.gradient,
      (v) => change(() => (p.gradient = v)),
      { type: "color" },
    );
  field(box, t("간격"), p.gap, (v) => change(() => (p.gap = v)), {
    type: "range",
    min: 0,
    max: 32,
  });
  field(box, t("모서리"), p.radius, (v) => change(() => (p.radius = v)), {
    type: "range",
    min: 0,
    max: 40,
  });
  field(
    box,
    t("세로 화면 열"),
    p.portrait?.columns || 2,
    (v) =>
      change(() => (p.portrait = { columns: v, rows: p.portrait?.rows || 1 })),
    { type: "number", min: 2, max: 12 },
  );
  field(
    box,
    t("상위 페이지"),
    p.parentId || "",
    (v) =>
      change(() => {
        if (v) p.parentId = v;
        else delete p.parentId;
      }, true),
    {
      choices: {
        "": t("없음"),
        ...Object.fromEntries(
          profilePages(config, profileId)
            .filter((x) => x.id !== p.id)
            .map((x) => [x.id, x.name]),
        ),
      },
    },
  );
  field(
    box,
    t("프로필 기본 디자인 상속"),
    !!p.inheritProfileDesign,
    (v) => change(() => (p.inheritProfileDesign = v), true),
    { type: "checkbox" },
  );
  field(
    box,
    t("그림자 표시"),
    p.shadow !== false,
    (v) => change(() => (p.shadow = v)),
    { type: "checkbox" },
  );
  field(
    box,
    t("빈 셀 표시"),
    !!p.showEmptyCells,
    (v) => change(() => (p.showEmptyCells = v)),
    { type: "checkbox" },
  );
  field(
    box,
    t("소속 프로필"),
    activeProfile(config, profileId)?.id,
    (v) => movePageToProfile(p.id, v),
    {
      choices: Object.fromEntries(
        (config.profiles || []).map((x) => [x.id, x.name]),
      ),
    },
  );
  button(box, t("배경 이미지"), () =>
    upload((id) => change(() => (p.backgroundImage = id))),
  );
  if (p.backgroundImage)
    button(box, t("배경 이미지 제거"), () =>
      change(() => delete p.backgroundImage),
    );
  button(box, t("테마 내보내기"), () =>
    exportFile({
      kind: "open-deck-theme",
      theme: p.theme,
      background: p.background,
      gradient: p.gradient,
      gap: p.gap,
      radius: p.radius,
    }),
  );
}
function inspect() {
  const w = widget();
  if (!w) {
    $("#inspector").hidden = true;
    return;
  }
  const box = $("#widgetFields");
  box.replaceChildren();
  $("#widgetTitle").textContent = names[w.type] || w.type;
  field(box, t("이름 / {{변수}}"), w.label, (v) => change(() => (w.label = v)));
  field(
    box,
    t("강조색"),
    w.color || "#8bb8ff",
    (v) => change(() => (w.color = v)),
    { type: "color" },
  );
  field(
    box,
    t("다른 페이지에도 고정"),
    w.pinScope || "none",
    (v) => change(() => (w.pinScope = v), true),
    {
      choices: {
        none: t("이 페이지에만"),
        profile: t("이 프로필의 모든 페이지"),
        global: t("모든 프로필의 페이지"),
      },
    },
  );
  const stateFields = n("details", undefined, "state-style-editor");
  stateFields.append(n("summary", t("켜짐 상태 디자인")));
  box.append(stateFields);
  field(
    stateFields,
    t("켜짐 상태 변수"),
    w.stateVariable || "",
    (v) =>
      change(() => {
        if (v) w.stateVariable = v;
        else {
          delete w.stateVariable;
          delete w.activeLabel;
          delete w.activeIcon;
          delete w.activeStyle;
        }
      }, true),
    {
      choices: {
        "": t("사용 안 함"),
        ...Object.fromEntries(
          Object.entries(config.variables)
            .filter(([, v]) => typeof v === "boolean")
            .map(([k]) => [k, k]),
        ),
      },
    },
  );
  if (w.stateVariable) {
    field(stateFields, t("켜졌을 때 이름"), w.activeLabel || w.label, (v) =>
      change(() => (w.activeLabel = v)),
    );
    field(
      stateFields,
      t("켜졌을 때 아이콘"),
      w.activeIcon || w.icon,
      (v) => change(() => (w.activeIcon = v)),
      { choices: Object.fromEntries(Object.keys(paths).map((k) => [k, k])) },
    );
    w.activeStyle ??= {};
    for (const [key, label, def] of [
      ["background", t("켜짐 배경색"), "#285545"],
      ["textColor", t("켜짐 글자색"), "#ecfff6"],
      ["borderColor", t("켜짐 테두리색"), "#7bdbb5"],
    ])
      field(
        stateFields,
        label,
        w.activeStyle[key] || def,
        (v) => change(() => (w.activeStyle[key] = v)),
        { type: "color" },
      );
    button(stateFields, t("켜짐 스타일 초기화"), () =>
      change(() => (w.activeStyle = {}), true),
    );
  }
  const palette = n("div", undefined, "settings-swatches");
  for (const color of JSON.parse(document.body.dataset.palette || "[]")) {
    const b = button(palette, color, () => change(() => (w.color = color)));
    b.style.borderColor = color;
    b.style.color = color;
  }
  box.append(palette);
  const size = n("div", undefined, "two");
  box.append(size);
  for (const [key, title, max] of [
    ["w", t("너비"), page().columns],
    ["h", t("높이"), Math.min(12, page().rows)],
  ])
    field(size, title, w[key], (v) => move(w, { ...w, [key]: v }), {
      type: "number",
      min: 1,
      max,
    });
  if (["button", "page"].includes(w.type))
    field(
      box,
      t("아이콘"),
      w.icon || "monitor",
      (v) => change(() => (w.icon = v)),
      { choices: Object.fromEntries(Object.keys(paths).map((k) => [k, k])) },
    );
  if (["button", "page", "image"].includes(w.type)) {
    button(box, w.image ? t("이미지 변경") : t("이미지 선택"), () =>
      upload((id) => change(() => (w.image = id))),
    );
    if (w.image) button(box, t("이미지 제거"), () => change(() => delete w.image));
  }
  if (["calendar", "agenda", "inbox", "notification-feed"].includes(w.type))
    field(
      box,
      t("데이터 연결"),
      w.provider || "",
      (v) =>
        change(() => {
          if (v) w.provider = v;
          else delete w.provider;
        }),
      { choices: { "": t("로컬"), "jimin-os": "Jimin OS" } },
    );
  if (w.type === "system")
    field(
      box,
      t("시스템 지표"),
      w.metric || "overview",
      (v) =>
        change(() => {
          w.metric = v;
          if (v !== "overview") w.compact = false;
        }),
      {
        choices: {
          overview: t("맥 상태 요약"),
          cpu: "CPU",
          memory: t("메모리 압력·사용량"),
          disk: t("저장 공간·디스크 I/O"),
          network: t("네트워크"),
          processes: t("사용량 높은 앱"),
          power: t("전원·발열"),
        },
      },
    );
  if (w.type === "system" && (!w.metric || w.metric === "overview"))
    field(
      box,
      t("한 카드로 요약"),
      !!w.compact,
      (v) => change(() => (w.compact = v)),
      { type: "checkbox" },
    );
  if (["grafana", "system"].includes(w.type)) {
    const alertBox = n("details");
    alertBox.append(n("summary", t("임계치 · 태블릿 알림")));
    box.append(alertBox);
    const settings = monitorSettings(w);
    const edit = (key, value) =>
      change(() => {
        w.alerts ??= structuredClone(settings);
        w.alerts[key] = value;
      });
    field(
      alertBox,
      t("위험 색상 표시"),
      settings.enabled,
      (v) => edit("enabled", v),
      { type: "checkbox" },
    );
    field(alertBox, t("태블릿 알림"), settings.notify, (v) => edit("notify", v), {
      type: "checkbox",
    });
    field(
      alertBox,
      t("지속 시간 (초)"),
      settings.holdSeconds,
      (v) => edit("holdSeconds", v),
      { type: "number", min: 0, max: 3600 },
    );
    field(
      alertBox,
      t("재알림 간격 (초)"),
      settings.cooldownSeconds,
      (v) => edit("cooldownSeconds", v),
      { type: "number", min: 60, max: 86400 },
    );
    alertBox.append(
      n(
        "p",
        t("초록 정상 · 주황 주의 · 빨강 위험. 설정한 시간 이상 유지되면 알림을 보내고 정상 복구도 알려드려요."),
      ),
    );
    for (const [key, rule] of Object.entries(settings.rules)) {
      const group = n("details");
      group.append(n("summary", monitorRuleNames[key]));
      alertBox.append(group);
      const setRule = (name, value) =>
        change(() => {
          w.alerts ??= structuredClone(settings);
          w.alerts.rules ??= structuredClone(settings.rules);
          w.alerts.rules[key] ??= { ...rule };
          w.alerts.rules[key][name] = value;
        });
      field(group, t("임계치 사용"), rule.enabled, (v) => setRule("enabled", v), {
        type: "checkbox",
      });
      field(group, t("기준"), rule.direction, (v) => setRule("direction", v), {
        choices: { above: t("이상일 때"), below: t("이하일 때") },
      });
      for (const [name, title] of [
        ["warning", t("주의")],
        ["critical", t("위험")],
      ]) {
        const input = field(group, title, rule[name], () => {}, {
          type: "number",
          min: 0,
        });
        input.step = "any";
        input.placeholder = t("임계치 입력");
        input.onchange = () =>
          setRule(name, input.value.trim() === "" ? null : Number(input.value));
      }
    }
    button(alertBox, t("태블릿 알림 테스트"), async () => {
      if (dirty) {
        notice(t("변경 저장 후 알림을 테스트해 주세요."), true);
        return;
      }
      try {
        await api("/api/admin/monitor-test", "POST", { widgetId: w.id });
        notice(t("태블릿에 테스트 알림을 보냈습니다."));
      } catch (e) {
        notice(e.message, true);
      }
    });
    if (w.type === "grafana" && w.metric !== "system")
      alertBox.append(
        n(
          "p",
          t("TPS·QPS·연결 수는 임계치를 입력한 뒤 켜세요. 처리량 감소를 감지하려면 ‘이하일 때’를 선택하세요."),
        ),
      );
  }
  if (w.type === "grafana") {
    field(
      box,
      t("표시 지표"),
      w.metric || "database",
      (v) => change(() => (w.metric = v)),
      {
        choices: {
          system: t("시스템 CPU · 수집 상태"),
          database: t("DB 상태 · CPU · TPS"),
        },
      },
    );
    field(box, t("Grafana HTTPS 대시보드 주소"), w.url || "", (v) =>
      change(() => (w.url = v)),
    );
    field(box, t("조회 토큰 사용"), !!w.auth, (v) => change(() => (w.auth = v)), {
      type: "checkbox",
    });
    field(
      box,
      t("CPU 패널 ID"),
      w.cpuPanelId || 1,
      (v) => change(() => (w.cpuPanelId = v)),
      { type: "number", min: 1 },
    );
    field(
      box,
      t("TPS 합계 패널 ID"),
      w.tpsPanelId || 2,
      (v) => change(() => (w.tpsPanelId = v)),
      { type: "number", min: 1 },
    );
    const token = n("input");
    token.type = "password";
    token.autocomplete = "off";
    token.placeholder = t("조회 전용 토큰 · 맥 키체인에만 저장");
    token.setAttribute("aria-label", t("Grafana 조회 토큰"));
    box.append(token);
    button(box, t("조회 토큰 키체인에 저장"), async () => {
      if (dirty) {
        notice(t("변경 저장 후 토큰을 등록해 주세요."), true);
        return;
      }
      try {
        await api("/api/admin/grafana-token", "POST", {
          widgetId: w.id,
          token: token.value,
        });
        token.value = "";
        notice(t("Grafana 조회 토큰을 키체인에 저장했습니다."));
      } catch (e) {
        notice(e.message, true);
      }
    });
    field(box, t("프로젝트 필터 이름"), w.projectVariable || "project", (v) =>
      change(() => (w.projectVariable = v)),
    );
    (w.projects || []).forEach((p, i) => {
      field(box, t("프로젝트 ") + (i + 1) + t(" 이름"), p.label, (v) =>
        change(() => (p.label = v)),
      );
      field(box, t("프로젝트 ") + (i + 1) + t(" 필터 값"), p.value, (v) =>
        change(() => (p.value = v)),
      );
      if (w.projects.length > 1)
        button(box, t("프로젝트 ") + (i + 1) + t(" 제거"), () =>
          change(() => {
            w.projects.splice(i, 1);
            if (w.defaultProject === p.value)
              w.defaultProject = w.projects[0].value;
          }, true),
        );
    });
    button(box, t("프로젝트 추가"), () =>
      change(
        () =>
          w.projects.push({
            label: t("새 프로젝트"),
            value: "project-" + (w.projects.length + 1),
          }),
        true,
      ),
    );
    field(
      box,
      t("기본 프로젝트"),
      w.defaultProject || w.projects?.[0]?.value,
      (v) => change(() => (w.defaultProject = v)),
      {
        choices: Object.fromEntries(
          (w.projects || []).map((p) => [p.value, p.label]),
        ),
      },
    );
  }
  if (w.type === "timer")
    field(box, t("타이머 (분)"), w.minutes, (v) => change(() => (w.minutes = v)), {
      type: "number",
      min: 1,
      max: 1440,
    });
  if (w.type === "page")
    field(
      box,
      t("이동할 페이지"),
      w.targetPage,
      (v) => change(() => (w.targetPage = v)),
      {
        choices: Object.fromEntries(
          profilePages(config, profileId).map((p) => [p.id, p.name]),
        ),
      },
    );
  if (["text", "toggle", "slider", "graph"].includes(w.type))
    field(
      box,
      t("연결 변수"),
      w.binding || "",
      (v) => change(() => (w.binding = v)),
      {
        choices: {
          "": t("선택 안 함"),
          ...Object.fromEntries(
            Object.entries(config.variables)
              .filter(([, v]) =>
                w.type === "toggle"
                  ? typeof v === "boolean"
                  : ["slider", "graph"].includes(w.type)
                    ? typeof v === "number"
                    : true,
              )
              .map(([k]) => [k, k]),
          ),
          ...(w.type === "graph" ? { cpu: "CPU", memory: t("메모리") } : {}),
          ...(["text", "graph"].includes(w.type)
            ? Object.fromEntries(
                pluginItems.flatMap((p) =>
                  (p.variables || []).map((v) => [
                    v.alias,
                    p.name + " · " + (v.name || v.id),
                  ]),
                ),
              )
            : {}),
        },
      },
    );
  if (w.type === "slider")
    for (const k of ["min", "max"])
      field(box, k, w[k], (v) => change(() => (w[k] = v)), { type: "number" });
  const style = n("details"),
    summary = n("summary", t("글자 · 색상 · 모양"));
  style.append(summary);
  box.append(style);
  w.style ??= {};
  const freeLabel = ["button", "page", "text", "image"].includes(w.type);
  if (freeLabel)
    for (const [key, title, choices] of [
      [
        "labelPosition",
        t("글자 위치"),
        { top: t("위"), center: t("가운데"), bottom: t("아래"), hidden: t("숨김") },
      ],
      [
        "align",
        t("글자 정렬"),
        { left: t("왼쪽"), center: t("가운데"), right: t("오른쪽") },
      ],
      ["font", t("글꼴"), { sans: t("기본"), mono: t("고정폭"), serif: t("세리프") }],
    ])
      field(
        style,
        title,
        w.style[key] ||
          Object.keys(choices)[
            key === "labelPosition" ? 2 : key === "align" ? 1 : 0
          ],
        (v) => change(() => (w.style[key] = v)),
        { choices },
      );
  if (["grafana", "system"].includes(w.type))
    field(
      style,
      t("지표 숫자 크기"),
      w.style.valueSize ||
        (w.type === "system" ? 28 : w.metric === "system" ? 44 : 36),
      (v) => change(() => (w.style.valueSize = v)),
      { type: "number", min: 20, max: 60 },
    );
  for (const [key, title, value, min, max] of [
    ["textSize", t("글자 크기"), 17, 9, 36],
    ["iconSize", t("아이콘 크기 (%)"), 32, 10, 65],
    ["borderWidth", t("테두리"), 1, 0, 5],
    ["opacity", t("불투명도 (%)"), 100, 20, 100],
  ].filter(([key]) =>
    key === "textSize"
      ? freeLabel || ["grafana", "system"].includes(w.type)
      : key === "iconSize"
        ? ["button", "page"].includes(w.type)
        : true,
  ))
    field(
      style,
      title,
      w.style[key] ?? value,
      (v) => change(() => (w.style[key] = v)),
      { type: "range", min, max },
    );
  for (const [key, title, value] of [
    ["textColor", t("글자색"), themes[page().theme].text],
    ["background", t("버튼 배경"), themes[page().theme].surface],
    ["borderColor", t("테두리색"), w.color || "#8bb8ff"],
  ].filter(([key]) => key !== "textColor" || freeLabel))
    field(
      style,
      title,
      w.style[key] || value,
      (v) => change(() => (w.style[key] = v)),
      { type: "color" },
    );
  button(style, t("스타일 초기화"), () => change(() => (w.style = {}), true));
  const flow = $("#flowEditor");
  flow.hidden = !["button", "toggle"].includes(w.type);
  if (!flow.hidden) renderActions();
}
let gesture = "actions";
function renderActions() {
  const w = widget(),
    key = gesture,
    box = $("#actions");
  box.replaceChildren();
  $("#actionsJson").value = JSON.stringify(w[key] || [], null, 2);
  for (const [i, a] of (w[key] || []).entries()) {
    const row = n("div", undefined, "action");
    box.append(row);
    field(
      row,
      t("동작"),
      a.type,
      (v) => {
        checkpoint();
        a.type = v;
        changed();
        renderActions();
      },
      { choices: kinds },
    );
    if (a.type === "chrome")
      field(row, t("Chrome 프로필 폴더"), a.profile || "Default", (v) => {
        checkpoint();
        a.profile = v;
        changed();
      });
    if (["setVariable", "increment", "toggleVariable", "if"].includes(a.type))
      field(
        row,
        t("변수"),
        a.variable || "",
        (v) => {
          checkpoint();
          a.variable = v;
          changed();
        },
        {
          choices: {
            "": t("변수 선택"),
            ...Object.fromEntries(
              Object.keys(config.variables).map((k) => [k, k]),
            ),
          },
        },
      );
    if (a.type === "http")
      field(
        row,
        t("연동"),
        a.integrationId || "",
        (v) => {
          checkpoint();
          a.integrationId = v;
          changed();
        },
        {
          choices: {
            "": t("연동 선택"),
            ...Object.fromEntries(
              config.integrations.map((x) => [x.id, x.name]),
            ),
          },
        },
      );
    if (
      !["mute", "toggleVariable", "if", "http", "plugin", "extension"].includes(
        a.type,
      )
    )
      field(
        row,
        t("값"),
        typeof a.value === "object" ? JSON.stringify(a.value) : (a.value ?? ""),
        (v) => {
          checkpoint();
          if (a.type === "setVariable") {
            try {
              a.value = JSON.parse(v);
            } catch {
              a.value = v;
            }
          } else a.value = v;
          changed();
        },
        {
          placeholder:
            a.type === "openApp"
              ? "/Applications/ChatGPT.app"
              : a.type === "chrome" || a.type === "openUrl"
                ? "https://"
                : t("값"),
        },
      );
    if (a.type === "extension") {
      a.extensionId = "jimin-os";
      a.operation ||= "navigate";
      a.parameters ||= { view: "home" };
      field(
        row,
        t("열 화면"),
        a.operation === "refresh" ? "refresh" : a.parameters.view,
        (v) => {
          checkpoint();
          a.operation = v === "refresh" ? "refresh" : "navigate";
          a.parameters = v === "refresh" ? {} : { view: v };
          changed();
        },
        {
          choices: {
            home: t("나의 하루"),
            requests: t("업무 요청"),
            scheduled: t("예약 업무"),
            calendar: t("일정"),
            tasks: t("할 일"),
            meetings: t("회의 기록"),
            memory: t("기억"),
            assistant: t("지민에게 말하기"),
            "new-schedule": t("일정 추가"),
            "new-task": t("할 일 추가"),
            refresh: t("새로고침"),
          },
        },
      );
    }
    if (a.type === "plugin") {
      field(row, t("플러그인 ID"), a.pluginId || "", (v) => {
        checkpoint();
        a.pluginId = v;
        changed();
      });
      field(row, t("동작 ID"), a.actionId || "", (v) => {
        checkpoint();
        a.actionId = v;
        changed();
      });
      field(row, t("매개변수 (JSON)"), JSON.stringify(a.parameters || {}), (v) => {
        try {
          const parsed = JSON.parse(v);
          if (!parsed || Array.isArray(parsed) || typeof parsed !== "object")
            throw Error();
          checkpoint();
          a.parameters = parsed;
          changed();
        } catch {
          notice(t("JSON 객체를 입력하세요."), true);
        }
      });
    }
    const actions = n("div", undefined, "two");
    row.append(actions);
    button(actions, "↑", () => {
      checkpoint();
      if (i) [w[key][i - 1], w[key][i]] = [w[key][i], w[key][i - 1]];
      changed();
      renderActions();
    });
    button(actions, t("삭제"), () => {
      checkpoint();
      w[key].splice(i, 1);
      changed();
      renderActions();
    });
  }
}
function addWidget(type) {
  change(() => {
    const p = page(),
      w = {
        id: uid(),
        type,
        label: names[type],
        color: themes[p.theme].accent,
        icon: "monitor",
        w: 1,
        h: 1,
        x: 0,
        y: 0,
        style: {},
      };
    if (["agenda", "inbox", "notification-feed"].includes(type)) {
      w.provider = "jimin-os";
      w.w = Math.min(2, p.columns);
      w.h = 2;
    }
    if (type === "button") w.actions = [];
    if (type === "timer") w.minutes = 25;
    if (type === "page")
      w.targetPage =
        profilePages(config, profileId).find((x) => x.id !== p.id)?.id || p.id;
    if (type === "graph") w.binding = "cpu";
    if (type === "system") w.metric = "overview";
    if (type === "grafana")
      Object.assign(w, {
        url: "",
        projects: [{ label: t("프로젝트"), value: "project" }],
        defaultProject: "project",
        projectVariable: "project",
      });
    if (type === "toggle" || type === "slider") {
      const key =
        (type === "toggle" ? "toggle_" : "value_") + uid().slice(0, 6);
      config.variables[key] = type === "toggle" ? false : 50;
      w.binding = key;
      if (type === "slider") {
        w.min = 0;
        w.max = 100;
      }
    }
    p.widgets.push(w);
    ensurePlace();
    selected = w.id;
  }, true);
}
function addPage(name = t("새 페이지"), template = "empty") {
  change(() => {
    const p = {
      id: uid(),
      name,
      columns: 4,
      rows: 3,
      theme: "midnight",
      gap: 12,
      radius: 13,
      widgets: [],
    };
    config.pages.push(p);
    activeProfile(config, profileId)?.pageIds.push(p.id);
    pageId = p.id;
    selected = null;
  }, true);
  if (template === "monitor") {
    change(() => {
      const p = page();
      Object.assign(p, monitorPage({ id: p.id }));
      selected = null;
    }, true);
    return;
  }
  if (template !== "empty") {
    const list =
      template === "focus"
        ? ["clock", "timer", "todo", "page"]
        : ["gauges", "graph", "calendar", "page"];
    for (const type of list) addWidget(type);
    change(() => {
      const p = page();
      if (template === "focus") {
        const boxes = [
          [0, 0, 2, 1],
          [2, 0, 2, 2],
          [0, 1, 2, 2],
          [2, 2, 2, 1],
        ];
        p.widgets.forEach((w, i) =>
          Object.assign(w, {
            x: boxes[i][0],
            y: boxes[i][1],
            w: boxes[i][2],
            h: boxes[i][3],
          }),
        );
      } else {
        p.columns = 6;
        p.rows = 4;
        p.theme = "ocean";
        const boxes = [
          [0, 0, 3, 2],
          [0, 2, 3, 2],
          [3, 0, 3, 3],
          [3, 3, 3, 1],
        ];
        p.widgets.forEach((w, i) =>
          Object.assign(w, {
            x: boxes[i][0],
            y: boxes[i][1],
            w: boxes[i][2],
            h: boxes[i][3],
          }),
        );
      }
      const back = p.widgets.find((w) => w.type === "page");
      back.label = t("Workspace로");
      back.icon = "tasks";
      selected = null;
    }, true);
  }
}
async function save() {
  const result = await api("/api/admin/config", "PUT", config);
  config = result.config || config;
  dirty = false;
  $("#saved").textContent = t("모든 변경 저장됨");
  $("#save").textContent = t("변경 저장");
  notice(t("태블릿에 반영했습니다."));
}
async function upload(done) {
  const input = $("#imageFile");
  input.onchange = async () => {
    try {
      const file = input.files[0];
      if (!file) return;
      if (file.size > 2097152) throw Error(t("이미지는 2MB 이하여야 합니다."));
      const data = await new Promise((r, j) => {
        const f = new FileReader();
        f.onload = () => r(f.result);
        f.onerror = j;
        f.readAsDataURL(file);
      });
      done((await api("/api/admin/assets", "POST", { data })).id);
    } catch (e) {
      notice(e.message, true);
    }
    input.value = "";
  };
  input.click();
}
async function exportFile(data) {
  try {
    const ids = new Set();
    if (data.pages)
      for (const p of data.pages) {
        if (p.backgroundImage) ids.add(p.backgroundImage);
        for (const w of p.widgets) if (w.image) ids.add(w.image);
      }
    if (ids.size) {
      data = structuredClone(data);
      data.assets = {};
      for (const id of ids) {
        const res = await fetch("/api/assets/" + id);
        if (!res.ok) throw Error(t("이미지를 내보내지 못했습니다."));
        const blob = await res.blob();
        data.assets[id] = await new Promise((resolve) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.readAsDataURL(blob);
        });
      }
    }
    const text = JSON.stringify(data, null, 2);
    if (new TextEncoder().encode(text).length >= 96 * 1024 * 1024)
      throw Error(t("내보낼 파일은 96MB 이하여야 합니다."));
    if (window.webkit?.messageHandlers?.exportConfig) {
      window.webkit.messageHandlers.exportConfig.postMessage(text);
      return;
    }
    const a = n("a");
    a.href = URL.createObjectURL(
      new Blob([text], { type: "application/json" }),
    );
    a.download =
      data.kind === "open-deck-profile"
        ? "open-deck-profile.json"
        : data.kind === "open-deck-theme"
          ? "open-deck-theme.json"
          : "open-deck.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (e) {
    notice(e.message, true);
  }
}
function variables() {
  const box = $("#variables");
  box.replaceChildren();
  for (const [key, value] of Object.entries(config.variables)) {
    const row = n("div", undefined, "variable-row");
    row.append(n("code", key));
    field(row, t("초깃값"), JSON.stringify(value), (v) => {
      try {
        const parsed = JSON.parse(v);
        if (!["number", "boolean", "string"].includes(typeof parsed))
          throw Error();
        checkpoint();
        config.variables[key] = parsed;
        changed();
      } catch {
        notice(
          t("숫자, true/false 또는 따옴표로 감싼 문자열을 입력하세요."),
          true,
        );
      }
    });
    row.append(
      n(
        "span",
        t("현재: ") + String(state.variables?.[key] ?? value),
        "text-muted",
      ),
    );
    button(row, t("삭제"), () => change(() => delete config.variables[key], true));
    box.append(row);
  }
}
function connectors() {
  const box = $("#connectors");
  box.replaceChildren();
  for (const i of config.integrations) {
    const row = n("details"),
      summary = n("summary", i.name);
    row.append(summary);
    box.append(row);
    const set = (k, v) => {
      checkpoint();
      i[k] = v;
      changed();
    };
    field(row, t("이름"), i.name, (v) => {
      set("name", v);
      summary.textContent = v;
    });
    field(row, "URL", i.url, (v) => set("url", v), {
      placeholder: "https://service.example/api/status",
    });
    field(row, t("메서드"), i.method || "GET", (v) => set("method", v), {
      choices: Object.fromEntries(
        ["GET", "POST", "PUT", "PATCH", "DELETE"].map((k) => [k, k]),
      ),
    });
    field(row, t("JSON 경로 (예: result.count)"), i.path || "", (v) =>
      set("path", v),
    );
    field(row, t("저장 변수"), i.variable || "", (v) => set("variable", v), {
      choices: {
        "": t("저장 안 함"),
        ...Object.fromEntries(Object.keys(config.variables).map((k) => [k, k])),
      },
    });
    field(
      row,
      t("주기 (초)"),
      i.intervalSeconds || 60,
      (v) => set("intervalSeconds", v),
      { type: "number", min: 5, max: 86400 },
    );
    field(row, t("자동 갱신 (GET만)"), i.enabled, (v) => set("enabled", v), {
      type: "checkbox",
    });
    field(row, t("Bearer 토큰 사용"), i.auth, (v) => set("auth", v), {
      type: "checkbox",
    });
    field(row, t("요청 본문 JSON"), i.body || "", (v) => set("body", v));
    field(
      row,
      t("Bearer 토큰 · macOS 키체인에 저장"),
      "",
      async (v) => {
        try {
          await api("/api/admin/secret", "POST", { id: i.id, value: v });
          notice(t("인증 토큰을 키체인에 저장했습니다."));
        } catch (e) {
          notice(e.message, true);
        }
      },
      { type: "password" },
    );
    button(row, t("지금 갱신"), async () => {
      try {
        await save();
        const r = await api("/api/admin/refresh", "POST", { id: i.id });
        notice(t("응답: ") + String(r.value));
      } catch (e) {
        notice(e.message, true);
      }
    });
    button(row, t("삭제"), () =>
      change(
        () =>
          (config.integrations = config.integrations.filter(
            (x) => x.id !== i.id,
          )),
        true,
      ),
    );
    const st = state.integrations?.[i.id];
    row.append(
      n(
        "p",
        st?.state === "error" ? st.message : st?.state || t("미연결"),
        "connector-status",
      ),
    );
  }
}

async function refreshPlugins() {
  pluginItems = (await api("/api/admin/plugins")).plugins;
  renderPlugins();
}
function renderPlugins() {
  const box = $("#pluginList");
  box.replaceChildren();
  const form = n("div", undefined, "variable-row");
  let folder = "";
  field(form, t("플러그인 폴더"), folder, (v) => (folder = v), {
    placeholder: t("/폴더/manifest.json이 들어 있는 경로"),
  });
  button(form, t("폴더 등록"), async () => {
    try {
      await api("/api/admin/plugins", "POST", {
        operation: "register",
        folder,
      });
      await refreshPlugins();
    } catch (e) {
      notice(e.message, true);
    }
  });
  box.append(form);
  for (const p of pluginItems) {
    const row = n("details"),
      summary = n("summary", p.name + " · " + p.version + " · " + p.state);
    row.append(summary);
    box.append(row);
    row.append(n("p", p.error || p.folder));
    const accepted = (p.capabilities || [])
        .filter((c) => c.accepted)
        .map((c) => c.kind + " v" + c.negotiatedVersion),
      rejected = [
        ...new Set(
          (p.capabilities || []).filter((c) => !c.accepted).map((c) => c.kind),
        ),
      ];
    row.append(
      n(
        "p",
        t("지원: ") +
          (accepted.length
            ? [...new Set(accepted)].join(", ")
            : t("연결 후 확인")),
      ),
    );
    if (rejected.length) row.append(n("p", t("미지원: ") + rejected.join(", ")));
    for (const op of [p.enabled ? "stop" : "start", "remove"])
      button(
        row,
        op === "start" ? t("실행") : op === "stop" ? t("중지") : t("등록 해제"),
        async () => {
          try {
            await api("/api/admin/plugins", "POST", {
              operation: op,
              id: p.id,
            });
            await refreshPlugins();
          } catch (e) {
            notice(e.message, true);
          }
        },
      );
    button(row, t("상태 새로고침"), () =>
      refreshPlugins().catch((e) => notice(e.message, true)),
    );
    for (const a of p.actions || []) {
      const action = n("div", undefined, "variable-row");
      action.append(n("code", a.localId));
      button(action, t("동작 버튼 추가"), () => {
        pageId = config.pages[0].id;
        const w = {
          id: uid(),
          type: "button",
          label: a.localId,
          icon: "spark",
          color: "#91a8e9",
          w: 1,
          h: 1,
          style: {},
          actions: [
            {
              type: "plugin",
              pluginId: p.id,
              actionId: a.localId,
              parameters: Object.fromEntries(
                (a.parameters || [])
                  .filter((x) => x.defaultValue !== undefined)
                  .map((x) => [x.name, x.defaultValue]),
              ),
            },
          ],
        };
        change(() => {
          page().widgets.push(w);
          ensurePlace();
          selected = w.id;
        }, true);
        $("#editTab").click();
      });
      row.append(action);
    }
    for (const v of p.variables || []) {
      const line = n("div", undefined, "variable-row");
      line.append(n("code", v.alias));
      button(line, t("값 위젯 추가"), () => {
        const w = {
          id: uid(),
          type: "text",
          label: v.name || v.id,
          binding: v.alias,
          color: "#91a8e9",
          w: 1,
          h: 1,
          style: {},
        };
        change(() => {
          page().widgets.push(w);
          ensurePlace();
        }, true);
        $("#editTab").click();
      });
      row.append(line);
    }
  }
}

function automations() {
  const box = $("#automations");
  box.replaceChildren();
  const buttons = config.pages
    .flatMap((p) => p.widgets)
    .filter((w) => w.type === "button");
  for (const a of config.automations || []) {
    const row = n("div", undefined, "automation-row");
    box.append(row);
    field(
      row,
      t("사용"),
      a.enabled,
      (v) => {
        checkpoint();
        a.enabled = v;
        changed();
      },
      { type: "checkbox" },
    );
    field(
      row,
      t("실행 조건"),
      a.trigger || "time",
      (v) => {
        checkpoint();
        a.trigger = v;
        a.time ??= "09:00";
        a.variable ??= Object.keys(config.variables)[0];
        changed();
        automations();
      },
      {
        choices: {
          time: t("요일 · 시간"),
          variable: t("변수 변경"),
          plugin: t("플러그인 이벤트"),
        },
      },
    );
    if (a.trigger === "variable") {
      field(
        row,
        t("변수"),
        a.variable || "",
        (v) => {
          checkpoint();
          a.variable = v;
          changed();
        },
        {
          choices: Object.fromEntries(
            Object.keys(config.variables).map((k) => [k, k]),
          ),
        },
      );
      field(
        row,
        t("값 조건 (JSON · 비우면 모든 변경)"),
        a.equals === undefined ? "" : JSON.stringify(a.equals),
        (v) => {
          try {
            const parsed = v ? JSON.parse(v) : undefined;
            checkpoint();
            if (parsed === undefined) delete a.equals;
            else a.equals = parsed;
            changed();
          } catch {
            notice(t("JSON 값을 입력하세요."), true);
          }
        },
      );
    } else if (a.trigger === "plugin") {
      field(row, t("플러그인 ID"), a.pluginId || "", (v) => {
        checkpoint();
        a.pluginId = v;
        changed();
      });
      field(row, t("이벤트 ID"), a.eventId || "", (v) => {
        checkpoint();
        a.eventId = v;
        changed();
      });
    }
    if (a.trigger && a.trigger !== "time")
      field(
        row,
        t("최소 간격 (초)"),
        a.cooldownSeconds || 5,
        (v) => {
          checkpoint();
          a.cooldownSeconds = v;
          changed();
        },
        { type: "number", min: 1, max: 86400 },
      );
    if (!a.trigger || a.trigger === "time")
      field(
        row,
        t("시간"),
        a.time,
        (v) => {
          checkpoint();
          a.time = v;
          changed();
        },
        { type: "time" },
      );
    field(
      row,
      t("버튼"),
      a.widgetId,
      (v) => {
        checkpoint();
        a.widgetId = v;
        changed();
      },
      { choices: Object.fromEntries(buttons.map((w) => [w.id, w.label])) },
    );
    const days = n("div", undefined, "days");
    if (!a.trigger || a.trigger === "time") row.append(days);
    [t("일"), t("월"), t("화"), t("수"), t("목"), t("금"), t("토")].forEach((d, i) =>
      field(
        days,
        d,
        !a.days || a.days.includes(i),
        (on) => {
          checkpoint();
          a.days ??= [0, 1, 2, 3, 4, 5, 6];
          a.days = on
            ? [...new Set([...a.days, i])]
            : a.days.filter((x) => x !== i);
          changed();
        },
        { type: "checkbox" },
      ),
    );
    button(row, t("삭제"), () =>
      change(
        () =>
          (config.automations = config.automations.filter(
            (x) => x.id !== a.id,
          )),
        true,
      ),
    );
  }
}
$("#save").onclick = () => save().catch((e) => notice(e.message, true));
$("#undo").onclick = () => history(undo, redo);
$("#redo").onclick = () => history(redo, undo);
$("#columns").onchange = () =>
  change(() => {
    page().columns = Number($("#columns").value);
    page().rows = place(page().widgets, page().columns, page().rows, false);
  }, true);
$("#rows").onchange = () => {
  const rows = Number($("#rows").value);
  if (page().widgets.some((w) => w.y + w.h > rows)) {
    notice(
      t("위젯이 놓인 행은 제거할 수 없습니다. 먼저 이동하거나 자동 정렬하세요."),
      true,
    );
    $("#rows").value = page().rows;
    return;
  }
  change(() => (page().rows = rows));
};
$("#pack").onclick = () =>
  change(
    () => (page().rows = place(page().widgets, page().columns, 1, false)),
    true,
  );
$("#orientation").onclick = () => {
  portrait = !portrait;
  $("#orientation").textContent = portrait ? t("세로 미리보기") : t("가로 미리보기");
  $("#previewHint").textContent = portrait
    ? t("세로 배치는 자동으로 정렬됩니다. 가로 미리보기에서 위젯을 편집하세요.")
    : t("드래그로 이동 · 오른쪽 아래 모서리로 크기 조절 · 방향키 이동 / Alt+방향키 크기 조절");
  renderBoard();
};
function renderPalette() {
  $("#palette").replaceChildren();
  for (const type of Object.keys(names)) button($("#palette"), "+ " + names[type], () => addWidget(type));
}
renderPalette();
window.addEventListener("opendeck:languagechange", () => { renderPalette(); if (config && pageId) render(); });
$("#addPage").onclick = () => {
  const name = prompt(t("페이지 이름"), t("새 페이지"));
  if (name) addPage(name);
};
$("#renamePage").onclick = () => {
  const name = prompt(t("페이지 이름"), page().name);
  if (name) change(() => (page().name = name), true);
};
$("#duplicatePage").onclick = () =>
  change(() => {
    const p = structuredClone(page());
    p.id = uid();
    p.name += t(" 복사");
    for (const w of p.widgets) w.id = uid();
    config.pages.push(p);
    activeProfile(config, profileId)?.pageIds.push(p.id);
    pageId = p.id;
    selected = null;
  }, true);
$("#pageUp").onclick = () =>
  change(() => {
    const i = config.pages.findIndex((p) => p.id === pageId);
    if (i)
      [config.pages[i - 1], config.pages[i]] = [
        config.pages[i],
        config.pages[i - 1],
      ];
  }, true);
$("#removePage").onclick = () => {
  if (profilePages(config, profileId).length === 1)
    return notice(t("각 프로필에는 페이지 하나를 남겨 두세요."), true);
  if (!confirm(t("이 페이지를 삭제할까요? 실행 취소로 복구할 수 있습니다.")))
    return;
  change(() => {
    const id = pageId;
    const removed = new Set(page().widgets.map((w) => w.id));
    config.automations = (config.automations || []).filter(
      (a) => !removed.has(a.widgetId),
    );
    config.pages = config.pages.filter((p) => p.id !== id);
    for (const profile of config.profiles) {
      profile.pageIds = profile.pageIds.filter((x) => x !== id);
      if (profile.defaultPageId === id)
        profile.defaultPageId = profile.pageIds[0] || "";
    }
    for (const p of config.pages) {
      if (p.parentId === id) delete p.parentId;
      for (const w of p.widgets) if (w.targetPage === id) w.targetPage = p.id;
    }
    pageId = config.pages[0].id;
    selected = null;
  }, true);
};
$("#template").onchange = () => {
  const v = $("#template").value;
  if (v) addPage(v === "focus" ? t("집중") : t("모니터"), v);
  $("#template").value = "";
};
$("#closeInspector").onclick = () => {
  selected = null;
  $("#inspector").hidden = true;
  renderBoard();
};
$("#duplicate").onclick = () =>
  change(() => {
    const w = structuredClone(widget());
    w.id = uid();
    w.label += t(" 복사");
    page().widgets.push(w);
    ensurePlace();
    selected = w.id;
  }, true);
$("#removeWidget").onclick = () =>
  change(() => {
    const id = selected;
    page().widgets = page().widgets.filter((w) => w.id !== id);
    config.automations = config.automations.filter((a) => a.widgetId !== id);
    selected = null;
  }, true);
$("#gesture").onchange = () => {
  gesture = $("#gesture").value;
  renderActions();
};
$("#addAction").onclick = () => {
  checkpoint();
  (widget()[gesture] ??= []).push({ type: "openApp", value: "" });
  changed();
  renderActions();
};
$("#applyJson").onclick = () => {
  try {
    const a = JSON.parse($("#actionsJson").value);
    if (!Array.isArray(a)) throw Error(t("배열이 필요합니다."));
    checkpoint();
    widget()[gesture] = a;
    changed();
    renderActions();
  } catch (e) {
    notice(e.message, true);
  }
};
$("#testAction").onclick = async () => {
  try {
    await save();
    await api("/api/action", "POST", {
      id: widget().id,
      gesture:
        gesture === "longActions"
          ? "long"
          : gesture === "doubleActions"
            ? "double"
            : "tap",
    });
    notice(t("실행했습니다."));
  } catch (e) {
    notice(e.message, true);
  }
};
$("#addVariable").onclick = () => {
  const key = prompt(t("변수 이름 (영문·숫자·밑줄)"), "counter");
  if (!key) return;
  if (
    !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) ||
    Object.hasOwn(config.variables, key)
  )
    return notice(t("중복되지 않는 영문 변수 이름을 입력하세요."), true);
  change(() => (config.variables[key] = 0), true);
};
$("#addConnector").onclick = () =>
  change(
    () =>
      config.integrations.push({
        id: uid().replaceAll("-", ""),
        type: "http",
        name: t("새 HTTP 연동"),
        url: "https://",
        method: "GET",
        path: "",
        intervalSeconds: 60,
        enabled: false,
      }),
    true,
  );
$("#addAutomation").onclick = () => {
  const first = config.pages
    .flatMap((p) => p.widgets)
    .find((w) => w.type === "button");
  if (first)
    change(
      () =>
        (config.automations ??= []).push({
          id: uid(),
          enabled: false,
          time: "09:00",
          widgetId: first.id,
        }),
      true,
    );
};
$("#export").onclick = () => exportFile(config);
$("#import").onclick = () => $("#file").click();
$("#file").onchange = async () => {
  try {
    const f = $("#file").files[0];
    if (!f) return;
    if (f.size > 16777216) throw Error(t("백업 파일은 16MB 이하여야 합니다."));
    const raw = JSON.parse(await f.text());
    if (raw.kind === "open-deck-theme") {
      change(
        () =>
          Object.assign(
            page(),
            Object.fromEntries(
              ["theme", "background", "gradient", "gap", "radius"]
                .filter((k) => raw[k] !== undefined)
                .map((k) => [k, raw[k]]),
            ),
          ),
        true,
      );
      return;
    }
    for (const [id, data] of Object.entries(raw.assets || {})) {
      if ((await api("/api/admin/assets", "POST", { data })).id !== id)
        throw Error(t("이미지 파일 검증에 실패했습니다."));
    }
    delete raw.assets;
    if (raw.kind === "open-deck-profile") {
      checkpoint();
      const imported = importProfile(config, raw);
      profileId = imported.id;
      pageId = imported.defaultPageId;
      selected = null;
      changed();
      render();
      notice(
        t("프로필을 가져왔습니다. 자동화와 앱 자동 전환은 꺼진 상태로 시작합니다."),
      );
      return;
    }
    const c = migrate(raw);
    checkpoint();
    config = c;
    pageId = c.pages[0].id;
    selected = null;
    changed();
    render();
  } catch (e) {
    notice(e.message, true);
  }
  $("#file").value = "";
};
$("#newPin").onclick = async () => {
  try {
    pin((await api("/api/admin/pin", "POST", {})).pin);
  } catch (e) {
    notice(e.message, true);
  }
};
function pin(p) {
  $("#pin").textContent = p.slice(0, 3) + " " + p.slice(3);
}
$("#devicesToggle").onclick = () => settingsCenter.openCategory("devices");
for (const [id, target] of [
  ["editTab", "deckArea"],
  ["automationTab", "automationArea"],
  ["dataTab", "dataArea"],
])
  $("#" + id).onclick = () => {
    for (const x of ["deckArea", "automationArea", "dataArea"])
      $("#" + x).hidden = x !== target;
    for (const x of ["editTab", "automationTab", "dataTab"])
      $("#" + x).classList.toggle("active", x === id);
  };
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    save().catch((e) => notice(e.message, true));
  }
  if (
    (e.metaKey || e.ctrlKey) &&
    e.key.toLowerCase() === "z" &&
    !document.querySelector("dialog[open]") &&
    !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)
  ) {
    e.preventDefault();
    e.shiftKey ? history(redo, undo) : history(undo, redo);
  }
});
window.onbeforeunload = (e) => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = "";
  }
};
const settingsCenter = createSettingsCenter({
  api,
  getConfig: () => config,
  saveDraft: async () => {
    if (dirty) await save();
  },
  restored: async (restoredConfig) => {
    config = migrate(restoredConfig || (await api("/api/admin/info")).config);
    profileId = config.defaultProfileId;
    pageId = config.pages[0].id;
    selected = null;
    selectedWidgets.clear();
    dirty = false;
    render();
  },
  notice,
  exportFile,
});
$("#settingsToggle").onclick = () => settingsCenter.open();
try {
  await ensureEditorUnlocked();
  startEditorLockMonitor();
  info = await api("/api/admin/info");
  config = migrate(info.config);
  profileId = config.defaultProfileId;
  await settingsCenter.initialize();
  pageId = config.pages[0].id;
  pin(info.pin);
  await refreshPlugins();
  render();
  const events = new EventSource("/api/events");
  events.onopen = () => {
    if ($("#notice").textContent === t("맥 호스트 연결을 기다리는 중입니다."))
      notice(dirty ? t("저장하지 않은 변경") : t("다시 연결됨"));
  };
  events.addEventListener("snapshot", (e) => {
    const snapshot = JSON.parse(e.data);
    state = snapshot.state;
    applyAppearanceVariables(state.variables);
    if (
      snapshot.config &&
      !dirty &&
      JSON.stringify(snapshot.config.pages) !== JSON.stringify(config.pages)
    ) {
      // Tablet snapshots omit executable actions; fetch the full admin configuration.
      api("/api/admin/info")
        .then((r) => {
          if (!dirty) {
            config = migrate(r.config);
            selected = null;
            render();
          }
        })
        .catch(() => {});
    }
    updateLive();
    updateEcosystemStatus();
  });
  events.onerror = () => notice(t("맥 호스트 연결을 기다리는 중입니다."), true);
} catch (e) {
  notice(e.message, true);
}

function updateEcosystemStatus() {
  const status = $("#osStatus");
  if (!status) return;
  const p = state.extensions?.["jimin-os"];
  status.textContent =
    p?.status === "connected"
      ? t("연결됨 · 일정과 업무 요청을 동기화하고 있어요.")
      : p?.data
        ? t("이전 데이터 · ") +
          new Date(p.data.updatedAt).toLocaleTimeString(editorLocale()) +
          t(" 수집 · 자동으로 다시 연결하고 있어요.")
        : p?.enabled
          ? t("자동으로 다시 연결하고 있어요. 맥에서 Jimin OS 앱과 로그인을 확인해 주세요.")
          : t("연결 전");
}
function renderEcosystem() {
  const box = $("#ecosystem");
  box.replaceChildren();
  box.append(n("p", t("연결 상태를 확인하고 있어요."), "text-muted"));
  box.lastChild.id = "osStatus";
  updateEcosystemStatus();
  const options = config.extensions?.["jimin-os"] || {},
    draft = { ...options };
  field(
    box,
    t("일정·새 업무 요청 알림"),
    options.notifications !== false,
    (v) => (draft.notifications = v),
    { type: "checkbox" },
  );
  field(
    box,
    t("일정과 마감 알림 (분 전)"),
    options.reminderMinutes || 10,
    (v) => (draft.reminderMinutes = v),
    { type: "number", min: 1, max: 120 },
  );
  button(
    box,
    options.enabled ? t("연결 설정 저장") : t("연결하고 OS 탭 추가"),
    async () => {
      try {
        await save();
        const r = await api("/api/admin/extensions", "POST", {
          id: "jimin-os",
          ...draft,
          enabled: true,
          addPage: true,
        });
        config = migrate(r.config);
        pageId = "jimin-os-page";
        render();
        notice(t("OS 탭을 연결했어요."));
      } catch (e) {
        notice(e.message, true);
      }
    },
    "primary",
  );
  button(box, t("태블릿으로 연결 알림 보내기"), async () => {
    try {
      await api("/api/admin/extensions/test-notification", "POST", {});
      notice(t("연결된 태블릿에 알림을 보냈어요."));
    } catch (e) {
      notice(e.message, true);
    }
  });
  if (options.enabled)
    button(box, t("연결 끄기"), async () => {
      const r = await api("/api/admin/extensions", "POST", {
        id: "jimin-os",
        ...draft,
        enabled: false,
      });
      config = migrate(r.config);
      render();
    });
}

setInterval(() => {
  if (config && !document.hidden) updateLive();
}, 5000);

function renderProfiles() {
  const current = activeProfile(config, profileId);
  if (!current) return;
  profileId = current.id;
  const pages = profilePages(config, profileId);
  if (!pages.some((p) => p.id === pageId))
    pageId = current.defaultPageId || pages[0]?.id;
  const select = $("#profileSelect");
  select.replaceChildren(
    ...config.profiles.map((profile) => {
      const option = n(
        "option",
        profile.name +
          (profile.id === config.defaultProfileId ? t(" · 기본") : ""),
      );
      option.value = profile.id;
      return option;
    }),
  );
  select.value = profileId;
  select.onchange = () => {
    profileId = select.value;
    selected = null;
    selectedWidgets.clear();
    pageId = activeProfile(config, profileId).defaultPageId;
    render();
  };
}
function movePageToProfile(id, targetId) {
  const source = config.profiles.find((p) => p.pageIds.includes(id)),
    target = config.profiles.find((p) => p.id === targetId);
  if (!source || !target || source === target) return;
  const ids = new Set([id]);
  let changedDescendants = true;
  while (changedDescendants) {
    changedDescendants = false;
    for (const page of config.pages)
      if (ids.has(page.parentId) && !ids.has(page.id)) {
        ids.add(page.id);
        changedDescendants = true;
      }
  }
  if (source.pageIds.every((x) => ids.has(x)))
    return notice(t("원래 프로필에 페이지 하나를 남겨 두세요."), true);
  change(() => {
    source.pageIds = source.pageIds.filter((x) => !ids.has(x));
    target.pageIds.push(...ids);
    if (ids.has(source.defaultPageId)) source.defaultPageId = source.pageIds[0];
    const moved = config.pages.find((p) => p.id === id);
    delete moved.parentId;
    profileId = target.id;
    pageId = id;
  }, true);
}
function profileManager() {
  const dialog = n("dialog", undefined, "profile-dialog");
  const title = n("h2", t("프로필 관리"));
  dialog.append(
    title,
    n(
      "p",
      t("프로필마다 페이지 구성을 분리하고, 태블릿의 시작 프로필을 지정할 수 있어요."),
    ),
  );
  const body = n("div");
  dialog.append(body);
  function draw() {
    body.replaceChildren();
    for (const profile of config.profiles) {
      const row = n("section", undefined, "settings-section");
      body.append(row);
      field(row, t("프로필 이름"), profile.name, (v) =>
        change(() => (profile.name = v), true),
      );
      field(
        row,
        t("시작 페이지"),
        profile.defaultPageId,
        (v) => change(() => (profile.defaultPageId = v)),
        {
          choices: Object.fromEntries(
            profilePages(config, profile.id).map((p) => [p.id, p.name]),
          ),
        },
      );
      profile.defaults ??= {};
      const defaults = n("details");
      defaults.append(n("summary", t("프로필 기본 디자인")));
      row.append(defaults);
      field(
        defaults,
        t("기본 테마"),
        profile.defaults.theme || "midnight",
        (v) => change(() => (profile.defaults.theme = v), true),
        { choices: Object.fromEntries(Object.keys(themes).map((k) => [k, k])) },
      );
      field(
        defaults,
        t("기본 간격"),
        profile.defaults.gap ?? 12,
        (v) => change(() => (profile.defaults.gap = v), true),
        { type: "number", min: 0, max: 32 },
      );
      field(
        defaults,
        t("기본 모서리"),
        profile.defaults.radius ?? 13,
        (v) => change(() => (profile.defaults.radius = v), true),
        { type: "number", min: 0, max: 40 },
      );
      field(
        defaults,
        t("기본 배경"),
        profile.defaults.background ||
          themes[profile.defaults.theme || "midnight"].background,
        (v) => change(() => (profile.defaults.background = v), true),
        { type: "color" },
      );
      field(
        defaults,
        t("기본 그림자"),
        profile.defaults.shadow !== false,
        (v) => change(() => (profile.defaults.shadow = v), true),
        { type: "checkbox" },
      );
      field(
        defaults,
        t("빈 셀 표시"),
        !!profile.defaults.showEmptyCells,
        (v) => change(() => (profile.defaults.showEmptyCells = v), true),
        { type: "checkbox" },
      );
      button(defaults, t("모든 페이지에 기본 디자인 상속"), () =>
        change(() => {
          for (const p of profilePages(config, profile.id))
            p.inheritProfileDesign = true;
        }, true),
      );
      button(defaults, t("기본 디자인 초기화"), () => {
        change(() => (profile.defaults = {}), true);
        draw();
      });
      field(
        row,
        t("앱 포커스 시 자동 전환 · Bundle ID (쉼표 구분)"),
        (profile.focusApps || []).join(", "),
        (v) =>
          change(
            () =>
              (profile.focusApps = v
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)),
          ),
        { placeholder: "com.openai.chat, com.google.Chrome" },
      );
      button(
        row,
        profile.id === config.defaultProfileId
          ? t("기본 프로필")
          : t("기본으로 설정"),
        () => {
          change(() => (config.defaultProfileId = profile.id), true);
          draw();
        },
      );
      button(row, t("프로필 복제"), () => {
        if (config.pages.length + profile.pageIds.length > 40)
          return notice(t("페이지는 최대 40개입니다."), true);
        change(() => {
          const cloned = importProfile(
            config,
            portableProfile(config, profile.id),
          );
          cloned.name = profile.name + t(" 복사");
          profileId = cloned.id;
          pageId = cloned.defaultPageId;
        }, true);
        draw();
      });
      button(row, t("프로필 내보내기"), () =>
        exportFile(portableProfile(config, profile.id)),
      );
      if (config.profiles.length > 1)
        button(
          row,
          t("프로필 삭제 · 페이지 보존"),
          () => {
            if (!confirm(t("프로필을 삭제하고 페이지를 다른 프로필로 옮길까요?")))
              return;
            change(() => {
              const target = config.profiles.find((p) => p.id !== profile.id);
              target.pageIds.push(...profile.pageIds);
              config.profiles = config.profiles.filter(
                (p) => p.id !== profile.id,
              );
              if (config.defaultProfileId === profile.id)
                config.defaultProfileId = target.id;
              profileId = target.id;
              selected = null;
            }, true);
            draw();
          },
          "danger",
        );
    }
  }
  button(dialog, t("＋ 새 프로필"), () => {
    if (config.pages.length >= 40)
      return notice(t("페이지는 최대 40개입니다."), true);
    const name = prompt(t("프로필 이름"), t("새 프로필"));
    if (!name) return;
    change(() => {
      const p = {
        id: uid(),
        name: t("홈"),
        columns: 4,
        rows: 3,
        theme: "midnight",
        gap: 12,
        radius: 13,
        widgets: [],
      };
      config.pages.push(p);
      const profile = { id: uid(), name, pageIds: [p.id], defaultPageId: p.id };
      config.profiles.push(profile);
      profileId = profile.id;
      pageId = p.id;
      selected = null;
    }, true);
    draw();
  });
  button(
    dialog,
    t("저장"),
    async () => {
      try {
        await save();
        dialog.close();
      } catch (e) {
        notice(e.message, true);
      }
    },
    "primary",
  );
  button(dialog, t("닫기"), () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());
  draw();
  document.body.append(dialog);
  dialog.showModal();
}
$("#manageProfiles").onclick = profileManager;
function selectedIds() {
  return new Set(
    selectedWidgets.size ? selectedWidgets : selected ? [selected] : [],
  );
}
function updateSelection() {
  const count = selectedIds().size;
  $("#selectionCount").textContent = count
    ? tf("{0}개 선택됨", count)
    : t("Shift+클릭으로 여러 위젯 선택");
  $("#pasteWidgets").disabled = !widgetClipboard.length;
  $("#pasteStyle").disabled = !styleClipboard || !count;
}
function copyWidgets() {
  const ids = selectedIds();
  widgetClipboard = structuredClone(
    page().widgets.filter((w) => ids.has(w.id)),
  );
  updateSelection();
  notice(tf("{0}개 위젯을 복사했습니다.", widgetClipboard.length));
}
function pasteWidgets() {
  if (!widgetClipboard.length) return;
  if (page().widgets.length + widgetClipboard.length > 128)
    return notice(t("페이지당 최대 128개입니다."), true);
  change(() => {
    selectedWidgets.clear();
    for (const original of widgetClipboard) {
      const w = structuredClone(original);
      w.id = uid();
      w.x = 0;
      w.y = 0;
      page().widgets.push(w);
      selectedWidgets.add(w.id);
    }
    ensurePlace();
    selected = selectedWidgets.values().next().value;
  }, true);
}
function deleteWidgets() {
  const ids = selectedIds();
  if (!ids.size) return;
  change(() => {
    page().widgets = page().widgets.filter((w) => !ids.has(w.id));
    config.automations = (config.automations || []).filter(
      (a) => !ids.has(a.widgetId),
    );
    selected = null;
    selectedWidgets.clear();
  }, true);
}
$("#copyWidgets").onclick = copyWidgets;
$("#pasteWidgets").onclick = pasteWidgets;
$("#deleteWidgets").onclick = deleteWidgets;
$("#copyStyle").onclick = () => {
  if (!widget()) return;
  styleClipboard = {
    style: structuredClone(widget().style || {}),
    color: widget().color,
  };
  updateSelection();
};
$("#pasteStyle").onclick = () => {
  if (!styleClipboard) return;
  const ids = selectedIds();
  change(() => {
    for (const w of page().widgets)
      if (ids.has(w.id)) {
        w.style = structuredClone(styleClipboard.style);
        w.color = styleClipboard.color;
      }
  }, true);
};
$("#moveWidgets").onclick = () => {
  const ids = selectedIds();
  if (!ids.size) return;
  const choices = config.pages.filter((p) => p.id !== pageId);
  if (!choices.length) return notice(t("이동할 페이지를 먼저 추가하세요."), true);
  const dialog = n("dialog", undefined, "profile-dialog");
  dialog.append(n("h2", t("선택한 위젯 이동")));
  let targetId = choices[0].id;
  field(dialog, t("이동할 페이지"), targetId, (v) => (targetId = v), {
    choices: Object.fromEntries(choices.map((p) => [p.id, p.name])),
  });
  button(
    dialog,
    t("이동"),
    () => {
      const target = config.pages.find((p) => p.id === targetId),
        source = page();
      const moved = source.widgets.filter((w) => ids.has(w.id));
      if (target.widgets.length + moved.length > 128)
        return notice(t("대상 페이지가 가득 찼습니다."), true);
      change(() => {
        source.widgets = source.widgets.filter((w) => !ids.has(w.id));
        target.widgets.push(...moved);
        target.rows = place(target.widgets, target.columns, target.rows, true);
        pageId = target.id;
        profileId = config.profiles.find((p) =>
          p.pageIds.includes(target.id),
        )?.id;
        selected = null;
        selectedWidgets.clear();
      }, true);
      dialog.close();
    },
    "primary",
  );
  button(dialog, t("취소"), () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
};
document.addEventListener("keydown", (e) => {
  if (
    ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName) ||
    document.querySelector("dialog[open]")
  )
    return;
  if (e.metaKey || e.ctrlKey) {
    if (e.key.toLowerCase() === "c") {
      e.preventDefault();
      copyWidgets();
    }
    if (e.key.toLowerCase() === "v") {
      e.preventDefault();
      pasteWidgets();
    }
    if (e.key.toLowerCase() === "a") {
      e.preventDefault();
      selectedWidgets.clear();
      page().widgets.forEach((w) => selectedWidgets.add(w.id));
      selected = page().widgets[0]?.id;
      renderBoard();
    }
  }
  if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    deleteWidgets();
  }
});
