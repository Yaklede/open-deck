import { spawn } from "node:child_process";
import os from "node:os";
import crypto from "node:crypto";
import { chrome } from "./chrome.mjs";
export function command(executable, args, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const p = spawn(executable, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let out = "",
      err = "",
      settled = false;
    const finish = (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      e ? reject(e) : resolve(out.trim());
    };
    const timer = setTimeout(() => {
      try {
        process.kill(-p.pid, "SIGKILL");
      } catch {}
      finish(Error("응답 제한 시간을 넘겼습니다. 요청을 취소했습니다."));
    }, timeout);
    p.on("error", finish);
    p.stdout.on("data", (d) => {
      if (out.length < 8192) out += d;
    });
    p.stderr.on("data", (d) => {
      if (err.length < 8192) err += d;
    });
    p.on("close", (code) =>
      finish(code ? Error(err.trim() || `종료 코드 ${code}`) : null),
    );
  });
}
export class Engine {
  constructor(config, onChange = () => {}, runner = command) {
    this.config = config;
    this.onChange = onChange;
    this.runner = runner;
    this.running = new Set();
    this.lastTap = new Map();
    this.timers = new Map();
    this.results = new Map();
    this.volume = 50;
    this.muted = false;
    this.cpu = 0;
    this.memory = 0;
    this.previous = os.cpus();
    this.variables = structuredClone(config.variables || {});
    this.todos = {};
    this.history = { cpu: [], memory: [] };
    this.integrations = {};
    this.navigation = null;
    this.volumeWrite = Promise.resolve();
    this.volumeRevision = 0;
  }
  widget(id) {
    return this.config.pages.flatMap((p) => p.widgets).find((w) => w.id === id);
  }
  state() {
    return {
      at: Date.now(),
      cpu: this.cpu,
      memory: this.memory,
      volume: this.volume,
      muted: this.muted,
      running: [...this.running],
      timers: Object.fromEntries(this.timers),
      results: Object.fromEntries(this.results),
      variables: { ...this.variables, ...this.pluginValues },
      todos: this.todos,
      history: this.history,
      integrations: this.integrations,
    };
  }
  metrics() {
    const now = os.cpus();
    let total = 0,
      idle = 0;
    now.forEach((c, i) => {
      const prev = this.previous[i];
      if (!prev) return;
      for (const k of Object.keys(c.times))
        total += Math.max(0, c.times[k] - prev.times[k]);
      idle += Math.max(0, c.times.idle - prev.times.idle);
    });
    this.previous = now;
    const historyKeys = new Set([
      "cpu",
      "memory",
      ...this.config.pages
        .flatMap((p) => p.widgets)
        .filter((w) => w.type === "graph")
        .map((w) => w.binding)
        .filter(Boolean)
        .slice(0, 32),
    ]);
    for (const key of Object.keys(this.history))
      if (!historyKeys.has(key)) delete this.history[key];
    for (const key of historyKeys) {
      const value =
        this.pluginValues?.[key] ?? this.variables[key] ?? this[key];
      if (typeof value !== "number") continue;
      this.history[key] ??= [];
      this.history[key].push(value);
      if (this.history[key].length > 120) this.history[key].shift();
    }
    this.connectors?.tick();
    this.cpu = total ? Math.round(100 * (1 - idle / total)) : 0;
    if (process.platform !== "darwin" || this.memory === 0)
      this.memory = Math.round(100 * (1 - os.freemem() / os.totalmem()));
    for (const [id, t] of this.timers)
      if (t.running && t.end <= Date.now())
        this.timers.set(id, {
          remaining: 0,
          running: false,
          end: 0,
          finished: true,
        });
    if (process.platform === "darwin" && !this.readingMemory) {
      this.readingMemory = true;
      this.runner("/usr/bin/vm_stat", [], 1500)
        .then((text) => {
          const pageSize = Number(text.match(/page size of (\d+) bytes/)?.[1]);
          const value = (name) =>
            Number(text.match(new RegExp(name + ":\\s+(\\d+)"))?.[1] || 0);
          if (pageSize)
            this.memory = Math.min(
              100,
              Math.round(
                (((value("Pages active") +
                  value("Pages wired down") +
                  value("Pages occupied by compressor")) *
                  pageSize) /
                  os.totalmem()) *
                  100,
              ),
            );
        })
        .catch(() => {})
        .finally(() => {
          this.readingMemory = false;
        });
    }
    if (process.platform === "darwin" && !this.readingVolume) {
      this.readingVolume = true;
      const rev = this.volumeRevision;
      this.runner(
        "/usr/bin/osascript",
        [
          "-e",
          "get {output volume of (get volume settings), output muted of (get volume settings)}",
        ],
        1500,
      )
        .then((v) => {
          if (rev !== this.volumeRevision) return;
          const [n, m] = v.split(",");
          if (Number.isFinite(Number(n))) this.volume = Number(n);
          this.muted = m?.trim() === "true";
        })
        .catch(() => {})
        .finally(() => {
          this.readingVolume = false;
        });
    }
    this.onChange();
  }
  async setVolume(v) {
    if (!Number.isFinite(v) || v < 0 || v > 100)
      throw Error("음량은 0~100입니다.");
    this.volume = Math.round(v);
    this.volumeRevision++;
    const requested = this.volume;
    this.volumeWrite = this.volumeWrite
      .catch(() => {})
      .then(() =>
        this.runner(
          "/usr/bin/osascript",
          ["-e", `set volume output volume ${requested}`],
          1500,
        ),
      );
    await this.volumeWrite;
    this.onChange();
  }
  timer(id, gesture = "tap") {
    const w = this.widget(id);
    if (w?.type !== "timer") throw Error("타이머를 찾을 수 없습니다.");
    let t = this.timers.get(id) || {
      remaining: w.minutes * 60 * 1000,
      running: false,
      end: 0,
    };
    if (gesture === "reset")
      t = { remaining: w.minutes * 60 * 1000, running: false, end: 0 };
    else if (t.running)
      t = {
        remaining: Math.max(0, t.end - Date.now()),
        running: false,
        end: 0,
      };
    else {
      const remaining = t.remaining > 0 ? t.remaining : w.minutes * 60 * 1000;
      t = { remaining, running: true, end: Date.now() + remaining };
    }
    this.timers.set(id, t);
    this.onChange();
    return t;
  }
  configure(config) {
    const previous = this.config;
    this.config = config;
    for (const [key, value] of Object.entries(config.variables || {}))
      if (
        !Object.hasOwn(this.variables, key) ||
        previous.variables?.[key] !== value
      )
        this.variables[key] = value;
    for (const key of Object.keys(this.variables))
      if (!Object.hasOwn(config.variables || {}, key))
        delete this.variables[key];
    this.onPersist?.();
  }
  setVariable(key, value) {
    if (!Object.hasOwn(this.config.variables || {}, key))
      throw Error("등록된 변수가 아닙니다.");
    if (
      typeof value !== typeof this.config.variables[key] ||
      (typeof value === "number" && !Number.isFinite(value)) ||
      (typeof value === "string" && value.length > 2048)
    )
      throw Error("변수 형식이 다릅니다.");
    const previous = this.variables[key];
    this.variables[key] = value;
    if (previous !== value) this.variableEvent(key, value);
    this.onPersist?.();
    this.onChange();
    return value;
  }
  variableEvent(key, value) {
    this.trigger(
      (a) =>
        a.trigger === "variable" &&
        a.variable === key &&
        (a.equals === undefined || a.equals === value),
    );
  }
  pluginEvent(pluginId, eventId) {
    this.trigger(
      (a) =>
        a.trigger === "plugin" &&
        a.pluginId === pluginId &&
        a.eventId === eventId,
    );
  }
  trigger(match) {
    this.eventTimes ??= new Map();
    for (const a of this.config.automations || [])
      if (a.enabled && match(a)) {
        const now = Date.now();
        if (
          now - (this.eventTimes.get(a.id) || 0) <
          Math.max(1000, (a.cooldownSeconds || 5) * 1000)
        )
          continue;
        this.eventTimes.set(a.id, now);
        Promise.resolve()
          .then(() => this.run(a.widgetId))
          .catch(() => {});
      }
  }
  control(id, value) {
    const w = this.widget(id);
    if (!w || !["slider", "toggle"].includes(w.type))
      throw Error("제어 위젯이 아닙니다.");
    if (
      w.type === "slider" &&
      (!Number.isFinite(value) || value < w.min || value > w.max)
    )
      throw Error("슬라이더 범위를 벗어났습니다.");
    if (w.type === "toggle" && typeof value !== "boolean")
      throw Error("토글 값이 잘못되었습니다.");
    if (
      typeof this.config.variables?.[w.binding] !==
      (w.type === "toggle" ? "boolean" : "number")
    )
      throw Error("변수 형식을 확인하세요.");
    return this.setVariable(w.binding, value);
  }
  todo(id, gesture, value) {
    if (this.widget(id)?.type !== "todo") throw Error("할 일 위젯이 아닙니다.");
    const items = (this.todos[id] ??= []);
    if (gesture === "add") {
      const text = String(value || "")
        .trim()
        .slice(0, 160);
      if (!text || items.length >= 50)
        throw Error("할 일은 1~160자, 최대 50개입니다.");
      items.push({ id: crypto.randomUUID(), text, done: false });
    } else {
      const index = items.findIndex((x) => x.id === value);
      if (index < 0) throw Error("할 일을 찾을 수 없습니다.");
      if (gesture === "delete") items.splice(index, 1);
      else if (gesture === "toggle") items[index].done = !items[index].done;
      else throw Error("지원하지 않는 동작입니다.");
    }
    this.onPersist?.();
    this.onChange();
    return items;
  }
  async run(id, gesture = "tap") {
    const w = this.widget(id);
    if (!w || !["button", "toggle"].includes(w.type))
      throw Error("버튼을 찾을 수 없습니다.");
    if (this.running.has(id) || Date.now() - (this.lastTap.get(id) || 0) < 350)
      return { status: "ignored" };
    const started = Date.now();
    this.lastTap.set(id, started);
    this.running.add(id);
    this.results.set(id, { status: "running", at: started });
    this.onChange();
    try {
      const actions =
        gesture === "long"
          ? w.longActions
          : gesture === "double"
            ? w.doubleActions
            : w.actions;
      if (!["tap", "long", "double"].includes(gesture))
        throw Error("잘못된 제스처입니다.");
      await this.actions(actions || [], Date.now() + 30000);
      this.results.set(id, {
        status: "ok",
        at: Date.now(),
        durationMs: Date.now() - started,
      });
      return { status: "ok" };
    } catch (e) {
      this.results.set(id, {
        status: "error",
        message: e.message,
        at: Date.now(),
      });
      throw e;
    } finally {
      this.running.delete(id);
      this.onChange();
    }
  }
  async actions(actions, deadline) {
    for (const a of actions) {
      if (Date.now() > deadline)
        throw Error("루틴의 30초 제한 시간을 넘겼습니다.");
      const v = String(a.value ?? "");
      switch (a.type) {
        case "openApp":
          await this.runner(
            "/usr/bin/open",
            [...(a.background ? ["-g"] : []), "-a", v],
            2000,
          );
          break;
        case "openUrl": {
          const u = new URL(v);
          if (!["https:", "http:"].includes(u.protocol))
            throw Error("http/https 주소가 필요합니다.");
          await this.runner("/usr/bin/open", [u.href], 2000);
          break;
        }
        case "chrome":
          if (
            (await chrome(String(a.profile || "Default"), v, this.runner)) ===
            "ignored"
          )
            throw Error("Chrome을 제어 중입니다. 다시 눌러 주세요.");
          break;
        case "command":
          await this.runner(
            "/bin/zsh",
            ["-c", v],
            Math.min(10000, Math.max(1, deadline - Date.now())),
          );
          break;
        case "wait":
          await new Promise((r) =>
            setTimeout(r, Math.min(10000, Math.max(0, Number(v) || 0))),
          );
          break;
        case "volume":
          await this.setVolume(Number(v));
          break;
        case "mute":
          await this.runner(
            "/usr/bin/osascript",
            [
              "-e",
              "set volume output muted not (output muted of (get volume settings))",
            ],
            1500,
          );
          this.muted = !this.muted;
          break;
        case "setVariable":
          this.setVariable(a.variable, a.value);
          break;
        case "increment":
          this.setVariable(
            a.variable,
            Number(this.variables[a.variable]) + Number(a.value || 1),
          );
          break;
        case "toggleVariable":
          this.setVariable(a.variable, !this.variables[a.variable]);
          break;
        case "http":
          if (!this.connectors) throw Error("연동이 준비되지 않았습니다.");
          await this.connectors.run(a.integrationId);
          break;
        case "plugin":
          if (!this.plugins) throw Error("플러그인이 연결되지 않았습니다.");
          await this.plugins.invoke(a.pluginId, a.actionId, a.parameters || {});
          break;
        case "if": {
          const current =
            this.variables[a.variable] ?? this.state()[a.variable];
          const match =
            a.operator === "gt"
              ? Number(current) > Number(a.value)
              : String(current) === v;
          await this.actions(match ? a.then || [] : a.else || [], deadline);
          break;
        }
        default:
          throw Error("지원하지 않는 동작입니다.");
      }
    }
  }
}
