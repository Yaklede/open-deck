// Limited Macro Deck 3 public-protocol adapter. Unsupported capabilities are rejected.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";
import { writeJson } from "./config.mjs";
const metadata = JSON.parse(
  fs.readFileSync(new URL("./plugin-protocol.json", import.meta.url)),
);
const versions = { actions: 3, variables: 2, events: 1 };
const descriptor = {
  ...metadata,
  supportedVersions: [3],
  capabilityKinds: Object.keys(versions),
  limits: {
    ...metadata.limits,
    maxConcurrentInvocations: 4,
    maxDeclaredCapabilities: 128,
    maxInboundQueueDepth: 32,
    maxOutboundQueueDepth: 32,
    queueHighWatermark: 24,
    queueLowWatermark: 8,
  },
};
const alias = (id, key) =>
  "plugin_" +
  crypto.createHash("sha256").update(id).digest("hex").slice(0, 10) +
  "_" +
  String(key)
    .replace(/[^A-Za-z0-9_]/g, "_")
    .slice(0, 40);
const equal = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const negotiate = (caps = []) =>
  caps.slice(0, 128).map((c) => {
    const version = versions[c.kind];
    return version &&
      c.versionRange?.minimum <= version &&
      c.versionRange?.maximum >= version
      ? { kind: c.kind, accepted: true, negotiatedVersion: version }
      : {
          kind: c.kind,
          accepted: false,
          rejectionReason:
            "Open Deck does not implement this capability/version.",
        };
  });
