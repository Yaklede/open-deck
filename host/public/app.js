import { migrate, place, overlaps, themes } from "./layout.mjs";
import { monitorPage } from "./monitor-layout.mjs";
import { monitorSettings, monitorRuleNames } from "./monitor-rules.mjs";
const $ = (s) => document.querySelector(s),
  uid = () => crypto.randomUUID();
let config,
  pageId,
  selected = null,
  dirty = false,
  info,
  state = { cpu: 0, memory: 0, volume: 50 },
  portrait = false,
  pluginItems = [];
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
const names = {
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
};
const kinds = {
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
};
const n = (tag, text, cls) => {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
};
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
  if (!r.ok) throw Error(d.error || r.statusText);
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
  $("#saved").textContent = "저장하지 않은 변경";
  $("#save").textContent = "변경 저장 ·";
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
  $("#pages").replaceChildren(
    ...config.pages.map((p) => {
      const b = n(
        "button",
        (p.parentId ? "　" : "") + "▦ " + p.name,
        p.id === pageId ? "selected" : "",
      );
      b.onclick = () => {
        pageId = p.id;
        selected = null;
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
  const p = page(),
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
  b.replaceChildren(
    ...items.map((w) => {
      const s = w.style || {},
        c = n(
          "div",
          undefined,
          "card" +
            (selected === w.id ? " selected" : "") +
            (w.type === "spacer" ? " spacer" : ""),
        );
      c.tabIndex = 0;
      c.setAttribute("role", "button");
      c.setAttribute("aria-label", w.label + " 편집");
      c.dataset.widgetId = w.id;
      c.dataset.type = w.type;
      c.draggable = !portrait;
      c.style.gridColumn = `${w.x + 1} / span ${w.w}`;
      c.style.gridRow = `${w.y + 1} / span ${w.h}`;
      c.style.background = s.background || theme.surface;
      c.style.color = w.color || theme.accent;
      c.style.border = `${s.borderWidth ?? (w.type === "button" || w.type === "page" ? 1 : 0)}px solid ${s.borderColor || w.color || theme.accent}`;
      c.style.borderRadius = p.radius + "px";
      c.style.opacity = (s.opacity ?? 100) / 100;
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
        body.append(n("div", "연결을 기다리고 있어요.", "os-reading"));
      else if (w.type === "todo")
        body.append(n("div", "할 일을 태블릿에서 추가하세요.", "todo-reading"));
      else if (w.type === "graph") {
        const plot = n("div", undefined, "graph-bars");
        for (let i = 0; i < 40; i++) plot.append(n("i"));
        body.append(plot);
      }
      c.append(body, n("div", labelText(w.label), "label"));
      const resize = n("button", "↘", "resize-handle");
      resize.setAttribute("aria-label", "크기 조절");
      if (!portrait) {
        c.append(resize);
        resize.onpointerdown = (e) => resizeStart(e, c, w);
      }
      c.onclick = (e) => {
        if (e.target === resize) return;
        selected = w.id;
        $("#inspector").hidden = false;
        inspect();
        document
          .querySelectorAll(".card.selected")
          .forEach((e) => e.classList.remove("selected"));
        c.classList.add("selected");
      };
      c.onkeydown = (e) => {
        if (
          ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key) &&
          !portrait
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
  updateLive();
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
    return notice("빈 공간에 배치하세요. 위젯은 서로 겹칠 수 없습니다.", true);
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
  const ws = new Map(page().widgets.map((w) => [w.id, w]));
  for (const c of $("#board").children) {
    const w = ws.get(c.dataset.widgetId);
    if (!w) continue;
    const value = state.variables?.[w.binding] ?? state[w.binding] ?? 0;
    c.querySelector(".label").textContent = labelText(w.label);
    if (w.type === "clock")
      c.querySelector(".clock").textContent = new Date().toLocaleTimeString(
        "ko-KR",
        { hour: "2-digit", minute: "2-digit", hour12: false },
      );
    if (w.type === "system") {
      const target = c.querySelector(".system-reading"),
        s = state.system;
      if (!s || s.status !== "connected")
        target.textContent = "맥 상태 연결 대기";
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
                "\n메모리 압력 " +
                ({ normal: "정상", warning: "주의", critical: "높음" }[
                  s.memory?.pressure
                ] || "확인 중")
              : w.metric === "disk"
                ? "여유 " + bytes(s.disk?.availableBytes)
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
                        normal: "발열 정상",
                        fair: "발열 약간 높음",
                        serious: "발열 높음",
                        critical: "발열 매우 높음",
                      }[s.power?.thermal] || "확인 중")
                    : w.metric === "processes"
                      ? (s.processes?.cpu || [])
                          .slice(0, 3)
                          .map(
                            (p) =>
                              p.name + " · " + p.cpuPercent.toFixed(1) + "%",
                          )
                          .join("\n") || "앱 사용량 비교 중"
                      : (s.model || "내 Mac") + "\n실시간 시스템 상태";
      }
    }
    if (w.type === "grafana") {
      const p =
          w.projects?.find((p) => p.value === w.defaultProject) ||
          w.projects?.[0],
        data = state.grafana?.widgets?.[w.id]?.projects?.[p?.value];
      const disconnected = !state.at || Date.now() - state.at >= 8000;
      const pct = (v) => (v == null ? "수집 없음" : v.toFixed(1) + "%");
      c.querySelector(".system-reading").textContent =
        (p?.label || "프로젝트 선택") +
        "\n" +
        (data?.status === "ready" && !disconnected
          ? w.metric === "system"
            ? "시스템 CPU " +
              pct(data.system?.value) +
              "\n지표 수집 " +
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
                : "DB 노드 지표 수집 없음") +
              "\n전체 TPS " +
              (data.tps.value == null ? "—" : data.tps.value.toFixed(2)) +
              " · 전체 QPS " +
              (data.qps?.value == null ? "—" : data.qps.value.toFixed(2)) +
              " · DB 연결 " +
              (data.database?.connections == null
                ? "—"
                : data.database.connections.toFixed(0))
          : disconnected
            ? "연결 끊김 · 자동 재연결 중"
            : data?.message || "지표 조회 대기");
      const key = w.metric === "system" ? "system" : "cpu",
        source = data?.freshness?.[key];
      const at = source?.sampleAt || source?.lastSampleAt;
      const stamp = at
        ? new Date(at).toLocaleTimeString("ko-KR", {
            hour12: false,
            timeZone: "Asia/Seoul",
          })
        : "확인 불가";
      const age = at ? Math.max(0, Math.floor((Date.now() - at) / 1000)) : null;
      c.querySelector(".system-reading").textContent +=
        "\n원본 수집 " +
        stamp +
        (age == null ? "" : " · " + age + "초 전") +
        (source?.status === "delayed"
          ? " · 수집 지연"
          : source?.status === "stale"
            ? " · 오래된 데이터"
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
        ? "● 켜짐"
        : "○ 꺼짐";
    if (w.type === "calendar" && !w.provider)
      c.querySelector(".calendar-reading").textContent =
        new Date().toLocaleDateString("ko-KR", {
          month: "long",
          day: "numeric",
          weekday: "long",
        });
    if (w.provider === "jimin-os") {
      const provider = state.extensions?.["jimin-os"],
        data = provider?.data;
      const target = c.querySelector(".os-reading,.calendar-reading");
      if (target) {
        if (!data) target.textContent = "Jimin OS 연결을 기다리고 있어요.";
        else if (w.type === "inbox")
          target.textContent =
            `새 업무 요청 ${data.counts.requests} · 업데이트 ${data.counts.updates}\n` +
            data.inbox
              .slice(0, 3)
              .map((x) => x.title)
              .join("\n");
        else if (w.type === "notification-feed")
          target.textContent = `알림 ${(state.notifications || []).length}개`;
        else
          target.textContent =
            (data.events || [])
              .filter((x) => Date.parse(x.endsAt) > Date.now())
              .slice(0, w.type === "calendar" ? 6 : 3)
              .map(
                (x) =>
                  new Date(x.startsAt).toLocaleString("ko-KR", {
                    month: "numeric",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  }) +
                  "  " +
                  x.title,
              )
              .join("\n") || "다가오는 일정이 없어요.";
        if (data) {
          const stale =
            provider.status !== "connected" ||
            Date.now() - data.updatedAt >= 45000;
          const stamp = new Date(data.updatedAt).toLocaleString("ko-KR", {
            month: "numeric",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          });
          target.textContent =
            (stale ? "이전 데이터 · 자동 재연결 중" : "최신 데이터") +
            " · " +
            stamp +
            " 수집\n" +
            target.textContent;
        }
      }
    }
    if (w.type === "todo")
      c.querySelector(".todo-reading").textContent =
        (state.todos?.[w.id] || [])
          .slice(0, 5)
          .map((x) => (x.done ? "✓ " : "○ ") + x.text)
          .join("\n") || "할 일을 태블릿에서 추가하세요.";
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
  field(box, "기본 테마", p.theme, (v) => change(() => (p.theme = v)), {
    choices: Object.fromEntries(Object.keys(themes).map((k) => [k, k])),
  });
  field(
    box,
    "배경색",
    p.background || themes[p.theme].background,
    (v) => change(() => (p.background = v)),
    { type: "color" },
  );
  field(
    box,
    "그라데이션",
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
      "두 번째 색",
      p.gradient,
      (v) => change(() => (p.gradient = v)),
      { type: "color" },
    );
  field(box, "간격", p.gap, (v) => change(() => (p.gap = v)), {
    type: "range",
    min: 0,
    max: 32,
  });
  field(box, "모서리", p.radius, (v) => change(() => (p.radius = v)), {
    type: "range",
    min: 0,
    max: 40,
  });
  field(
    box,
    "세로 화면 열",
    p.portrait?.columns || 2,
    (v) =>
      change(() => (p.portrait = { columns: v, rows: p.portrait?.rows || 1 })),
    { type: "number", min: 2, max: 12 },
  );
  field(
    box,
    "상위 페이지",
    p.parentId || "",
    (v) =>
      change(() => {
        if (v) p.parentId = v;
        else delete p.parentId;
      }, true),
    {
      choices: {
        "": "없음",
        ...Object.fromEntries(
          config.pages.filter((x) => x.id !== p.id).map((x) => [x.id, x.name]),
        ),
      },
    },
  );
  button(box, "배경 이미지", () =>
    upload((id) => change(() => (p.backgroundImage = id))),
  );
  if (p.backgroundImage)
    button(box, "배경 이미지 제거", () =>
      change(() => delete p.backgroundImage),
    );
  button(box, "테마 내보내기", () =>
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
  field(box, "이름 / {{변수}}", w.label, (v) => change(() => (w.label = v)));
  field(
    box,
    "강조색",
    w.color || "#8bb8ff",
    (v) => change(() => (w.color = v)),
    { type: "color" },
  );
  const size = n("div", undefined, "two");
  box.append(size);
  for (const [key, title, max] of [
    ["w", "너비", page().columns],
    ["h", "높이", Math.min(12, page().rows)],
  ])
    field(size, title, w[key], (v) => move(w, { ...w, [key]: v }), {
      type: "number",
      min: 1,
      max,
    });
  if (["button", "page"].includes(w.type))
    field(
      box,
      "아이콘",
      w.icon || "monitor",
      (v) => change(() => (w.icon = v)),
      { choices: Object.fromEntries(Object.keys(paths).map((k) => [k, k])) },
    );
  if (["button", "page", "image"].includes(w.type)) {
    button(box, w.image ? "이미지 변경" : "이미지 선택", () =>
      upload((id) => change(() => (w.image = id))),
    );
    if (w.image) button(box, "이미지 제거", () => change(() => delete w.image));
  }
  if (["calendar", "agenda", "inbox", "notification-feed"].includes(w.type))
    field(
      box,
      "데이터 연결",
      w.provider || "",
      (v) =>
        change(() => {
          if (v) w.provider = v;
          else delete w.provider;
        }),
      { choices: { "": "로컬", "jimin-os": "Jimin OS" } },
    );
  if (w.type === "system")
    field(
      box,
      "시스템 지표",
      w.metric || "overview",
      (v) =>
        change(() => {
          w.metric = v;
          if (v !== "overview") w.compact = false;
        }),
      {
        choices: {
          overview: "맥 상태 요약",
          cpu: "CPU",
          memory: "메모리 압력·사용량",
          disk: "저장 공간·디스크 I/O",
          network: "네트워크",
          processes: "사용량 높은 앱",
          power: "전원·발열",
        },
      },
    );
  if (w.type === "system" && (!w.metric || w.metric === "overview"))
    field(
      box,
      "한 카드로 요약",
      !!w.compact,
      (v) => change(() => (w.compact = v)),
      { type: "checkbox" },
    );
  if (["grafana", "system"].includes(w.type)) {
    const alertBox = n("details");
    alertBox.append(n("summary", "임계치 · 태블릿 알림"));
    box.append(alertBox);
    const settings = monitorSettings(w);
    const edit = (key, value) =>
      change(() => {
        w.alerts ??= structuredClone(settings);
        w.alerts[key] = value;
      });
    field(
      alertBox,
      "위험 색상 표시",
      settings.enabled,
      (v) => edit("enabled", v),
      { type: "checkbox" },
    );
    field(alertBox, "태블릿 알림", settings.notify, (v) => edit("notify", v), {
      type: "checkbox",
    });
    field(
      alertBox,
      "지속 시간 (초)",
      settings.holdSeconds,
      (v) => edit("holdSeconds", v),
      { type: "number", min: 0, max: 3600 },
    );
    field(
      alertBox,
      "재알림 간격 (초)",
      settings.cooldownSeconds,
      (v) => edit("cooldownSeconds", v),
      { type: "number", min: 60, max: 86400 },
    );
    alertBox.append(
      n(
        "p",
        "초록 정상 · 주황 주의 · 빨강 위험. 설정한 시간 이상 유지되면 알림을 보내고 정상 복구도 알려드려요.",
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
      field(group, "임계치 사용", rule.enabled, (v) => setRule("enabled", v), {
        type: "checkbox",
      });
      field(group, "기준", rule.direction, (v) => setRule("direction", v), {
        choices: { above: "이상일 때", below: "이하일 때" },
      });
      for (const [name, title] of [
        ["warning", "주의"],
        ["critical", "위험"],
      ]) {
        const input = field(group, title, rule[name], () => {}, {
          type: "number",
          min: 0,
        });
        input.step = "any";
        input.placeholder = "임계치 입력";
        input.onchange = () =>
          setRule(name, input.value.trim() === "" ? null : Number(input.value));
      }
    }
    button(alertBox, "태블릿 알림 테스트", async () => {
      if (dirty) {
        notice("변경 저장 후 알림을 테스트해 주세요.", true);
        return;
      }
      try {
        await api("/api/admin/monitor-test", "POST", { widgetId: w.id });
        notice("태블릿에 테스트 알림을 보냈습니다.");
      } catch (e) {
        notice(e.message, true);
      }
    });
    if (w.type === "grafana" && w.metric !== "system")
      alertBox.append(
        n(
          "p",
          "TPS·QPS·연결 수는 임계치를 입력한 뒤 켜세요. 처리량 감소를 감지하려면 ‘이하일 때’를 선택하세요.",
        ),
      );
  }
  if (w.type === "grafana") {
    field(
      box,
      "표시 지표",
      w.metric || "database",
      (v) => change(() => (w.metric = v)),
      {
        choices: {
          system: "시스템 CPU · 수집 상태",
          database: "DB 상태 · CPU · TPS",
        },
      },
    );
    field(box, "Grafana HTTPS 대시보드 주소", w.url || "", (v) =>
      change(() => (w.url = v)),
    );
    field(box, "조회 토큰 사용", !!w.auth, (v) => change(() => (w.auth = v)), {
      type: "checkbox",
    });
    field(
      box,
      "CPU 패널 ID",
      w.cpuPanelId || 1,
      (v) => change(() => (w.cpuPanelId = v)),
      { type: "number", min: 1 },
    );
    field(
      box,
      "TPS 합계 패널 ID",
      w.tpsPanelId || 2,
      (v) => change(() => (w.tpsPanelId = v)),
      { type: "number", min: 1 },
    );
    const token = n("input");
    token.type = "password";
    token.autocomplete = "off";
    token.placeholder = "조회 전용 토큰 · 맥 키체인에만 저장";
    token.setAttribute("aria-label", "Grafana 조회 토큰");
    box.append(token);
    button(box, "조회 토큰 키체인에 저장", async () => {
      if (dirty) {
        notice("변경 저장 후 토큰을 등록해 주세요.", true);
        return;
      }
      try {
        await api("/api/admin/grafana-token", "POST", {
          widgetId: w.id,
          token: token.value,
        });
        token.value = "";
        notice("Grafana 조회 토큰을 키체인에 저장했습니다.");
      } catch (e) {
        notice(e.message, true);
      }
    });
    field(box, "프로젝트 필터 이름", w.projectVariable || "project", (v) =>
      change(() => (w.projectVariable = v)),
    );
    (w.projects || []).forEach((p, i) => {
      field(box, "프로젝트 " + (i + 1) + " 이름", p.label, (v) =>
        change(() => (p.label = v)),
      );
      field(box, "프로젝트 " + (i + 1) + " 필터 값", p.value, (v) =>
        change(() => (p.value = v)),
      );
      if (w.projects.length > 1)
        button(box, "프로젝트 " + (i + 1) + " 제거", () =>
          change(() => {
            w.projects.splice(i, 1);
            if (w.defaultProject === p.value)
              w.defaultProject = w.projects[0].value;
          }, true),
        );
    });
    button(box, "프로젝트 추가", () =>
      change(
        () =>
          w.projects.push({
            label: "새 프로젝트",
            value: "project-" + (w.projects.length + 1),
          }),
        true,
      ),
    );
    field(
      box,
      "기본 프로젝트",
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
    field(box, "타이머 (분)", w.minutes, (v) => change(() => (w.minutes = v)), {
      type: "number",
      min: 1,
      max: 1440,
    });
  if (w.type === "page")
    field(
      box,
      "이동할 페이지",
      w.targetPage,
      (v) => change(() => (w.targetPage = v)),
      { choices: Object.fromEntries(config.pages.map((p) => [p.id, p.name])) },
    );
  if (["text", "toggle", "slider", "graph"].includes(w.type))
    field(
      box,
      "연결 변수",
      w.binding || "",
      (v) => change(() => (w.binding = v)),
      {
        choices: {
          "": "선택 안 함",
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
          ...(w.type === "graph" ? { cpu: "CPU", memory: "메모리" } : {}),
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
    summary = n("summary", "글자 · 색상 · 모양");
  style.append(summary);
  box.append(style);
  w.style ??= {};
  const freeLabel = ["button", "page", "text", "image"].includes(w.type);
  if (freeLabel)
    for (const [key, title, choices] of [
      [
        "labelPosition",
        "글자 위치",
        { top: "위", center: "가운데", bottom: "아래", hidden: "숨김" },
      ],
      [
        "align",
        "글자 정렬",
        { left: "왼쪽", center: "가운데", right: "오른쪽" },
      ],
      ["font", "글꼴", { sans: "기본", mono: "고정폭", serif: "세리프" }],
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
      "지표 숫자 크기",
      w.style.valueSize ||
        (w.type === "system" ? 28 : w.metric === "system" ? 44 : 36),
      (v) => change(() => (w.style.valueSize = v)),
      { type: "number", min: 20, max: 60 },
    );
  for (const [key, title, value, min, max] of [
    ["textSize", "글자 크기", 17, 9, 36],
    ["iconSize", "아이콘 크기 (%)", 32, 10, 65],
    ["borderWidth", "테두리", 1, 0, 5],
    ["opacity", "불투명도 (%)", 100, 20, 100],
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
    ["textColor", "글자색", themes[page().theme].text],
    ["background", "버튼 배경", themes[page().theme].surface],
    ["borderColor", "테두리색", w.color || "#8bb8ff"],
  ].filter(([key]) => key !== "textColor" || freeLabel))
    field(
      style,
      title,
      w.style[key] || value,
      (v) => change(() => (w.style[key] = v)),
      { type: "color" },
    );
  button(style, "스타일 초기화", () => change(() => (w.style = {}), true));
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
      "동작",
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
      field(row, "Chrome 프로필 폴더", a.profile || "Default", (v) => {
        checkpoint();
        a.profile = v;
        changed();
      });
    if (["setVariable", "increment", "toggleVariable", "if"].includes(a.type))
      field(
        row,
        "변수",
        a.variable || "",
        (v) => {
          checkpoint();
          a.variable = v;
          changed();
        },
        {
          choices: {
            "": "변수 선택",
            ...Object.fromEntries(
              Object.keys(config.variables).map((k) => [k, k]),
            ),
          },
        },
      );
    if (a.type === "http")
      field(
        row,
        "연동",
        a.integrationId || "",
        (v) => {
          checkpoint();
          a.integrationId = v;
          changed();
        },
        {
          choices: {
            "": "연동 선택",
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
        "값",
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
                : "값",
        },
      );
    if (a.type === "extension") {
      a.extensionId = "jimin-os";
      a.operation ||= "navigate";
      a.parameters ||= { view: "home" };
      field(
        row,
        "열 화면",
        a.operation === "refresh" ? "refresh" : a.parameters.view,
        (v) => {
          checkpoint();
          a.operation = v === "refresh" ? "refresh" : "navigate";
          a.parameters = v === "refresh" ? {} : { view: v };
          changed();
        },
        {
          choices: {
            home: "나의 하루",
            requests: "업무 요청",
            scheduled: "예약 업무",
            calendar: "일정",
            tasks: "할 일",
            meetings: "회의 기록",
            memory: "기억",
            assistant: "지민에게 말하기",
            "new-schedule": "일정 추가",
            "new-task": "할 일 추가",
            refresh: "새로고침",
          },
        },
      );
    }
    if (a.type === "plugin") {
      field(row, "플러그인 ID", a.pluginId || "", (v) => {
        checkpoint();
        a.pluginId = v;
        changed();
      });
      field(row, "동작 ID", a.actionId || "", (v) => {
        checkpoint();
        a.actionId = v;
        changed();
      });
      field(row, "매개변수 (JSON)", JSON.stringify(a.parameters || {}), (v) => {
        try {
          const parsed = JSON.parse(v);
          if (!parsed || Array.isArray(parsed) || typeof parsed !== "object")
            throw Error();
          checkpoint();
          a.parameters = parsed;
          changed();
        } catch {
          notice("JSON 객체를 입력하세요.", true);
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
    button(actions, "삭제", () => {
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
      w.targetPage = config.pages.find((x) => x.id !== p.id)?.id || p.id;
    if (type === "graph") w.binding = "cpu";
    if (type === "system") w.metric = "overview";
    if (type === "grafana")
      Object.assign(w, {
        url: "",
        projects: [{ label: "프로젝트", value: "project" }],
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
function addPage(name = "새 페이지", template = "empty") {
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
      back.label = "Workspace로";
      back.icon = "tasks";
      selected = null;
    }, true);
  }
}
async function save() {
  const result = await api("/api/admin/config", "PUT", config);
  config = result.config || config;
  dirty = false;
  $("#saved").textContent = "모든 변경 저장됨";
  $("#save").textContent = "변경 저장";
  notice("태블릿에 반영했습니다.");
}
async function upload(done) {
  const input = $("#imageFile");
  input.onchange = async () => {
    try {
      const file = input.files[0];
      if (!file) return;
      if (file.size > 2097152) throw Error("이미지는 2MB 이하여야 합니다.");
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
        if (!res.ok) throw Error("이미지를 내보내지 못했습니다.");
        const blob = await res.blob();
        data.assets[id] = await new Promise((resolve) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.readAsDataURL(blob);
        });
      }
    }
    const text = JSON.stringify(data, null, 2);
    if (new TextEncoder().encode(text).length >= 16777216)
      throw Error("이미지를 포함한 백업은 16MB 이하여야 합니다.");
    if (window.webkit?.messageHandlers?.exportConfig) {
      window.webkit.messageHandlers.exportConfig.postMessage(text);
      return;
    }
    const a = n("a");
    a.href = URL.createObjectURL(
      new Blob([text], { type: "application/json" }),
    );
    a.download = data.kind ? "open-deck-theme.json" : "open-deck.json";
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
    field(row, "초깃값", JSON.stringify(value), (v) => {
      try {
        const parsed = JSON.parse(v);
        if (!["number", "boolean", "string"].includes(typeof parsed))
          throw Error();
        checkpoint();
        config.variables[key] = parsed;
        changed();
      } catch {
        notice(
          "숫자, true/false 또는 따옴표로 감싼 문자열을 입력하세요.",
          true,
        );
      }
    });
    row.append(
      n(
        "span",
        "현재: " + String(state.variables?.[key] ?? value),
        "text-muted",
      ),
    );
    button(row, "삭제", () => change(() => delete config.variables[key], true));
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
    field(row, "이름", i.name, (v) => {
      set("name", v);
      summary.textContent = v;
    });
    field(row, "URL", i.url, (v) => set("url", v), {
      placeholder: "https://service.example/api/status",
    });
    field(row, "메서드", i.method || "GET", (v) => set("method", v), {
      choices: Object.fromEntries(
        ["GET", "POST", "PUT", "PATCH", "DELETE"].map((k) => [k, k]),
      ),
    });
    field(row, "JSON 경로 (예: result.count)", i.path || "", (v) =>
      set("path", v),
    );
    field(row, "저장 변수", i.variable || "", (v) => set("variable", v), {
      choices: {
        "": "저장 안 함",
        ...Object.fromEntries(Object.keys(config.variables).map((k) => [k, k])),
      },
    });
    field(
      row,
      "주기 (초)",
      i.intervalSeconds || 60,
      (v) => set("intervalSeconds", v),
      { type: "number", min: 5, max: 86400 },
    );
    field(row, "자동 갱신 (GET만)", i.enabled, (v) => set("enabled", v), {
      type: "checkbox",
    });
    field(row, "Bearer 토큰 사용", i.auth, (v) => set("auth", v), {
      type: "checkbox",
    });
    field(row, "요청 본문 JSON", i.body || "", (v) => set("body", v));
    field(
      row,
      "Bearer 토큰 · macOS 키체인에 저장",
      "",
      async (v) => {
        try {
          await api("/api/admin/secret", "POST", { id: i.id, value: v });
          notice("인증 토큰을 키체인에 저장했습니다.");
        } catch (e) {
          notice(e.message, true);
        }
      },
      { type: "password" },
    );
    button(row, "지금 갱신", async () => {
      try {
        await save();
        const r = await api("/api/admin/refresh", "POST", { id: i.id });
        notice("응답: " + String(r.value));
      } catch (e) {
        notice(e.message, true);
      }
    });
    button(row, "삭제", () =>
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
        st?.state === "error" ? st.message : st?.state || "미연결",
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
  field(form, "플러그인 폴더", folder, (v) => (folder = v), {
    placeholder: "/폴더/manifest.json이 들어 있는 경로",
  });
  button(form, "폴더 등록", async () => {
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
        "지원: " +
          (accepted.length
            ? [...new Set(accepted)].join(", ")
            : "연결 후 확인"),
      ),
    );
    if (rejected.length) row.append(n("p", "미지원: " + rejected.join(", ")));
    for (const op of [p.enabled ? "stop" : "start", "remove"])
      button(
        row,
        op === "start" ? "실행" : op === "stop" ? "중지" : "등록 해제",
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
    button(row, "상태 새로고침", () =>
      refreshPlugins().catch((e) => notice(e.message, true)),
    );
    for (const a of p.actions || []) {
      const action = n("div", undefined, "variable-row");
      action.append(n("code", a.localId));
      button(action, "동작 버튼 추가", () => {
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
      button(line, "값 위젯 추가", () => {
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
      "사용",
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
      "실행 조건",
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
          time: "요일 · 시간",
          variable: "변수 변경",
          plugin: "플러그인 이벤트",
        },
      },
    );
    if (a.trigger === "variable") {
      field(
        row,
        "변수",
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
        "값 조건 (JSON · 비우면 모든 변경)",
        a.equals === undefined ? "" : JSON.stringify(a.equals),
        (v) => {
          try {
            const parsed = v ? JSON.parse(v) : undefined;
            checkpoint();
            if (parsed === undefined) delete a.equals;
            else a.equals = parsed;
            changed();
          } catch {
            notice("JSON 값을 입력하세요.", true);
          }
        },
      );
    } else if (a.trigger === "plugin") {
      field(row, "플러그인 ID", a.pluginId || "", (v) => {
        checkpoint();
        a.pluginId = v;
        changed();
      });
      field(row, "이벤트 ID", a.eventId || "", (v) => {
        checkpoint();
        a.eventId = v;
        changed();
      });
    }
    if (a.trigger && a.trigger !== "time")
      field(
        row,
        "최소 간격 (초)",
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
        "시간",
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
      "버튼",
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
    ["일", "월", "화", "수", "목", "금", "토"].forEach((d, i) =>
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
    button(row, "삭제", () =>
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
      "위젯이 놓인 행은 제거할 수 없습니다. 먼저 이동하거나 자동 정렬하세요.",
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
  $("#orientation").textContent = portrait ? "세로 미리보기" : "가로 미리보기";
  $("#previewHint").textContent = portrait
    ? "세로 배치는 자동으로 정렬됩니다. 가로 미리보기에서 위젯을 편집하세요."
    : "드래그로 이동 · 오른쪽 아래 모서리로 크기 조절 · 방향키 이동 / Alt+방향키 크기 조절";
  renderBoard();
};
for (const type of Object.keys(names))
  button($("#palette"), "+ " + names[type], () => addWidget(type));
$("#addPage").onclick = () => {
  const name = prompt("페이지 이름", "새 페이지");
  if (name) addPage(name);
};
$("#renamePage").onclick = () => {
  const name = prompt("페이지 이름", page().name);
  if (name) change(() => (page().name = name), true);
};
$("#duplicatePage").onclick = () =>
  change(() => {
    const p = structuredClone(page());
    p.id = uid();
    p.name += " 복사";
    for (const w of p.widgets) w.id = uid();
    config.pages.push(p);
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
  if (config.pages.length === 1)
    return notice("페이지 하나는 남겨 두세요.", true);
  if (!confirm("이 페이지를 삭제할까요? 실행 취소로 복구할 수 있습니다."))
    return;
  change(() => {
    const id = pageId;
    const removed = new Set(page().widgets.map((w) => w.id));
    config.automations = (config.automations || []).filter(
      (a) => !removed.has(a.widgetId),
    );
    config.pages = config.pages.filter((p) => p.id !== id);
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
  if (v) addPage(v === "focus" ? "집중" : "모니터", v);
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
    w.label += " 복사";
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
    if (!Array.isArray(a)) throw Error("배열이 필요합니다.");
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
    notice("실행했습니다.");
  } catch (e) {
    notice(e.message, true);
  }
};
$("#addVariable").onclick = () => {
  const key = prompt("변수 이름 (영문·숫자·밑줄)", "counter");
  if (!key) return;
  if (
    !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) ||
    Object.hasOwn(config.variables, key)
  )
    return notice("중복되지 않는 영문 변수 이름을 입력하세요.", true);
  change(() => (config.variables[key] = 0), true);
};
$("#addConnector").onclick = () =>
  change(
    () =>
      config.integrations.push({
        id: uid().replaceAll("-", ""),
        type: "http",
        name: "새 HTTP 연동",
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
    if (f.size > 16777216) throw Error("백업 파일은 16MB 이하여야 합니다.");
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
        throw Error("이미지 파일 검증에 실패했습니다.");
    }
    delete raw.assets;
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
$("#devicesToggle").onclick = async () => {
  try {
    const r = await api("/api/admin/info");
    $("#devices").hidden = !$("#devices").hidden;
    $("#wifiInfo").textContent = (r.network?.urls || []).join(" · ");
    $("#deviceList").replaceChildren(
      ...r.devices.map((d) => {
        const row = n("div", undefined, "device-row");
        row.append(n("span", d.name));
        button(row, "연결 해제", async () => {
          if (confirm("이 기기의 연결을 해제할까요?")) {
            await api("/api/admin/revoke", "POST", { id: d.id });
            row.remove();
          }
        });
        return row;
      }),
    );
  } catch (e) {
    notice(e.message, true);
  }
};
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
try {
  info = await api("/api/admin/info");
  config = migrate(info.config);
  pageId = config.pages[0].id;
  pin(info.pin);
  await refreshPlugins();
  render();
  const events = new EventSource("/api/events");
  events.onopen = () => {
    if ($("#notice").textContent === "맥 호스트 연결을 기다리는 중입니다.")
      notice(dirty ? "저장하지 않은 변경" : "다시 연결됨");
  };
  events.addEventListener("snapshot", (e) => {
    const snapshot = JSON.parse(e.data);
    state = snapshot.state;
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
  events.onerror = () => notice("맥 호스트 연결을 기다리는 중입니다.", true);
} catch (e) {
  notice(e.message, true);
}

function updateEcosystemStatus() {
  const status = $("#osStatus");
  if (!status) return;
  const p = state.extensions?.["jimin-os"];
  status.textContent =
    p?.status === "connected"
      ? "연결됨 · 일정과 업무 요청을 동기화하고 있어요."
      : p?.data
        ? "이전 데이터 · " +
          new Date(p.data.updatedAt).toLocaleTimeString("ko-KR") +
          " 수집 · 자동으로 다시 연결하고 있어요."
        : p?.enabled
          ? "자동으로 다시 연결하고 있어요. 맥에서 Jimin OS 앱과 로그인을 확인해 주세요."
          : "연결 전";
}
function renderEcosystem() {
  const box = $("#ecosystem");
  box.replaceChildren();
  box.append(n("p", "연결 상태를 확인하고 있어요.", "text-muted"));
  box.lastChild.id = "osStatus";
  updateEcosystemStatus();
  const options = config.extensions?.["jimin-os"] || {},
    draft = { ...options };
  field(
    box,
    "일정·새 업무 요청 알림",
    options.notifications !== false,
    (v) => (draft.notifications = v),
    { type: "checkbox" },
  );
  field(
    box,
    "일정과 마감 알림 (분 전)",
    options.reminderMinutes || 10,
    (v) => (draft.reminderMinutes = v),
    { type: "number", min: 1, max: 120 },
  );
  button(
    box,
    options.enabled ? "연결 설정 저장" : "연결하고 OS 탭 추가",
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
        notice("OS 탭을 연결했어요.");
      } catch (e) {
        notice(e.message, true);
      }
    },
    "primary",
  );
  button(box, "태블릿으로 연결 알림 보내기", async () => {
    try {
      await api("/api/admin/extensions/test-notification", "POST", {});
      notice("연결된 태블릿에 알림을 보냈어요.");
    } catch (e) {
      notice(e.message, true);
    }
  });
  if (options.enabled)
    button(box, "연결 끄기", async () => {
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
