const $ = (s) => document.querySelector(s);
let config,
  pageId,
  selected = null,
  dirty = false,
  info,
  state = { cpu: 0, memory: 0, volume: 50 };
const paths = {
  power: "M12 2v9 M6 5a9 9 0 1 0 12 0",
  globe:
    "M3 12h18 M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18 M12 3c-5 5-5 13 0 18c5-5 5-13 0-18",
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
const node = (tag, text, cls) => {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
};
function icon(name) {
  const box = node("div", undefined, "symbol");
  box.innerHTML = `<svg viewBox="0 0 24 24"><path d="${paths[name] || paths.monitor}"/></svg>`;
  return box;
}
async function api(url, method = "GET", body) {
  const r = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw Error(data.error || r.statusText);
  return data;
}
const currentPage = () =>
  config.pages.find((p) => p.id === pageId) || config.pages[0];
const current = () =>
  config.pages.flatMap((p) => p.widgets).find((w) => w.id === selected);
function notice(t, error = false) {
  $("#notice").textContent = t;
  $("#notice").style.color = error ? "#ffa4a4" : "#8fd7b6";
}
function changed() {
  dirty = true;
  $("#saved").textContent = "저장하지 않은 변경";
  $("#save").textContent = "변경 저장 ·";
}
function render() {
  $("#pages").replaceChildren(
    ...config.pages.map((p) => {
      const b = node(
        "button",
        "▦  " + p.name,
        p.id === pageId ? "selected" : "",
      );
      b.onclick = () => {
        pageId = p.id;
        selected = null;
        $("#inspector").hidden = true;
        render();
      };
      return b;
    }),
  );
  $("#pageTitle").textContent = currentPage().name;
  $("#columns").value = config.columns;
  $("#board").style.gridTemplateColumns =
    `repeat(${config.columns},minmax(0,1fr))`;
  renderBoard();
}
function renderBoard() {
  $("#board").replaceChildren(
    ...currentPage().widgets.map((w) => {
      const c = node(
        "div",
        undefined,
        "card" + (selected === w.id ? " selected" : ""),
      );
      c.style.borderColor = selected === w.id ? "#c3ccff" : w.color + "55";
      c.style.color = w.color;
      c.draggable = true;
      c.append(
        node(
          "span",
          w.type === "button" ? "ACTION" : w.type.toUpperCase(),
          "tag",
        ),
      );
      if (w.type === "clock")
        c.append(
          node(
            "div",
            new Date().toLocaleTimeString("ko-KR", {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            }),
            "clock",
          ),
        );
      else if (w.type === "gauges")
        c.append(node("div", `${state.cpu}%  /  ${state.memory}%`, "gauges"));
      else if (w.type === "timer")
        c.append(
          node("div", `${String(w.minutes).padStart(2, "0")}:00`, "clock"),
        );
      else if (w.type === "volume") {
        const r = node("input");
        r.type = "range";
        r.value = state.volume;
        r.disabled = true;
        c.append(r);
      } else if (w.type !== "text") c.append(icon(w.icon));
      c.append(node("div", w.label, "label"));
      c.onclick = () => edit(w.id);
      c.ondragstart = (e) => e.dataTransfer.setData("text/plain", w.id);
      c.ondragover = (e) => e.preventDefault();
      c.ondrop = (e) => {
        e.preventDefault();
        const widgets = currentPage().widgets,
          from = widgets.findIndex(
            (x) => x.id === e.dataTransfer.getData("text/plain"),
          ),
          to = widgets.indexOf(w);
        if (from < 0) return;
        widgets.splice(to, 0, widgets.splice(from, 1)[0]);
        changed();
        renderBoard();
      };
      return c;
    }),
  );
}
function edit(id) {
  selected = id;
  const w = current();
  $("#inspector").hidden = false;
  $("#label").value = w.label;
  $("#color").value = w.color || "#8bb8ff";
  $("#icon").value = w.icon || "monitor";
  $("#minutes").value = w.minutes || 25;
  $("#minutesRow").hidden = w.type !== "timer";
  $("#flowEditor").hidden = w.type !== "button";
  $("#icon").parentElement.hidden = w.type !== "button";
  renderActions();
  renderBoard();
}
const kinds = {
  openApp: "앱 실행",
  openUrl: "웹 페이지 열기",
  chrome: "Chrome 기존 탭 / 프로필",
  command: "쉘 명령 실행",
  wait: "기다리기 (ms)",
  mute: "음소거 전환",
  volume: "음량 설정 (0~100)",
  if: "조건 분기 (고급 JSON)",
};
function renderActions() {
  const w = current();
  if (!w) return;
  $("#actionsJson").value = JSON.stringify(w.actions || [], null, 2);
  $("#actions").replaceChildren(
    ...(w.actions || []).map((a, i) => {
      const row = node("div", undefined, "action"),
        head = node("div", undefined, "action-head"),
        select = node("select");
      for (const [value, label] of Object.entries(kinds)) {
        const o = node("option", label);
        o.value = value;
        select.append(o);
      }
      select.value = a.type;
      select.onchange = () => {
        a.type = select.value;
        changed();
        renderActions();
      };
      head.append(select);
      const up = node("button", "↑");
      up.onclick = () => {
        if (i) {
          [w.actions[i - 1], w.actions[i]] = [w.actions[i], w.actions[i - 1]];
          changed();
          renderActions();
        }
      };
      const del = node("button", "✕");
      del.onclick = () => {
        w.actions.splice(i, 1);
        changed();
        renderActions();
      };
      head.append(up, del);
      row.append(head);
      if (a.type === "chrome") {
        const p = node("input");
        p.value = a.profile || "Default";
        p.placeholder = "Chrome 프로필 폴더 · 예: Profile 3";
        p.oninput = () => {
          a.profile = p.value;
          changed();
        };
        row.append(p);
      }
      if (a.type !== "mute" && a.type !== "if") {
        const input = node("input");
        input.value = a.value ?? "";
        input.placeholder =
          a.type === "openApp"
            ? "/Applications/앱 이름.app"
            : a.type === "chrome"
              ? "기존 탭으로 이동할 URL · 비우면 프로필만 열기"
              : a.type === "command"
                ? "이 맥에서 실행할 명령"
                : a.type === "wait"
                  ? "500"
                  : "https://";
        input.oninput = () => {
          a.value = input.value;
          changed();
        };
        row.append(input);
      }
      return row;
    }),
  );
}
$("#label").oninput = () => {
  current().label = $("#label").value;
  changed();
  renderBoard();
};
$("#color").oninput = () => {
  current().color = $("#color").value;
  changed();
  renderBoard();
};
$("#icon").onchange = () => {
  current().icon = $("#icon").value;
  changed();
  renderBoard();
};
$("#minutes").oninput = () => {
  current().minutes = Number($("#minutes").value);
  changed();
  renderBoard();
};
$("#closeInspector").onclick = () => {
  $("#inspector").hidden = true;
  selected = null;
  renderBoard();
};
$("#addAction").onclick = () => {
  const w = current();
  (w.actions ??= []).push({ type: "openApp", value: "" });
  changed();
  renderActions();
};
$("#applyJson").onclick = () => {
  try {
    const a = JSON.parse($("#actionsJson").value);
    if (!Array.isArray(a)) throw Error("배열이 필요합니다.");
    current().actions = a;
    changed();
    renderActions();
    notice("동작을 적용했습니다. 저장하면 반영됩니다.");
  } catch (e) {
    notice(e.message, true);
  }
};
async function save() {
  await api("/api/admin/config", "PUT", config);
  dirty = false;
  $("#saved").textContent = "모든 변경 저장됨";
  $("#save").textContent = "변경 저장";
  notice("태블릿에 반영했습니다.");
}
$("#save").onclick = () => save().catch((e) => notice(e.message, true));
$("#testAction").onclick = async () => {
  try {
    await save();
    notice("실행 중…");
    await api("/api/action", "POST", { id: current().id });
    notice("실행 완료");
  } catch (e) {
    notice(e.message, true);
  }
};
$("#columns").onchange = () => {
  config.columns = Number($("#columns").value);
  changed();
  render();
};
document.querySelectorAll("[data-add]").forEach(
  (b) =>
    (b.onclick = () => {
      const type = b.dataset.add,
        w = {
          id: crypto.randomUUID(),
          type,
          label: {
            button: "새 버튼",
            clock: "WORKSPACE",
            gauges: "Mac · LIVE",
            timer: "집중 · 25분",
            volume: "Mac 음량",
            text: "메모",
          }[type],
          color: "#8bb8ff",
          icon: "monitor",
        };
      if (type === "button") w.actions = [];
      if (type === "timer") w.minutes = 25;
      currentPage().widgets.push(w);
      changed();
      render();
      edit(w.id);
    }),
);
$("#duplicate").onclick = () => {
  const w = structuredClone(current());
  w.id = crypto.randomUUID();
  w.label += " 복사";
  currentPage().widgets.push(w);
  changed();
  render();
  edit(w.id);
};
$("#removeWidget").onclick = () => {
  currentPage().widgets = currentPage().widgets.filter(
    (w) => w.id !== selected,
  );
  selected = null;
  $("#inspector").hidden = true;
  changed();
  render();
};
$("#addPage").onclick = () => {
  const name = prompt("페이지 이름", "새 페이지");
  if (!name) return;
  const p = { id: crypto.randomUUID(), name, widgets: [] };
  config.pages.push(p);
  pageId = p.id;
  changed();
  render();
};
$("#renamePage").onclick = () => {
  const n = prompt("페이지 이름", currentPage().name);
  if (n) {
    currentPage().name = n;
    changed();
    render();
  }
};
$("#removePage").onclick = () => {
  if (config.pages.length === 1)
    return notice("페이지 하나는 남겨 두세요.", true);
  if (!confirm("이 페이지와 위젯을 제거할까요? 저장 전까지 원본은 유지됩니다."))
    return;
  config.pages = config.pages.filter((p) => p.id !== pageId);
  pageId = config.pages[0].id;
  changed();
  render();
};
$("#export").onclick = () => {
  if (window.webkit?.messageHandlers?.exportConfig) {
    window.webkit.messageHandlers.exportConfig.postMessage(
      JSON.stringify(config, null, 2),
    );
    return;
  }
  const a = node("a");
  a.href = URL.createObjectURL(
    new Blob([JSON.stringify(config, null, 2)], { type: "application/json" }),
  );
  a.download = "open-deck.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$("#import").onclick = () => $("#file").click();
$("#file").onchange = async () => {
  try {
    const file = $("#file").files[0];
    if (file.size > 262144) throw Error("파일은 256KB 이하여야 합니다.");
    const c = JSON.parse(await file.text());
    if (c.version !== 1 || !c.pages?.length)
      throw Error("Open Deck 설정 파일이 아닙니다.");
    config = c;
    pageId = c.pages[0].id;
    selected = null;
    $("#inspector").hidden = true;
    changed();
    render();
  } catch (e) {
    notice(e.message, true);
  }
  $("#file").value = "";
};
function automations() {
  const buttons = config.pages
    .flatMap((p) => p.widgets)
    .filter((w) => w.type === "button");
  $("#automations").replaceChildren(
    ...(config.automations || []).map((a) => {
      const r = node("div", undefined, "automation-row"),
        check = node("input");
      check.type = "checkbox";
      check.checked = a.enabled;
      check.onchange = () => {
        a.enabled = check.checked;
        changed();
      };
      const time = node("input");
      time.type = "time";
      time.value = a.time;
      time.onchange = () => {
        a.time = time.value;
        changed();
      };
      const sel = node("select");
      for (const w of buttons) {
        const o = node("option", w.label);
        o.value = w.id;
        sel.append(o);
      }
      sel.value = a.widgetId;
      sel.onchange = () => {
        a.widgetId = sel.value;
        changed();
      };
      const del = node("button", "삭제");
      del.onclick = () => {
        config.automations = config.automations.filter((x) => x.id !== a.id);
        changed();
        automations();
      };
      r.append(check, time, sel, del);
      return r;
    }),
  );
}
$("#addAutomation").onclick = () => {
  const first = config.pages
    .flatMap((p) => p.widgets)
    .find((w) => w.type === "button");
  if (!first) return notice("먼저 동작 버튼을 만드세요.", true);
  (config.automations ??= []).push({
    id: crypto.randomUUID(),
    enabled: false,
    time: "09:00",
    widgetId: first.id,
  });
  changed();
  automations();
};
$("#editTab").onclick = () => {
  $("#deckArea").hidden = false;
  $("#automationArea").hidden = true;
  $("#editTab").classList.add("active");
  $("#automationTab").classList.remove("active");
};
$("#automationTab").onclick = () => {
  $("#deckArea").hidden = true;
  $("#automationArea").hidden = false;
  $("#editTab").classList.remove("active");
  $("#automationTab").classList.add("active");
  automations();
};
function pin(p) {
  $("#pin").textContent = p.slice(0, 3) + " " + p.slice(3);
}
$("#newPin").onclick = async () => {
  try {
    const r = await api("/api/admin/pin", "POST", {});
    pin(r.pin);
  } catch (e) {
    notice(e.message, true);
  }
};
$("#devicesToggle").onclick = async () => {
  try {
    const r = await api("/api/admin/info");
    $("#devices").hidden = !$("#devices").hidden;
    $("#deviceList").replaceChildren(
      ...r.devices.map((d) => {
        const row = node("div", undefined, "device");
        row.append(node("span", d.name));
        const b = node("button", "연결 해제");
        b.onclick = async () => {
          await api("/api/admin/revoke", "POST", { id: d.id });
          row.remove();
        };
        row.append(b);
        return row;
      }),
    );
  } catch (e) {
    notice(e.message, true);
  }
};
window.onbeforeunload = (e) => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = "";
  }
};
try {
  info = await api("/api/admin/info");
  config = info.config;
  pageId = config.pages[0].id;
  pin(info.pin);
  render();
  const events = new EventSource("/api/events");
  events.addEventListener("snapshot", (e) => {
    state = JSON.parse(e.data).state;
    if (!dirty && !selected) renderBoard();
  });
  events.onerror = () => notice("맥 호스트 연결을 기다리는 중입니다.", true);
} catch (e) {
  notice(e.message, true);
}
