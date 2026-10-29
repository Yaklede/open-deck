import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const fail = (code, status = 400) =>
  Object.assign(Error(code), { code, status });
const operations = {
  fan: ["fan.system", "fan.manual", "fan.curve", "fan.authorize"],
  audio: ["audio.device", "audio.volume", "audio.mute"],
  display: ["display.brightness"],
  awake: ["awake.start", "awake.stop"],
};
const sources = [
  "averageSoC",
  "hottestSoC",
  "averageCPU",
  "hottestCPU",
  "hottestGPU",
];
const int = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;
const plain = (v) =>
  v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
export function validateControl(control, operation, p) {
  if (!operations[control]?.includes(operation) || !plain(p))
    throw fail("INVALID_CONTROL");
  const only = (keys) => {
    if (Object.keys(p).some((k) => !keys.includes(k)))
      throw fail("INVALID_CONTROL");
  };
  if (["fan.system", "fan.authorize", "awake.stop"].includes(operation))
    only([]);
  else if (operation === "fan.manual") {
    only(["level"]);
    if (!int(p.level, 0, 100) || p.level % 5) throw fail("INVALID_LEVEL");
  } else if (operation === "fan.curve") {
    only(["curves"]);
    if (
      !Array.isArray(p.curves) ||
      p.curves.length < 1 ||
      p.curves.length > 5 ||
      new Set(p.curves.map((c) => c?.sensor)).size !== p.curves.length
    )
      throw fail("INVALID_CURVE");
    for (const c of p.curves) {
      if (
        !plain(c) ||
        Object.keys(c).some((k) => !["sensor", "points"].includes(k)) ||
        !sources.includes(c.sensor) ||
        !Array.isArray(c.points) ||
        c.points.length < 2 ||
        c.points.length > 8
      )
        throw fail("INVALID_CURVE");
      for (const [i, point] of c.points.entries())
        if (
          !plain(point) ||
          Object.keys(point).some(
            (k) => !["temperature", "coolingLevel"].includes(k),
          ) ||
          !int(point.temperature, 20, 110) ||
          !int(point.coolingLevel, 0, 100) ||
          point.coolingLevel % 5 ||
          (i > 0 &&
            (point.temperature <= c.points[i - 1].temperature ||
              point.coolingLevel < c.points[i - 1].coolingLevel))
        )
          throw fail("INVALID_CURVE");
    }
  } else if (operation.startsWith("audio.")) {
    only(
      operation === "audio.device"
        ? ["deviceId", "direction"]
        : ["deviceId", "direction", "value"],
    );
    if (
      !int(p.deviceId, 1, 0xffffffff) ||
      !["input", "output"].includes(p.direction) ||
      (operation === "audio.volume" && !int(p.value, 0, 100)) ||
      (operation === "audio.mute" && typeof p.value !== "boolean")
    )
      throw fail("INVALID_AUDIO");
  } else if (operation === "display.brightness") {
    only(["displayId", "value"]);
    if (!int(p.displayId, 1, 0xffffffff) || !int(p.value, 1, 100))
      throw fail("INVALID_BRIGHTNESS");
  } else if (operation === "awake.start") {
    only(["minutes", "display"]);
    if (
      ![0, 15, 30, 60, 120].includes(p.minutes) ||
      typeof p.display !== "boolean"
    )
      throw fail("INVALID_DURATION");
  }
  return p;
}