export class Plugins {
  constructor(dir, onChange = () => {}, onEvent = () => {}) {
    this.dir = dir;
    this.onChange = onChange;
    this.onEvent = onEvent;
    this.items = [];
    this.sessions = new Map();
    this.closed = false;
    try {
      this.items = JSON.parse(
        fs.readFileSync(path.join(dir, "plugins.json")),
      ).map((p) => ({
        ...p,
        state: "stopped",
        actions: [],
        variables: [],
        values: {},
        pending: new Map(),
      }));
    } catch {}
    this.server = http.createServer((q, s) => this.handle(q, s));
    this.ws = new WebSocketServer({
      noServer: true,
      maxPayload: 262144,
      perMessageDeflate: false,
      handleProtocols: (p) =>
        p.has("macrodeck.plugin.v1") ? "macrodeck.plugin.v1" : false,
    });
    this.server.on("upgrade", (q, s, h) => {
      const p = this.sessions.get(
        q.headers.authorization?.replace(/^Bearer /, ""),
      );
      if (
        q.url !== "/plugins/ws" ||
        !p ||
        p.socket ||
        q.headers.origin ||
        !String(q.headers["sec-websocket-protocol"])
          .split(/,\s*/)
          .includes("macrodeck.plugin.v1")
      ) {
        s.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
      this.ws.handleUpgrade(q, s, h, (w) => this.connect(p, w));
    });
    this.ready = new Promise((resolve) =>
      this.server.listen(0, "127.0.0.1", resolve),
    );
    this.timer = setInterval(() => this.poll(), 5000);
    this.timer.unref();
    this.ready.then(() => {
      for (const p of this.items)
        if (p.enabled) this.start(p.id).catch((e) => this.fail(p, e));
    });
  }
  persist() {
    writeJson(
      path.join(this.dir, "plugins.json"),
      this.items.map(({ id, name, version, folder, enabled }) => ({
        id,
        name,
        version,
        folder,
        enabled,
      })),
    );
  }
  list() {
    return this.items.map(
      ({
        id,
        name,
        version,
        folder,
        enabled,
        state,
        error,
        actions,
        variables,
        capabilities,
      }) => ({
        id,
        name,
        version,
        folder,
        enabled,
        state,
        error,
        actions,
        variables,
        capabilities,
      }),
    );
  }
  values() {
    const out = {};
    for (const p of this.items)
      if (p.state === "connected") Object.assign(out, p.values);
    return out;
  }
  register(folder) {
    if (this.items.length >= 12) throw Error("플러그인은 최대 12개입니다.");
    const real = fs.realpathSync(String(folder));
    const file = path.join(real, "manifest.json");
    if (fs.statSync(file).size > 65536) throw Error("manifest가 너무 큽니다.");
    const m = JSON.parse(fs.readFileSync(file));
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,127}$/.test(m.id) ||
      !m.name ||
      !m.entrypoints?.["osx-arm64"]?.executable
    )
      throw Error("macOS arm64 manifest가 필요합니다.");
    const exe = fs.realpathSync(
      path.resolve(real, m.entrypoints["osx-arm64"].executable),
    );
    if (!exe.startsWith(real + path.sep) || !fs.statSync(exe).isFile())
      throw Error("실행 파일은 플러그인 폴더 안에 있어야 합니다.");
    if (this.items.some((p) => p.id === m.id))
      throw Error("이미 등록된 플러그인입니다.");
    const p = {
      id: m.id,
      name: String(m.name).slice(0, 80),
      version: String(m.version).slice(0, 40),
      folder: real,
      enabled: false,
      state: "stopped",
      actions: [],
      variables: [],
      values: {},
      pending: new Map(),
    };
    this.items.push(p);
    this.persist();
    this.onChange();
    return p.id;
  }
  async start(id) {
    await this.ready;
    const p = this.items.find((p) => p.id === id);
    if (!p) throw Error("플러그인을 찾을 수 없습니다.");
    if (p.process) return;
    if (this.items.filter((p) => p.process).length >= 4)
      throw Error("동시 실행은 최대 4개입니다.");
    const m = JSON.parse(fs.readFileSync(path.join(p.folder, "manifest.json")));
    if (m.id !== id)
      throw Error("manifest ID가 변경됐습니다. 다시 등록하세요.");
    const exe = fs.realpathSync(
      path.resolve(p.folder, m.entrypoints["osx-arm64"].executable),
    );
    if (!exe.startsWith(p.folder + path.sep))
      throw Error("잘못된 실행 경로입니다.");
    const pluginDir = path.join(this.dir, "plugin-data", id);
    fs.mkdirSync(pluginDir, { recursive: true, mode: 0o700 });
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) => !k.startsWith("MACRO_DECK_PLUGIN_") && k !== "ASPNETCORE_URLS",
      ),
    );
    p.secret = crypto.randomBytes(32).toString("base64url");
    p.enabled = true;
    p.state = "starting";
    p.error = "";
    p.values = {};
    p.actions = [];
    p.variables = [];
    Object.assign(env, {
      MACRO_DECK_PLUGIN_MODE: "Managed",
      MACRO_DECK_PLUGIN_HOST_URL: `http://127.0.0.1:${this.server.address().port}`,
      MACRO_DECK_PLUGIN_ID: id,
      MACRO_DECK_PLUGIN_SECRET: p.secret,
      MACRO_DECK_PLUGIN_DATA_DIRECTORY: pluginDir,
      MACRO_DECK_PLUGIN_INSTANCE_ID: crypto.randomUUID(),
      MACRO_DECK_PLUGIN_LAUNCH_ID: crypto.randomUUID(),
      MACRO_DECK_PLUGIN_HOST_PROCESS_ID: String(process.pid),
      MACRO_DECK_PLUGIN_HOST_STARTED_AT: new Date().toISOString(),
      ASPNETCORE_URLS: "http://127.0.0.1:0",
    });
    p.process = spawn(exe, [], {
      cwd: p.folder,
      env,
      stdio: ["ignore", "ignore", "pipe"],
      detached: true,
    });
    p.process.stderr.on("data", () => {}); // Never publish raw plugin output or credentials.
    p.process.on("error", (e) => this.fail(p, e));
    p.process.on("exit", (code) => {
      p.process = null;
      if (p.state !== "stopped")
        this.fail(p, Error(`플러그인이 종료됐습니다 (${code}).`));
    });
    p.startTimer = setTimeout(() => {
      if (p.state !== "connected") {
        this.fail(p, Error("플러그인 연결 시간이 초과됐습니다."));
        this.kill(p);
      }
    }, 20000);
    p.startTimer.unref();
    this.persist();
    this.onChange();
  }
  kill(p) {
    clearTimeout(p.startTimer);
    p.socket?.terminate();
    p.socket = null;
    for (const [token, owner] of this.sessions)
      if (owner === p) this.sessions.delete(token);
    for (const wait of p.pending.values()) {
      clearTimeout(wait.timer);
      wait.reject(Error("플러그인 연결이 종료됐습니다."));
    }
    p.pending.clear();
    if (p.process) {
      try {
        process.kill(-p.process.pid, "SIGTERM");
      } catch {}
      const child = p.process;
      const t = setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }, 1500);
      t.unref();
    }
    p.secret = null;
    p.values = {};
  }
  stop(id) {
    const p = this.items.find((p) => p.id === id);
    if (!p) throw Error("플러그인을 찾을 수 없습니다.");
    p.state = "stopped";
    p.enabled = false;
    this.kill(p);
    this.persist();
    this.onChange();
  }
  remove(id) {
    this.stop(id);
    this.items = this.items.filter((p) => p.id !== id);
    this.persist();
    this.onChange();
  }
  fail(p, e) {
    p.state = "error";
    p.error = String(e.message || e).slice(0, 256);
    this.onChange();
  }
  async handle(q, s) {
    const reply = (code, obj) => {
      s.writeHead(code, { "Content-Type": "application/json" });
      s.end(JSON.stringify(obj));
    };
    try {
      if (q.headers.origin || !/^127\.0\.0\.1:\d+$/.test(q.headers.host || ""))
        return reply(403, {});
      if (q.method === "GET" && q.url === "/api/plugins/protocol")
        return reply(200, descriptor);
      if (q.method === "POST" && q.url === "/api/plugins/sessions") {
        const p = this.items.find(
          (p) =>
            p.id === q.headers["x-macrodeck-plugin-id"] &&
            p.process &&
            equal(p.secret, q.headers["x-macrodeck-plugin-secret"]),
        );
        if (!p) return reply(401, {});
        let raw = "";
        for await (const b of q) {
          raw += b;
          if (Buffer.byteLength(raw) > 262144) throw Error("Message too large");
        }
        const b = JSON.parse(raw);
        if (
          !(
            b.requestedVersion?.minimum <= 3 && b.requestedVersion?.maximum >= 3
          ) ||
          !Array.isArray(b.capabilities) ||
          b.capabilities.length > 128
        )
          return reply(400, { error: "Unsupported protocol/capabilities" });
        this.killSession(p);
        p.token = crypto.randomBytes(32).toString("base64url");
        p.sessionId = crypto.randomUUID();
        this.sessions.set(p.token, p);
        p.capabilities = negotiate(b.capabilities);
        return reply(201, {
          sessionId: p.sessionId,
          sessionToken: p.token,
          negotiatedVersion: 3,
          capabilities: p.capabilities,
          limits: descriptor.limits,
          timeouts: descriptor.timeouts,
        });
      }
      reply(404, {});
    } catch {
      reply(400, { error: "Invalid plugin request" });
    }
  }
  killSession(p) {
    p.socket?.terminate();
    p.socket = null;
    for (const [key, owner] of this.sessions)
      if (owner === p) this.sessions.delete(key);
  }
  send(p, type, payload, correlationId) {
    if (p.socket?.readyState !== 1) throw Error("플러그인 연결이 없습니다.");
    if (p.socket.bufferedAmount > 262144) {
      p.socket.terminate();
      throw Error("플러그인 전송 한도 초과");
    }
    p.socket.send(
      JSON.stringify({ type, id: crypto.randomUUID(), correlationId, payload }),
    );
  }
  connect(p, w) {
    p.socket = w;
    p.messages = 0;
    p.window = Date.now();
    w.on("error", () => {});
    w.on("close", () => {
      if (p.socket === w) {
        p.socket = null;
        p.values = {};
        if (p.state !== "stopped")
          this.fail(p, Error("플러그인 연결이 끊겼습니다."));
      }
    });
    w.on("message", (raw) => {
      try {
        if (Date.now() - p.window > 1000) {
          p.window = Date.now();
          p.messages = 0;
        }
        if (++p.messages > 200) throw Error("Plugin message limit exceeded");
        const e = JSON.parse(raw);
        if (typeof e.id !== "string" || e.id.length > 128)
          throw Error("Invalid envelope");
        if (e.type === "session.hello") {
          this.send(
            p,
            "session.welcome",
            { sessionId: p.sessionId, resumed: false },
            e.id,
          );
          clearTimeout(p.startTimer);
          p.state = "connected";
          this.onChange();
          setTimeout(
            () => this.describe(p).catch((x) => this.fail(p, x)),
            100,
          ).unref();
        } else if (e.type === "session.ping")
          this.send(p, "session.pong", undefined, e.id);
        else if (e.type === "capability.declare") {
          p.capabilities = negotiate(e.payload?.capabilities);
          this.send(
            p,
            "capability.declare.ack",
            { capabilities: p.capabilities },
            e.id,
          );
          this.describe(p).catch((x) => this.fail(p, x));
        } else if (e.type === "capability.result") {
          const pending = p.pending.get(e.correlationId);
          if (pending) {
            clearTimeout(pending.timer);
            p.pending.delete(e.correlationId);
            e.error
              ? pending.reject(Error(e.error.message || e.error.code))
              : pending.resolve(e.payload?.data);
          }
        } else if (e.type === "host.invoke") this.hostInvoke(p, e);
        else if (e.type === "event.publish") {
          if (p.capabilities?.some((c) => c.kind === "events" && c.accepted)) {
            p.lastEvent = { ...e.payload, at: Date.now() };
            this.onEvent(p.id, e.payload?.eventId, e.payload?.parameters);
            this.onChange();
          }
        } else if (e.type === "session.goodbye") w.close();
      } catch (x) {
        this.fail(p, x);
        w.terminate();
      }
    });
  }
  hostInvoke(p, e) {
    const { api, operation } = e.payload || {};
    let supported = false,
      data = null;
    if (api === "config" && operation === "entries") {
      supported = true;
      data = [];
    } else if (api === "variables" && operation === "refresh") {
      supported = true;
      this.readVariables(p).catch(() => {});
    }
    if (supported) this.send(p, "host.result", { data }, e.id);
    else
      p.socket.send(
        JSON.stringify({
          type: "host.result",
          id: crypto.randomUUID(),
          correlationId: e.id,
          error: {
            code: "CAPABILITY_UNSUPPORTED",
            message: `Open Deck does not support ${api}/${operation}.`,
            retryable: false,
          },
        }),
      );
  }
  request(p, kind, localId, operation, args = null) {
    if (p.pending.size >= 4)
      return Promise.reject(Error("플러그인이 처리 중입니다."));
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID(),
        timer = setTimeout(() => {
          p.pending.delete(id);
          reject(Error("플러그인 응답 시간 초과"));
        }, 5000);
      timer.unref();
      p.pending.set(id, { resolve, reject, timer });
      try {
        if (p.socket?.readyState !== 1)
          throw Error("플러그인이 연결되지 않았습니다.");
        p.socket.send(
          JSON.stringify({
            type: "capability.invoke",
            id,
            deadlineMs: 5000,
            payload: { kind, localId, operation, arguments: args },
          }),
        );
      } catch (e) {
        clearTimeout(timer);
        p.pending.delete(id);
        reject(e);
      }
    });
  }
  async describe(p) {
    if (p.describing) return;
    p.describing = true;
    try {
      if (p.capabilities?.some((c) => c.kind === "actions" && c.accepted))
        p.actions =
          (
            await this.request(p, "actions", "describe", "describe")
          )?.actions?.slice(0, 128) || [];
      if (p.capabilities?.some((c) => c.kind === "variables" && c.accepted)) {
        const catalog = await this.request(
          p,
          "variables",
          "describe",
          "describe",
        );
        p.variables = (catalog?.variables || [])
          .filter((v) => v.materialization !== "on-demand")
          .slice(0, 64)
          .map((v) => ({ ...v, alias: alias(p.id, v.id || v.name) }));
        await this.readVariables(p);
      }
      this.onChange();
    } finally {
      p.describing = false;
    }
  }
  async readVariables(p) {
    if (p.reading || p.state !== "connected") return;
    p.reading = true;
    try {
      for (const v of p.variables) {
        const result = await this.request(
          p,
          "variables",
          v.id || v.name,
          "get",
        );
        const x = result?.value;
        const value =
          x?.kind === "text"
            ? x.text
            : x?.kind === "number"
              ? x.number
              : x?.kind === "boolean"
                ? x.boolean
                : null;
        if (value !== null && value !== undefined)
          p.values[v.alias] =
            typeof value === "string" ? value.slice(0, 2048) : value;
        else delete p.values[v.alias];
      }
      this.onChange();
    } finally {
      p.reading = false;
    }
  }
  poll() {
    for (const p of this.items)
      if (p.state === "connected")
        this.readVariables(p).catch((e) => {
          p.error = e.message;
          this.onChange();
        });
  }
  async invoke(id, actionId, parameters = {}) {
    const p = this.items.find((p) => p.id === id && p.state === "connected");
    if (!p || !p.actions.some((a) => a.localId === actionId))
      throw Error("지원되는 플러그인 동작이 아닙니다.");
    const result = await this.request(p, "actions", actionId, "execute", {
      parameters,
    });
    if (result?.status && result.status !== "Succeeded")
      throw Error(
        result.error?.message?.literal ||
          result.errorCode ||
          "플러그인 동작 실패",
      );
    await this.readVariables(p);
    return result;
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    for (const p of this.items) {
      p.state = "stopped";
      this.kill(p);
    }
    this.ws.close();
    await new Promise((resolve) => this.server.close(resolve));
  }
}
