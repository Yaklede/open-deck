import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
const numeric = (v, max = Number.MAX_SAFE_INTEGER) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? v : null;
const object = (v) =>
  v && typeof v === "object" && !Array.isArray(v) ? v : {};
const fields = (v, keys) =>
  Object.fromEntries(keys.map((k) => [k, numeric(object(v)[k])]));
export function sanitizeSystemSample(raw, now = Date.now()) {
  if (
    !raw ||
    raw.schemaVersion !== 1 ||
    !numeric(raw.capturedAt) ||
    Math.abs(now - raw.capturedAt) > 15000
  )
    throw Error("INVALID_SAMPLE");
  const sample = {
    capturedAt: raw.capturedAt,
    uptimeSeconds: numeric(raw.uptimeSeconds),
    model: typeof raw.model === "string" ? raw.model.slice(0, 80) : "Mac",
    logicalCores: numeric(raw.logicalCores, 1024),
  };
  const cpu = object(raw.cpu);
  sample.cpu = {
    percent: numeric(cpu.percent, 100),
    cores: Array.isArray(cpu.cores)
      ? cpu.cores.slice(0, 256).map((v) => numeric(v, 100))
      : [],
  };
  sample.memory = {
    ...fields(raw.memory, [
      "totalBytes",
      "usedBytes",
      "appBytes",
      "wiredBytes",
      "compressedBytes",
      "swapBytes",
    ]),
    pressure: ["normal", "warning", "critical"].includes(raw.memory?.pressure)
      ? raw.memory.pressure
      : "unknown",
  };
  sample.disk = fields(raw.disk, ["totalBytes", "freeBytes", "availableBytes"]);
  sample.network = {
    ...fields(raw.network, ["rxBytesPerSecond", "txBytesPerSecond"]),
    interfaces: Array.isArray(raw.network?.interfaces)
      ? raw.network.interfaces
          .filter((v) => typeof v === "string" && /^en\d+$/.test(v))
          .slice(0, 16)
      : [],
  };
  sample.io = fields(raw.io, ["readBytesPerSecond", "writeBytesPerSecond"]);
  const p = object(raw.power);
  sample.power = {
    thermal: ["normal", "fair", "serious", "critical"].includes(p.thermal)
      ? p.thermal
      : "unknown",
    batteryPercent: numeric(p.batteryPercent, 100),
    pluggedIn: typeof p.pluggedIn === "boolean" ? p.pluggedIn : null,
    charging: p.charging === true,
    lowPower: p.lowPower === true,
    batteryPresent: p.batteryPresent === true,
  };
  const rows = (v) =>
    Array.isArray(v)
      ? v
          .slice(0, 5)
          .filter(
            (x) => typeof x?.name === "string" && numeric(x.pid, 2147483647),
          )
          .map((x) => ({
            pid: x.pid,
            name: x.name.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 80),
            cpuPercent: numeric(x.cpuPercent, 102400),
            memoryBytes: numeric(x.memoryBytes),
          }))
      : [];
  sample.processes = {
    count: numeric(raw.processes?.count, 100000),
    capturedAt: numeric(raw.processes?.capturedAt),
    cpu: rows(raw.processes?.cpu),
    memory: rows(raw.processes?.memory),
  };
  sample.loadAverage = Array.isArray(raw.loadAverage)
    ? raw.loadAverage.slice(0, 3).map((v) => numeric(v))
    : [];
  return sample;
}
export class MacMetrics {
  constructor(
    onChange,
    {
      helper = process.env.OPEN_DECK_METRICS_HELPER ||
        fileURLToPath(new URL("../MacMetrics", import.meta.url)),
      platform = process.platform,
      spawnProcess = spawn,
      clock = Date.now,
    } = {},
  ) {
    this.onChange = onChange;
    this.helper = helper;
    this.spawnProcess = spawnProcess;
    this.clock = clock;
    this.history = { cpu: [], memory: [], rx: [], tx: [] };
    this.closed = false;
    this.retryMs = 5000;
    this.status =
      platform === "darwin" && existsSync(helper) ? "starting" : "unavailable";
    if (this.status === "starting") this.start();
  }
  accept(raw) {
    const sample = sanitizeSystemSample(raw, this.clock());
    this.sample = sample;
    this.status = "connected";
    this.retryMs = 5000;
    for (const [key, value] of Object.entries({
      cpu: sample.cpu.percent,
      memory:
        sample.memory.totalBytes && sample.memory.usedBytes !== null
          ? (sample.memory.usedBytes / sample.memory.totalBytes) * 100
          : null,
      rx: sample.network.rxBytesPerSecond,
      tx: sample.network.txBytesPerSecond,
    })) {
      this.history[key].push(value);
      if (this.history[key].length > 120) this.history[key].shift();
    }
    this.onChange();
  }
  start() {
    if (this.closed) return;
    this.child = this.spawnProcess(this.helper, [], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let buffer = "";
    const decoder = new StringDecoder("utf8");
    this.child.stdout.on("data", (bytes) => {
      buffer += decoder.write(bytes);
      if (buffer.length > 131072) {
        buffer = "";
        this.child?.kill();
        return;
      }
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          this.accept(JSON.parse(line));
        } catch {}
      }
    });
    let ended = false;
    const stop = () => {
      if (ended) return;
      ended = true;
      this.child = null;
      if (this.closed) return;
      this.status = "unavailable";
      this.onChange();
      this.retry = setTimeout(() => this.start(), this.retryMs);
      this.retry.unref?.();
      this.retryMs = Math.min(30000, this.retryMs * 2);
    };
    this.child.once("error", stop);
    this.child.once("close", stop);
  }
  state() {
    const fresh = this.sample && this.clock() - this.sample.capturedAt < 8000;
    if (this.status !== "connected" || !fresh)
      return {
        status: this.status === "connected" ? "stale" : this.status,
        capturedAt: this.sample?.capturedAt || 0,
      };
    return { status: "connected", ...this.sample, history: this.history };
  }
  close() {
    this.closed = true;
    clearTimeout(this.retry);
    this.child?.kill();
    this.child = null;
  }
}
