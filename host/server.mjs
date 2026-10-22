import http from "node:http";
import { MacMetrics } from "./mac-metrics.mjs";
import { GrafanaMonitor, grafanaSource, grafanaSecretId } from "./grafana.mjs";
import { Extensions, osPage } from "./extensions.mjs";
import { Plugins } from "./plugins.mjs";
import { saveAsset, readAsset } from "./assets.mjs";
import { Connectors, setSecret } from "./connectors.mjs";
import https from "node:https";
import { loadIdentity, localAddresses } from "./network.mjs";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { dataDir, loadConfig, validateConfig, writeJson } from "./config.mjs";
import { Engine } from "./engine.mjs";
import { Scheduler } from "./scheduler.mjs";
const publicDir = fileURLToPath(new URL("./public/", import.meta.url));
const digest = (v) => crypto.createHash("sha256").update(v).digest("hex");
const equal = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.length === b.length &&
  crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const deviceConfig = (c) => ({
  ...c,
  automations: undefined,
  integrations: undefined,
  extensions: undefined,
  pages: c.pages.map((p) => ({
    ...p,
    widgets: p.widgets.map(({ actions, longActions, doubleActions, ...w }) => ({
      ...w,
      ...(w.type === "grafana"
        ? {
            url: undefined,
            auth: undefined,
            cpuPanelId: undefined,
            tpsPanelId: undefined,
          }
        : {}),
      ...(w.provider === "jimin-os" &&
      actions?.[0]?.type === "extension" &&
      actions[0].extensionId === "jimin-os" &&
      actions[0].operation === "navigate"
        ? { osView: actions[0].parameters?.view }
        : {}),
      gestures: {
        long: !!longActions?.length,
        double: !!doubleActions?.length,
      },
    })),
  })),
});
export function createHost({
  dir = dataDir,
  runner,
  metrics = true,
  wifi = false,
  wifiPort = 8841,
  extensionOptions = {},
  grafanaOptions = {},
} = {}) {
  let config = loadConfig(dir);
  let configRevision = 1;
  const adminKey = crypto.randomBytes(32).toString("hex");
  const devicesFile = path.join(dir, "devices.json");
  let devices = fs.existsSync(devicesFile)
    ? JSON.parse(fs.readFileSync(devicesFile, "utf8"))
    : [];
  let pin = String(crypto.randomInt(100000, 1000000)),
    pinExpires = Date.now() + 600000;
  let lanServer = null,
    identity = null,
    wifiError = "";
  const network = () => ({
    urls: lanServer?.listening
      ? localAddresses().map(
          (ip) => `https://${ip}:${lanServer.address().port}`,
        )
      : [],
    fingerprint: identity?.fingerprint || "",
    error: wifiError,
  });
  const snapshot = () => ({
    config: deviceConfig(config),
    state: engine.state(),
    network: network(),
  });
  const streams = new Set(),
    attempts = new Map();
  const broadcast = () => {
    const common = { state: engine.state(), network: network() };
    let full = null,
      delta = null;
    for (const s of streams) {
      if (s.writableLength > 256000) {
        s.destroy();
        streams.delete(s);
        continue;
      }
      let data;
      if (s.openDeckRevision !== configRevision) {
        full ??= JSON.stringify({ ...common, config: deviceConfig(config) });
        data = full;
        s.openDeckRevision = configRevision;
      } else {
        delta ??= JSON.stringify(common);
        data = delta;
      }
      s.write(`event: snapshot\ndata: ${data}\n\n`);
    }
  };
  const engine = new Engine(config, broadcast, runner);
  const connectors = new Connectors(
    () => config,
    (k, v) => engine.setVariable(k, v),
    () => {
      engine.integrations = connectors.status;
      broadcast();
    },
  );
  engine.connectors = connectors;
  const plugins = new Plugins(
    dir,
    () => {
      engine.pluginValues = plugins.values();
      broadcast();
    },
    (pluginId, eventId) => engine.pluginEvent(pluginId, eventId),
  );
  engine.plugins = plugins;
  const extensions = new Extensions({
    dir,
    providerOptions: extensionOptions,
    getConfig: () => config,
    onChange: broadcast,
  });
  engine.extensions = extensions;
  const grafana = new GrafanaMonitor(() => config, broadcast, grafanaOptions);
  engine.grafana = grafana;
  if (metrics) grafana.tick();
  if (metrics) engine.systemMonitor = new MacMetrics(broadcast);
  const stateFile = path.join(dir, "state.json");
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    for (const [k, v] of Object.entries(saved.variables || {}))
      if (typeof config.variables[k] === typeof v) engine.variables[k] = v;
    engine.todos = saved.todos || {};
  } catch {}
  engine.onPersist = () =>
    writeJson(stateFile, { variables: engine.variables, todos: engine.todos });
  const send = (res, status, data) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(data));
  };
  const body = async (req) => {
    if (!req.headers["content-type"]?.startsWith("application/json"))
      throw Object.assign(Error("JSON이 필요합니다."), { status: 415 });
    let size = 0,
      text = "";
    for await (const b of req) {
      size += b.length;
      if (size > 3000000)
        throw Object.assign(Error("요청이 너무 큽니다."), { status: 413 });
      text += b;
    }
    return JSON.parse(text || "{}");
  };
  const isAdmin = (req) =>
    equal(req.headers["x-open-deck-admin"], adminKey) ||
    equal(
      req.headers.cookie
        ?.split(";")
        .map((s) => s.trim())
        .find((s) => s.startsWith("od_admin="))
        ?.slice(9),
      adminKey,
    );
  const device = (req) => {
    const token = req.headers.authorization?.replace(/^Bearer /, "");
    if (!token) return null;
    const h = digest(token);
    return devices.find((d) => equal(d.hash, h));
  };
  const handler =
    (lan = false) =>
    async (req, res) => {
      try {
        const host = req.headers.host || "";
        if (!lan && !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host))
          return send(res, 403, { error: "로컬 연결만 허용됩니다." });
        if (
          req.headers.origin &&
          (lan || req.headers.origin !== `http://${host}`)
        )
          return send(res, 403, { error: "허용되지 않은 출처입니다." });
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader(
          "Content-Security-Policy",
          "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
        );
        const u = new URL(req.url, `http://${host}`),
          admin = !lan && isAdmin(req),
          authenticated = admin || device(req);
        if (
          lan &&
          ![
            "/health",
            "/api/pair",
            "/api/snapshot",
            "/api/events",
            "/api/action",
          ].includes(u.pathname) &&
          !/^\/api\/assets\/[a-f0-9]{64}$/.test(u.pathname) &&
          !/^\/api\/extensions\/jimin-os\/mutations(?:\/[0-9a-f-]{36})?$/i.test(
            u.pathname,
          )
        )
          return send(res, 403, {
            error: "Wi-Fi에서는 태블릿 연결만 허용됩니다.",
          });
        if (req.method === "GET" && u.pathname === "/health")
          return send(res, 200, { name: "Open Deck", version: "0.8.3" });
        if (req.method === "POST" && u.pathname === "/api/pair") {
          const now = Date.now(),
            key = req.socket.remoteAddress,
            bucket = attempts.get(key) || { at: now, n: 0 };
          if (now - bucket.at > 60000) {
            bucket.at = now;
            bucket.n = 0;
          }
          bucket.n++;
          attempts.set(key, bucket);
          if (bucket.n > 8)
            return send(res, 429, { error: "잠시 후 다시 시도하세요." });
          const b = await body(req);
          if (now > pinExpires || !equal(String(b.pin || ""), pin))
            return send(res, 401, {
              error: "페어링 코드가 틀리거나 만료되었습니다.",
            });
          const token = crypto.randomBytes(32).toString("hex");
          devices.push({
            id: crypto.randomUUID(),
            name: String(b.name || "Android").slice(0, 80),
            hash: digest(token),
            createdAt: new Date().toISOString(),
          });
          writeJson(devicesFile, devices);
          pin = String(crypto.randomInt(100000, 1000000));
          pinExpires = Date.now() + 600000;
          return send(res, 200, { token, name: config.name });
        }
        if (u.pathname.startsWith("/api/admin") && !admin)
          return send(res, 403, {
            error: "맥 편집기에서만 변경할 수 있습니다.",
          });
        if (u.pathname.startsWith("/api/") && !authenticated)
          return send(res, 401, { error: "먼저 페어링하세요." });
        if (req.method === "GET" && u.pathname === "/api/admin/info")
          return send(res, 200, {
            pin,
            pinExpires,
            devices: devices.map(({ hash, ...d }) => d),
            config,
            network: network(),
            connections: [...streams].map((s) => ({
              transport: s.socket?.encrypted ? "wifi" : "usb",
              address: s.socket?.remoteAddress,
            })),
          });
        if (req.method === "POST" && u.pathname === "/api/admin/pin") {
          pin = String(crypto.randomInt(100000, 1000000));
          pinExpires = Date.now() + 600000;
          return send(res, 200, { pin, pinExpires });
        }
        if (req.method === "POST" && u.pathname === "/api/admin/revoke") {
          const b = await body(req);
          devices = devices.filter((d) => d.id !== b.id);
          writeJson(devicesFile, devices);
          for (const s of streams) s.end();
          streams.clear();
          return send(res, 200, { ok: true });
        }
        if (req.method === "PUT" && u.pathname === "/api/admin/config") {
          const candidate = validateConfig(await body(req));
          writeJson(path.join(dir, "deck.json"), candidate);
          config = candidate;
          configRevision++;
          engine.configure(config);
          for (const id of engine.timers.keys())
            if (!engine.widget(id)) engine.timers.delete(id);
          broadcast();
          return send(res, 200, { ok: true, config });
        }
        if (req.method === "GET" && u.pathname === "/api/admin/extensions")
          return send(res, 200, { extensions: extensions.state() });
        if (req.method === "POST" && u.pathname === "/api/admin/extensions") {
          const b = await body(req);
          if (b.id !== "jimin-os") throw Error("지원하지 않는 연결입니다.");
          const candidate = structuredClone(config);
          candidate.extensions ??= {};
          candidate.extensions["jimin-os"] = {
            enabled: b.enabled !== false,
            notifications: b.notifications !== false,
            reminderMinutes: b.reminderMinutes ?? 10,
          };
          if (
            b.addPage &&
            !candidate.pages.some((p) => p.id === "jimin-os-page")
          )
            candidate.pages.push(osPage());
          config = validateConfig(candidate);
          writeJson(path.join(dir, "deck.json"), config);
          configRevision++;
          engine.configure(config);
          broadcast();
          extensions.poll();
          return send(res, 200, { config, extensions: extensions.state() });
        }
        if (
          req.method === "POST" &&
          u.pathname === "/api/admin/extensions/test-notification"
        ) {
          extensions.testNotification();
          return send(res, 200, { ok: true });
        }
        if (req.method === "GET" && u.pathname === "/api/admin/plugins")
          return send(res, 200, { plugins: plugins.list() });
        if (req.method === "POST" && u.pathname === "/api/admin/plugins") {
          const b = await body(req);
          if (b.operation === "register") plugins.register(b.folder);
          else if (b.operation === "start") await plugins.start(b.id);
          else if (b.operation === "stop") plugins.stop(b.id);
          else if (b.operation === "remove") plugins.remove(b.id);
          else throw Error("잘못된 플러그인 요청입니다.");
          return send(res, 200, { plugins: plugins.list() });
        }
        if (req.method === "POST" && u.pathname === "/api/admin/assets")
          return send(res, 200, saveAsset(dir, (await body(req)).data));
        if (req.method === "POST" && u.pathname === "/api/admin/secret") {
          const b = await body(req);
          await setSecret(b.id, b.value);
          return send(res, 200, { ok: true });
        }
        if (
          req.method === "POST" &&
          u.pathname === "/api/admin/grafana-token"
        ) {
          const b = await body(req),
            w = engine.widget(b.widgetId);
          if (!w || w.type !== "grafana")
            throw Error("Grafana 위젯을 선택하세요.");
          const source = grafanaSource(w);
          try {
            await setSecret(grafanaSecretId(source.origin), b.token);
          } catch {
            throw Error("Grafana 토큰을 키체인에 저장하지 못했습니다.");
          }
          grafana.refresh();
          return send(res, 200, { ok: true });
        }
        if (req.method === "POST" && u.pathname === "/api/admin/monitor-test") {
          const b = await body(req),
            w = engine.widget(b.widgetId),
            page = config.pages.find((p) =>
              p.widgets.some((w) => w.id === b.widgetId),
            );
          if (!w || !["grafana", "system"].includes(w.type))
            throw Error("모니터 위젯을 선택하세요.");
          engine.monitorAlerts.testNotification(page, w);
          broadcast();
          return send(res, 200, { ok: true });
        }
        if (req.method === "POST" && u.pathname === "/api/admin/refresh") {
          const b = await body(req);
          return send(res, 200, { value: await connectors.run(b.id) });
        }
        if (
          req.method === "GET" &&
          /^\/api\/assets\/[a-f0-9]{64}$/.test(u.pathname)
        ) {
          const asset = readAsset(dir, u.pathname.split("/").pop());
          res.writeHead(200, {
            "Content-Type": asset.mime,
            "Cache-Control": "private, max-age=86400",
          });
          res.end(asset.bytes);
          return;
        }
        if (req.method === "GET" && u.pathname === "/api/snapshot")
          return send(res, 200, snapshot());
        if (req.method === "GET" && u.pathname === "/api/events") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
            Connection: "keep-alive",
          });
          res.write(": connected\n\n");
          streams.add(res);
          broadcast();
          req.on("close", () => streams.delete(res));
          return;
        }
        if (
          req.method === "GET" &&
          /^\/api\/extensions\/jimin-os\/mutations\/[0-9a-f-]{36}$/i.test(
            u.pathname,
          )
        )
          return send(
            res,
            200,
            await extensions.mutationStatus(
              device(req)?.id || "admin",
              u.pathname.split("/").pop(),
            ),
          );
        if (
          req.method === "POST" &&
          u.pathname === "/api/extensions/jimin-os/mutations"
        ) {
          const input = await body(req),
            w = engine.widget(input.widgetId);
          if (!w || w.provider !== "jimin-os")
            throw Error("연결된 위젯을 확인해 주세요.");
          const view = w.actions?.find(
            (a) =>
              a.type === "extension" &&
              a.extensionId === "jimin-os" &&
              a.operation === "navigate",
          )?.parameters?.view;
          const calendar = ["calendar", "agenda"].includes(w.type);
          if (!(
            (input.operation === "create-schedule" &&
              (calendar || view === "new-schedule")) ||
            (input.operation === "complete-task" &&
              (calendar || view === "tasks"))
          ))
            throw Error("이 위젯에서 사용할 수 없는 동작이에요.");
          return send(
            res,
            202,
            await extensions.mutate(device(req)?.id || "admin", input),
          );
        }
        if (req.method === "POST" && u.pathname === "/api/action") {
          const b = await body(req);
          if (b.kind === "extension") {
            const w = engine.widget(b.id);
            if (!w || w.provider !== "jimin-os")
              throw Error("연결된 위젯을 확인하세요.");
            const allowed =
              w.type === "calendar" || w.type === "agenda"
                ? ["open-schedule", "open-task"]
                : w.type === "inbox"
                  ? ["navigate"]
                  : [];
            if (!allowed.includes(b.operation))
              throw Error("지원하지 않는 위젯 동작입니다.");
            return send(
              res,
              200,
              await extensions.invoke(
                "jimin-os",
                b.operation,
                w.type === "inbox"
                  ? { view: "requests" }
                  : { itemId: b.itemId },
              ),
            );
          }
          if (b.kind === "control") {
            const value = engine.control(b.id, b.value);
            if (
              engine.widget(b.id)?.type === "toggle" &&
              engine.widget(b.id).actions?.length
            )
              await engine.run(b.id);
            return send(res, 200, { value });
          }
          if (b.kind === "todo")
            return send(res, 200, {
              items: engine.todo(b.id, b.gesture, b.value),
            });
          if (b.kind === "volume") {
            await engine.setVolume(b.value);
            return send(res, 200, { ok: true });
          }
          if (b.kind === "timer")
            return send(res, 200, engine.timer(b.id, b.gesture));
          return send(res, 200, await engine.run(b.id, b.gesture || "tap"));
        }
        if (
          req.method === "GET" &&
          [
            "/",
            "/app.js",
            "/app.css",
            "/layout.mjs",
            "/monitor-layout.mjs",
            "/monitor-rules.mjs",
          ].includes(u.pathname)
        ) {
          if (!admin)
            return send(res, 401, {
              error: "Open Deck.app에서 편집기를 여세요.",
            });
          if (equal(req.headers["x-open-deck-admin"], adminKey))
            res.setHeader(
              "Set-Cookie",
              `od_admin=${adminKey}; HttpOnly; SameSite=Strict; Path=/`,
            );
          const file = u.pathname === "/" ? "index.html" : u.pathname.slice(1);
          res.setHeader(
            "Content-Type",
            file.endsWith(".js") || file.endsWith(".mjs")
              ? "text/javascript"
              : file.endsWith(".css")
                ? "text/css"
                : "text/html",
          );
          res.end(fs.readFileSync(path.join(publicDir, file)));
          return;
        }
        send(res, 404, { error: "찾을 수 없습니다." });
      } catch (e) {
        if (!res.headersSent) send(res, e.status || 400, { error: e.message });
        else res.end();
      }
    };
  const server = http.createServer(handler());
  if (wifi) {
    try {
      identity = loadIdentity(dir);
      lanServer = https.createServer(
        { key: identity.key, cert: identity.cert, minVersion: "TLSv1.2" },
        handler(true),
      );
      lanServer.on("error", (e) => {
        wifiError = e.message;
        console.error("Wi-Fi listener:", e.message);
      });
      lanServer.listen(wifiPort, "0.0.0.0");
    } catch (e) {
      wifiError = e.message;
      console.error("Wi-Fi unavailable:", e.message);
    }
  }
  const interval = metrics ? setInterval(() => engine.metrics(), 1000) : null;
  const scheduler = new Scheduler(
    () => config,
    (id) => engine.run(id),
  );
  const schedule = metrics ? setInterval(() => scheduler.tick(), 1000) : null;
  server.on("close", () => {
    clearInterval(interval);
    clearInterval(schedule);
    connectors.close();
    extensions.close();
    engine.systemMonitor?.close();
    grafana.close();
    plugins.close();
    for (const s of streams) s.end();
  });
  return {
    server,
    get lanServer() {
      return lanServer;
    },
    network,
    engine,
    adminKey,
    getPin: () => pin,
    close: () =>
      new Promise((resolve) => {
        for (const s of streams) s.end();
        streams.clear();
        plugins.close();
        const listeners = [server, lanServer].filter(Boolean);
        Promise.all(
          listeners.map(
            (s) =>
              new Promise((done) => {
                s.close(done);
                s.closeAllConnections();
              }),
          ),
        ).then(resolve);
      }),
  };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const host = createHost({ wifi: true });
  const port = Number(process.env.OPEN_DECK_PORT || 8840);
  host.server.listen(port, "127.0.0.1", () => {
    writeJson(path.join(dataDir, "runtime.json"), {
      port: host.server.address().port,
      adminKey: host.adminKey,
      pid: process.pid,
    });
    console.log(
      `Open Deck ready on USB/localhost:${host.server.address().port}`,
    );
  });
  let shuttingDown = false;
  for (const sig of ["SIGINT", "SIGTERM"])
    process.on(sig, async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      await host.close();
      process.exit(0);
    });
}