export class MacControls {
  constructor({
    dir,
    onChange = () => {},
    binary = process.env.OPEN_DECK_MAC_CONTROLS ||
      fileURLToPath(
        new URL("../../../../MacOS/MacControlClient", import.meta.url),
      ),
    spawnChild = spawn,
    clock = Date.now,
  } = {}) {
    Object.assign(this, { dir, onChange, binary, spawnChild, clock });
    this.child = null;
    this.ready = false;
    this.pending = new Map();
    this.data = null;
    this.closed = false;
    this.retryAt = 0;
    this.failures = 0;
    this.buffer = "";
    this.presets = {
      level: 100,
      curves: [
        {
          sensor: "hottestSoC",
          points: [
            { temperature: 50, coolingLevel: 0 },
            { temperature: 70, coolingLevel: 100 },
          ],
        },
      ],
    };
    try {
      const file = path.join(dir, "mac-control-presets.json");
      if (fs.statSync(file).size <= 16384) {
        const value = JSON.parse(fs.readFileSync(file, "utf8"));
        validateControl("fan", "fan.manual", { level: value.level });
        validateControl("fan", "fan.curve", { curves: value.curves });
        this.presets = value;
      }
    } catch {}
  }
  state() {
    return {
      ...(this.data || {}),
      fan: {
        ...(this.data?.fan || {}),
        presetLevel: this.presets.level,
        presetCurves: this.presets.curves,
        presetSaveError: this.presetSaveError === true,
      },
      available: !!this.child && !!this.data && this.ready,
      stale:
        !this.child ||
        !this.ready ||
        !this.data ||
        this.clock() - (this.data.at || 0) > 10000,
      error: this.error || "",
      applying: this.controlBusy === true,
    };
  }
  log(event) {
    if (!this.dir) return;
    try {
      const file = path.join(this.dir, "mac-controls.log");
      if (fs.existsSync(file) && fs.statSync(file).size > 1048576)
        fs.renameSync(file, file + ".1");
      fs.appendFileSync(
        file,
        JSON.stringify({ at: new Date(this.clock()).toISOString(), event }) +
          "\n",
        { mode: 0o600 },
      );
    } catch {}
  }
  ensure() {
    if (this.child || this.closed || this.clock() < this.retryAt) return;
    if (!fs.existsSync(this.binary)) {
      this.error = "MAC_CONTROLS_NOT_INSTALLED";
      this.retryAt = this.clock() + 30000;
      return;
    }
    this.error = "";
    this.buffer = "";
    const child = this.spawnChild(this.binary, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.child = child;
    this.ready = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (this.child !== child) return;
      this.buffer += chunk;
      if (this.buffer.length > 262144) {
        child.kill();
        return;
      }
      let end;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        try {
          this.receive(JSON.parse(line));
        } catch {
          this.log("invalid_native_response");
        }
      }
    });
    child.stdin.on("error", () => {});
    child.stderr.on("data", () => {});
    const ended = () => {
      if (this.child !== child) return;
      this.child = null;
      this.ready = false;
      this.error = "MAC_CONTROLS_DISCONNECTED";
      this.failures++;
      this.retryAt =
        this.clock() + Math.min(10000, 1000 * 2 ** Math.min(this.failures, 4));
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(fail("MAC_CONTROLS_DISCONNECTED", 503));
      }
      this.pending.clear();
      this.log("native_disconnected");
      this.onChange();
    };
    child.on("error", ended);
    child.on("exit", ended);
    this.log("native_started");
  }
  receive(message) {
    if (
      message.state &&
      typeof message.state === "object" &&
      Number.isFinite(message.state.at)
    ) {
      this.data = message.state;
      this.ready = true;
      this.error = "";
      this.failures = 0;
      this.onChange();
    }
    if (message.id && this.pending.has(message.id)) {
      const p = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(p.timer);
      if (message.ok) p.resolve(this.state());
      else {
        this.log(
          (p.operation || "read") +
            ":" +
            String(message.error || "MAC_CONTROL_FAILED").slice(0, 100),
        );
        p.reject(
          fail(
            message.error || "MAC_CONTROL_FAILED",
            message.error === "STALE_ACTION" ? 409 : 503,
          ),
        );
      }
    }
  }
  request(op, parameters = {}) {
    this.ensure();
    if (!this.child)
      return Promise.reject(
        fail(this.error || "MAC_CONTROLS_UNAVAILABLE", 503),
      );
    if (this.pending.size >= 8) return Promise.reject(fail("BUSY", 409));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(fail("MAC_CONTROL_TIMEOUT", 504));
      }, 20000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer, operation: op });
      this.child.stdin.write(
        JSON.stringify({
          id,
          op,
          parameters,
          deadline: this.clock() + (op === "read" ? 10000 : 5000),
        }) + "\n",
      );
    });
  }
  read() {
    if (this.controlBusy) return Promise.resolve(this.state());
    if (this.reading) return this.reading;
    this.reading = this.request("read")
      .catch((error) => {
        this.ready = false;
        this.error = String(
          error.code || error.message || "MAC_CONTROLS_UNAVAILABLE",
        ).slice(0, 100);
        this.onChange();
        if (!this.data) throw error;
        return this.state();
      })
      .finally(() => {
        this.reading = null;
      });
    return this.reading;
  }
  async control(control, operation, parameters) {
    validateControl(control, operation, parameters);
    if (this.controlBusy) throw fail("BUSY", 409);
    this.controlBusy = true;
    this.onChange();
    try {
      await this.request(operation, parameters);
      if (operation === "fan.manual" || operation === "fan.curve") {
        if (operation === "fan.manual") this.presets.level = parameters.level;
        else this.presets.curves = structuredClone(parameters.curves);
        this.presetSaveError = false;
        if (this.dir) {
          try {
            fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
            const file = path.join(this.dir, "mac-control-presets.json");
            const temporary = file + ".tmp";
            fs.writeFileSync(temporary, JSON.stringify(this.presets), {
              mode: 0o600,
            });
            fs.renameSync(temporary, file);
          } catch {
            this.presetSaveError = true;
            this.log("preset_save_failed");
          }
        }
        this.onChange();
      }
      this.log(operation);
    } finally {
      this.controlBusy = false;
      this.onChange();
    }
    return this.state();
  }
  stop() {
    const child = this.child;
    if (child) {
      child.stdin.end();
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 4000);
      timer.unref();
      child.once("exit", () => clearTimeout(timer));
    }
  }
  close() {
    this.closed = true;
    this.stop();
  }
}
