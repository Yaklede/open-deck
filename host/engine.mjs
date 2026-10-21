import { spawn } from "node:child_process";
import os from "node:os";
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
  async run(id) {
    const w = this.widget(id);
    if (w?.type !== "button") throw Error("버튼을 찾을 수 없습니다.");
    if (this.running.has(id) || Date.now() - (this.lastTap.get(id) || 0) < 350)
      return { status: "ignored" };
    const started = Date.now();
    this.lastTap.set(id, started);
    this.running.add(id);
    this.results.set(id, { status: "running", at: started });
    this.onChange();
    try {
      await this.actions(w.actions || [], Date.now() + 30000);
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
        case "if": {
          const current = this.state()[a.variable];
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
