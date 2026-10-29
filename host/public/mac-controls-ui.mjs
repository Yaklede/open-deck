import { locale } from "./i18n.mjs";
const el = (tag, text, cls) => {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
};
export async function showMacControls(api, widgetId) {
  const first = await api(
    "/api/extensions/vorssaint/control?widgetId=" +
      encodeURIComponent(widgetId),
  );
  const copy = first.copy[locale() === "ko" ? "ko" : "en"],
    control = first.control;
  let state = first.state,
    busy = false,
    closed = false,
    dragging = false,
    reading = false;
  const dialog = el("dialog", undefined, "utility-dialog mac-controls-dialog"),
    body = el("div"),
    status = el("p", undefined, "utility-status"),
    footer = el("div", undefined, "utility-footer"),
    close = el("button", copy.close);
  dialog.append(el("h2", copy[control] + " · Mac"), body, status, footer);
  footer.append(close);
  close.onclick = () => dialog.close();
  const controls = [],
    updates = [];
  const disabled = (c) =>
    busy ||
    !!state.applying ||
    !!state.stale ||
    (c.dataset.fan === "true" && !state.fan?.controllable) ||
    (c.dataset.authorizeFan === "true" && state.fan?.access === "installing");
  const measured = () =>
    copy.updated + " " + new Date(state.at).toLocaleTimeString();
  const button = (parent, text, action) => {
    const b = el("button", text);
    b.type = "button";
    b.onclick = action;
    parent.append(b);
    controls.push(b);
    return b;
  };
  const card = (parent) => {
    const n = el("section", undefined, "mac-control-section");
    parent.append(n);
    return n;
  };
  const field = (parent, label, input) => {
    const row = el("label", undefined, "utility-field");
    row.append(el("span", label), input);
    parent.append(row);
    input.setAttribute("aria-label", label);
    controls.push(input);
    return input;
  };
  const range = (parent, label, get, min, max, step, apply) => {
    const input = el("input");
    Object.assign(input, { type: "range", min, max, step, value: get() });
    const value = el("strong", get() + "%"),
      box = el("div", undefined, "mac-control-range");
    box.append(input, value);
    const row = el("label", undefined, "utility-field");
    row.append(el("span", label), box);
    parent.append(row);
    input.setAttribute("aria-label", label);
    controls.push(input);
    input.oninput = () => {
      value.textContent = input.value + "%";
    };
    input.onpointerdown = () => {
      dragging = true;
    };
    input.onpointerup = () => {
      dragging = false;
    };
    input.onpointercancel = () => {
      dragging = false;
    };
    input.onchange = () => apply(Number(input.value));
    updates.push(() => {
      if (!dragging) {
        input.value = get();
        value.textContent = get() + "%";
      }
    });
  };
  const select = (parent, label, choices, value, changed) => {
    const input = el("select");
    for (const [id, name] of choices) {
      const option = el("option", name);
      option.value = id;
      input.append(option);
    }
    input.value = value;
    input.onchange = () => changed?.(input.value);
    return field(parent, label, input);
  };
  const number = (parent, label, value, min, max, step) => {
    const input = el("input");
    Object.assign(input, { type: "number", value, min, max, step });
    return field(parent, label, input);
  };
  const audioDevice = (direction) =>
    (state.audio?.devices || []).find(
      (d) => d.id === state.audio?.[direction + "Id"],
    );
  async function send(operation, parameters) {
    if (busy || closed || state.applying) return;
    busy = true;
    for (const c of controls) c.disabled = true;
    close.disabled = true;
    status.textContent = copy.applying;
    try {
      const result = await api("/api/extensions/vorssaint/control", "POST", {
        widgetId,
        operation,
        parameters,
      });
      if (closed) return;
      state = result.state;
      render();
      status.textContent =
        operation === "fan.authorize"
          ? copy.permissionPending
          : state.fan?.presetSaveError
            ? copy.presetSaveFailed
            : measured();
    } catch (e) {
      if (!closed)
        status.textContent = e.message?.includes("FAN_AUTHORIZATION_REQUIRED")
          ? copy.authorizationRequired
          : e.message?.includes("alreadyControlled")
            ? copy.external
            : e.message?.includes("STALE_ACTION")
              ? copy.staleAction
              : e.message?.includes("BUSY")
                ? copy.busy
                : copy.failed;
    } finally {
      busy = false;
      close.disabled = false;
      for (const c of controls) c.disabled = disabled(c);
    }
  }
  function render() {
    body.replaceChildren();
    controls.length = 0;
    updates.length = 0;
    if (control === "fan") {
      const fan = state.fan || {},
        row = el("div", undefined, "mac-control-stats");
      body.append(row);
      for (const [index, f] of (fan.fans || []).entries()) {
        const stat = card(row);
        stat.append(
          el("span", copy.fan + " " + (index + 1)),
          el("strong"),
          el("small"),
        );
        updates.push(() => {
          const current = state.fan?.fans?.[index];
          if (current) {
            stat.querySelector("strong").textContent =
              Math.round(current.actualRPM) + " RPM";
            stat.querySelector("small").textContent =
              copy.target +
              " " +
              Math.round(current.targetRPM) +
              " RPM · " +
              Math.round(current.minimumRPM) +
              "–" +
              Math.round(current.maximumRPM);
          }
        });
      }
      const mode = el("p");
      body.append(mode);
      updates.push(() => {
        mode.textContent = copy[state.fan?.mode] || state.fan?.mode || "—";
        const temperature = state.fan?.temperatures?.find(
          (t) => t.source === "hottestSoC",
        );
        if (temperature)
          mode.textContent += " · " + temperature.celsius.toFixed(1) + "°C";
        if (state.fan?.stopReason)
          mode.textContent +=
            " · " + (copy[state.fan.stopReason] || state.fan.stopReason);
      });
      if (!fan.fans?.length) body.append(el("p", copy.noFans));
      else {
        if (!fan.controllable) {
          body.append(
            el(
              "p",
              fan.error === "alreadyControlled" || fan.mode === "external"
                ? copy.external
                : fan.access === "enabled"
                  ? copy.helperUnavailable
                  : fan.access === "installing"
                    ? copy.permissionPending
                    : copy.authorizationRequired,
            ),
          );
          button(body, copy.authorize, () =>
            send("fan.authorize", {}),
          ).dataset.authorizeFan = "true";
          body.append(el("p", copy.authorization, "utility-muted"));
        }
        const fanControlStart = controls.length;
        const actions = el("div", undefined, "mac-control-actions");
        body.append(actions);
        button(actions, copy.system, () => send("fan.system", {}));
        button(actions, copy.maximum, () => send("fan.manual", { level: 100 }));
        const manual = card(body);
        range(
          manual,
          copy.manual,
          () => state.fan?.level ?? state.fan?.presetLevel ?? 100,
          0,
          100,
          5,
          (value) => send("fan.manual", { level: value }),
        );
        manual.append(
          el("small", copy.fanExplanation),
          el("small", copy.presetHint),
        );
        const curve = card(body);
        curve.append(el("h3", copy.curve));
        const current = fan.configuration?.curves?.[0] || fan.presetCurves?.[0],
          points = current?.points || [
            { temperature: 50, coolingLevel: 0 },
            { temperature: 70, coolingLevel: 100 },
          ];
        const sensor = select(
          curve,
          copy.sensor,
          [
            "hottestSoC",
            "averageSoC",
            "hottestCPU",
            "averageCPU",
            "hottestGPU",
          ].map((v) => [v, copy[v]]),
          current?.sensor || "hottestSoC",
        );
        const lowT = number(
            curve,
            copy.lowTemperature,
            points[0].temperature,
            20,
            109,
            1,
          ),
          highT = number(
            curve,
            copy.highTemperature,
            points.at(-1).temperature,
            21,
            110,
            1,
          ),
          lowL = number(
            curve,
            copy.lowLevel,
            points[0].coolingLevel,
            0,
            100,
            5,
          ),
          highL = number(
            curve,
            copy.highLevel,
            points.at(-1).coolingLevel,
            0,
            100,
            5,
          );
        button(curve, copy.apply, () => {
          const a = Number(lowT.value),
            b = Number(highT.value),
            c = Number(lowL.value),
            d = Number(highL.value);
          if (
            ![a, b, c, d].every(Number.isInteger) ||
            a < 20 ||
            b > 110 ||
            a >= b ||
            c < 0 ||
            c > d ||
            d > 100 ||
            c % 5 ||
            d % 5
          ) {
            status.textContent = copy.curveInvalid;
            return;
          }
          send("fan.curve", {
            curves: [
              {
                sensor: sensor.value,
                points: [
                  { temperature: a, coolingLevel: c },
                  { temperature: b, coolingLevel: d },
                ],
              },
            ],
          });
        });
        for (const item of controls.slice(fanControlStart))
          item.dataset.fan = "true";
      }
    } else if (control === "audio") {
      for (const direction of ["output", "input"]) {
        const section = card(body),
          devices = (state.audio?.devices || []).filter((d) => d[direction]),
          device = audioDevice(direction);
        section.append(el("h3", copy[direction]));
        select(
          section,
          copy[direction],
          devices.map((d) => [String(d.id), d.name]),
          String(device?.id || ""),
          (id) => send("audio.device", { direction, deviceId: Number(id) }),
        );
        if (device?.[direction + "Volume"] !== undefined)
          range(
            section,
            copy.volume,
            () => audioDevice(direction)?.[direction + "Volume"] ?? 0,
            0,
            100,
            1,
            (value) =>
              send("audio.volume", { direction, deviceId: device.id, value }),
          );
        else section.append(el("small", copy.unsupportedVolume));
        if (device?.[direction + "Muted"] !== undefined) {
          const mute = button(section, copy.mute, () =>
            send("audio.mute", {
              direction,
              deviceId: device.id,
              value: !audioDevice(direction)?.[direction + "Muted"],
            }),
          );
          updates.push(() => {
            mute.textContent = audioDevice(direction)?.[direction + "Muted"]
              ? copy.unmute
              : copy.mute;
          });
        }
      }
    } else if (control === "display") {
      if (!state.displays?.length) body.append(el("p", copy.noDisplays));
      for (const display of state.displays || []) {
        const section = card(body);
        section.append(el("h3", display.name));
        range(
          section,
          copy.brightness,
          () =>
            state.displays?.find((d) => d.id === display.id)?.brightness ?? 50,
          1,
          100,
          1,
          (value) =>
            send("display.brightness", { displayId: display.id, value }),
        );
      }
    } else if (control === "awake") {
      const section = card(body),
        value = el("strong");
      section.append(value);
      updates.push(() => {
        value.textContent =
          (state.awake?.active ? copy.active : copy.stopped) +
          (state.awake?.until
            ? " · " +
              copy.until +
              " " +
              new Date(state.awake.until).toLocaleTimeString()
            : "");
      });
      const minutes = select(
        section,
        copy.awake,
        [15, 30, 60, 120, 0].map((v) => [
          String(v),
          v ? v + " " + copy.minutes : copy.unlimited,
        ]),
        "30",
      );
      const display = el("input");
      display.type = "checkbox";
      display.checked = !!state.awake?.display;
      field(section, copy.keepDisplay, display);
      const actions = el("div", undefined, "mac-control-actions");
      section.append(actions);
      button(actions, copy.start, () =>
        send("awake.start", {
          minutes: Number(minutes.value),
          display: display.checked,
        }),
      );
      button(actions, copy.stop, () => send("awake.stop", {}));
    }
    for (const update of updates) update();
    status.textContent = state.applying
      ? copy.applying
      : state.stale
        ? copy.stale
        : measured();
    for (const c of controls) c.disabled = disabled(c);
  }
  render();
  document.body.append(dialog);
  dialog.showModal();
  const timer = setInterval(async () => {
    if (busy || closed || dragging || reading) return;
    reading = true;
    try {
      const result = await api(
        "/api/extensions/vorssaint/control?widgetId=" +
          encodeURIComponent(widgetId),
      );
      if (busy || closed || state.applying) return;
      const structure = JSON.stringify([
        state.fan?.controllable,
        state.fan?.fans?.length,
        state.audio?.outputId,
        state.audio?.inputId,
        state.displays?.map((d) => d.id),
      ]);
      state = result.state;
      const next = JSON.stringify([
        state.fan?.controllable,
        state.fan?.fans?.length,
        state.audio?.outputId,
        state.audio?.inputId,
        state.displays?.map((d) => d.id),
      ]);
      if (structure !== next) render();
      else {
        for (const update of updates) update();
        status.textContent = state.applying
          ? copy.applying
          : state.stale
            ? copy.stale
            : measured();
        for (const c of controls) c.disabled = disabled(c);
      }
    } catch {
      if (!closed) status.textContent = copy.stale;
    } finally {
      reading = false;
    }
  }, 2500);
  dialog.addEventListener("cancel", (e) => {
    if (busy) e.preventDefault();
  });
  dialog.addEventListener("close", () => {
    closed = true;
    clearInterval(timer);
    dialog.remove();
  });
}
