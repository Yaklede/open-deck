import http from "node:http";
import { spawn } from "node:child_process";
import {
  APP_VERSION,
  loadSettings,
  mergeSettings,
  validateDeviceSettings,
  Diagnostics,
  nativeStatus,
  releaseInfo,
  buildInfo,
  licenseNotices,
} from "./settings.mjs";
import { pagesFor, profileFor, effectivePages } from "./public/profiles.mjs";
import { Backups } from "./backups.mjs";
import { EditorLock } from "./editor-lock.mjs";
import { AccountManager } from "./account.mjs";
import { SecretVault } from "./secret-vault.mjs";
import {
  adbStatus,
  adbOperation,
  installCompanion,
  downloadPlatformTools,
  downloadCompanionPackage,
  installedCompanion,
  installCompanionPackage,
} from "./system-tools.mjs";
import { MacMetrics } from "./mac-metrics.mjs";
import { GrafanaMonitor, grafanaSource, grafanaSecretId } from "./grafana.mjs";
import { Extensions, osPage } from "./extensions.mjs";
import { Plugins } from "./plugins.mjs";
import { saveAsset, readAsset } from "./assets.mjs";
import { Connectors, setSecret, readSecret } from "./connectors.mjs";
import { CompanionUpdater } from "./companion-update.mjs";
import { Migration } from "./migration.mjs";
import { NetworkListeners } from "./network-listeners.mjs";
import {
  loadIdentity,
  localAddresses,
  certificateInfo,
  installCertificate,
  issueLocalCertificate,
  exportAuthority,
} from "./network.mjs";
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
export const deviceConfig = (c, d = null) => ({
  ...c,
  automations: undefined,
  integrations: undefined,
  extensions: undefined,
  pages: effectivePages(c, d).map((p) => ({
    ...p,
    widgets: p.widgets.map(({ actions, longActions, doubleActions, ...w }) => ({
      ...w,
      ...(w.type === "grafana"
        ? {
            url: undefined,
            auth: undefined,
            cpuPanelId: undefined,
            tpsPanelId: undefined,
            latencyPanelId: undefined,
            errorRatePanelId: undefined,
            rpsPanelId: undefined,
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
  const existedBeforeStart = fs.existsSync(path.join(dir, "deck.json"));
  let config = loadConfig(dir);
  let settings = loadSettings(dir);
  const diagnostics = new Diagnostics(dir, () => settings);
  diagnostics.log("info", "host.started");
  const editorLock = new EditorLock(dir, () => settings);
  const account = new AccountManager(dir);
  const vault = new SecretVault({ dir });
  const resolveSecret = async (id) =>
    vault.hasSecret(id) ? vault.readSecret(id) : readSecret(id);
  let configRevision = 1;
  const adminKey = crypto.randomBytes(32).toString("hex");
  const devicesFile = path.join(dir, "devices.json");
  let devices = fs.existsSync(devicesFile)
    ? JSON.parse(fs.readFileSync(devicesFile, "utf8"))
    : [];
  let pin = String(crypto.randomInt(100000, 1000000)),
    pinExpires = Date.now() + 600000;
  let networkListeners = null,
    identity = null,
    wifiError = "";
  let discoveryProcess = null;
  const network = () => ({
    urls: networkListeners?.endpoints(localAddresses()) || [],
    tlsEnabled: settings.network.tlsEnabled,
    tlsMode: settings.network.tlsEnabled
      ? settings.network.tlsMode
      : "Disabled",
    fingerprint: identity?.fingerprint || "",
    error: wifiError,
  });
  const safeDevice = (d) =>
    d
      ? {
          id: d.id,
          name: d.name,
          settings: d.settings || {},
          settingsRevision: d.settingsRevision || 0,
          screenSaverAt: d.screenSaverAt || 0,
        }
      : null;
  const adminDevices = () =>
    devices.map((d) => ({
      ...safeDevice(d),
      ...(d.model ? { model: d.model } : {}),
      ...(d.appVersion ? { appVersion: d.appVersion } : {}),
      online: [...streams].some((s) => s.openDeckDeviceId === d.id),
    }));
  const monitorScope = (d) =>
    d
      ? effectivePages(config, d).flatMap((p) => p.widgets.map((w) => w.id))
      : null;
  const scopedState = (state, d) => {
    if (!d) return state;
    const allowed = new Set(monitorScope(d));
    const inbox = engine.monitorAlerts.inbox(config, allowed);
    const records = new Map(inbox.incidents.map((r) => [r.id, r]));
    const notification = (n) => {
      if (n.kind !== "monitor") return n;
      const record = records.get(n.incidentId);
      if (!record) return null;
      const conditions = (n.conditions || record.conditions).filter((c) =>
        allowed.has(c.widgetId),
      );
      if (!conditions.length) return null;
      const severity =
        n.severity === "normal"
          ? "normal"
          : conditions.some((c) => c.level === "critical")
            ? "critical"
            : "warning";
      return {
        ...n,
        conditions,
        severity,
        widgetId: conditions[0].widgetId,
        pageId: record.pageIds[0],
        title:
          record.title +
          " · " +
          (severity === "normal"
            ? "정상 복구"
            : severity === "critical"
              ? "위험"
              : "주의"),
        body:
          n.synthetic || severity === "normal"
            ? n.body
            : conditions.map((c) => `${c.label} ${c.value ?? "—"}`).join(" · "),
      };
    };
    return {
      ...state,
      monitoring: {
        ...state.monitoring,
        inbox,
        widgets: Object.fromEntries(
          Object.entries(state.monitoring?.widgets || {}).filter(([id]) =>
            allowed.has(id),
          ),
        ),
        notifications: (state.monitoring?.notifications || [])
          .map(notification)
          .filter(Boolean),
      },
      notifications: (state.notifications || [])
        .map(notification)
        .filter(Boolean),
    };
  };
  const snapshot = (d = null, admin = false) => ({
    config: deviceConfig(config, d),
    device: safeDevice(d),
    ...(admin ? { devices: adminDevices() } : {}),
    state: scopedState(engine.state(), d),
    network: network(),
  });
  const focusSessions = new Map();
  const streams = new Set(),
    attempts = new Map();
  const broadcast = () => {
    const common = { state: engine.state(), network: network() };
    const deviceList = adminDevices(),
      deviceStamp = JSON.stringify(deviceList);
    for (const s of streams) {
      if (
        !s.openDeckDeviceId &&
        (editorLock.status().locked ||
          !account.authenticate(s.openDeckSession, { touch: false }))
      ) {
        s.end();
        streams.delete(s);
        continue;
      }
      if (s.writableLength > 256000) {
        s.destroy();
        streams.delete(s);
        continue;
      }
      const d = s.openDeckDeviceId
        ? devices.find((d) => d.id === s.openDeckDeviceId)
        : null;
      if (s.openDeckDeviceId && !d) {
        s.end();
        streams.delete(s);
        continue;
      }
      const revision = configRevision + ":" + (d?.settingsRevision || 0);
      const data = {
        ...common,
        state: scopedState(common.state, d),
        device: safeDevice(d),
      };
      if (!s.openDeckDeviceId && s.openDeckDevices !== deviceStamp) {
        data.devices = deviceList;
        s.openDeckDevices = deviceStamp;
      }
      if (s.openDeckRevision !== revision) {
        data.config = deviceConfig(config, d);
        s.openDeckRevision = revision;
      }
      s.write(`event: snapshot\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };
  const engine = new Engine(config, broadcast, runner, {
    dir,
    onError: (operation) =>
      diagnostics.log("error", `monitor.history.${operation}_failed`),
  });
  const connectors = new Connectors(
    () => config,
    (k, v) => engine.setVariable(k, v),
    () => {
      engine.integrations = connectors.status;
      broadcast();
    },
  );
  connectors.getSettings = () => settings;
  connectors.secret = resolveSecret;
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
  const grafana = new GrafanaMonitor(() => config, broadcast, {
    secret: resolveSecret,
    ...grafanaOptions,
  });
  engine.grafana = grafana;
  if (metrics) grafana.tick();
  if (metrics) engine.systemMonitor = new MacMetrics(broadcast);
  const recovery = { count: 0, at: 0 };
  const resumeConnections = () => {
    if (Date.now() - recovery.at < 2000) return;
    recovery.count++;
    recovery.at = Date.now();
    diagnostics.log("info", "connections.resumed", { count: recovery.count });
    grafana.resume();
    for (const stream of streams) stream.end();
    streams.clear();
  };
  const stateFile = path.join(dir, "state.json");
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    for (const [k, v] of Object.entries(saved.variables || {}))
      if (typeof config.variables[k] === typeof v) engine.variables[k] = v;
    engine.todos = saved.todos || {};
  } catch {}
  engine.onPersist = () =>
    writeJson(stateFile, { variables: engine.variables, todos: engine.todos });
  const applyConfig = (candidate) => {
    candidate = validateConfig(candidate);
    writeJson(path.join(dir, "deck.json"), candidate);
    config = candidate;
    configRevision++;
    engine.configure(config);
    let deviceChanged = false;
    for (const d of devices) {
      const current = d.settings || {};
      const p = profileFor(config, d);
      if (
        (current.profileId &&
          !config.profiles.some((p) => p.id === current.profileId)) ||
        (current.startPageId && !p.pageIds.includes(current.startPageId))
      ) {
        d.settings = {
          ...current,
          profileId: config.profiles.some((p) => p.id === current.profileId)
            ? current.profileId
            : "",
          startPageId: "",
        };
        d.settingsRevision = (d.settingsRevision || 0) + 1;
        deviceChanged = true;
      }
    }
    if (deviceChanged) writeJson(devicesFile, devices);
    for (const id of engine.timers.keys())
      if (!engine.widget(id)) engine.timers.delete(id);
    broadcast();
  };
  const backups = new Backups({
    dir,
    vault,
    getConfig: () => config,
    getSettings: () => settings,
    applyConfig,
    getPreferences: () => settings,
    applyPreferences: (p) => {
      settings = mergeSettings(settings, p);
      writeJson(path.join(dir, "preferences.json"), settings);
    },
    getState: () => ({ variables: engine.variables, todos: engine.todos }),
    applyState: (s) => {
      for (const [k, v] of Object.entries(s.variables || {}))
        if (typeof config.variables[k] === typeof v) engine.variables[k] = v;
      engine.todos = s.todos || {};
      engine.onPersist();
      broadcast();
    },
  });
  const migration = new Migration({
    dir,
    getConfig: () => config,
    applyConfig,
    backups,
  });
  const companionUpdater = new CompanionUpdater({
    getSettings: () => settings,
    listDevices: () => adbStatus(settings),
    getPackage: () => downloadCompanionPackage(),
    installedPackage: (serial) => installedCompanion(settings, serial),
    installPackage: (serial, pkg) =>
      installCompanionPackage(settings, serial, pkg),
    onEvent: (level, event, details) => diagnostics.log(level, event, details),
  });
  if (metrics) {
    const marker = path.join(dir, "last-version.json");
    let previous = "";
    try {
      previous = JSON.parse(fs.readFileSync(marker, "utf8")).version;
    } catch {}
    let versionBackupReady = true;
    if (
      previous !== APP_VERSION &&
      existedBeforeStart &&
      settings.backups.beforeUpdate
    ) {
      try {
        backups.create("before-update");
      } catch {
        versionBackupReady = false;
        diagnostics.log("error", "backup.before_update_failed");
      }
    }
    if (versionBackupReady) writeJson(marker, { version: APP_VERSION });
  }
  const updateDevice = (d, input, metadata = {}) => {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw Error("기기 설정 요청 객체가 필요합니다.");
    if (!d)
      throw Object.assign(Error("기기를 찾을 수 없습니다."), { status: 404 });
    if (
      input.name !== undefined &&
      (typeof input.name !== "string" ||
        !input.name.trim() ||
        input.name.length > 80)
    )
      throw Error("기기 이름을 확인하세요.");
    const next = validateDeviceSettings(
      d.settings || {},
      Object.hasOwn(input, "settings") ? input.settings : {},
      config,
    );
    if (input.name !== undefined) d.name = input.name.trim();
    Object.assign(d, metadata);
    d.settings = next;
    d.settingsRevision = (d.settingsRevision || 0) + 1;
    writeJson(devicesFile, devices);
    broadcast();
    diagnostics.log("info", "device.settings.saved", {
      revision: d.settingsRevision,
    });
    return safeDevice(d);
  };
  const devicePayload = (d) => ({
    device: safeDevice(d),
    profiles: config.profiles,
    defaultProfileId: config.defaultProfileId,
  });
  const allowedWidget = (d, id) =>
    !d ||
    effectivePages(config, d).some((p) => p.widgets.some((w) => w.id === id));
  const diagnosis = () => ({
    version: APP_VERSION,
    uptimeSeconds: Math.floor(process.uptime()),
    recovery: { ...recovery },
    network: network(),
    nativeStatus: nativeStatus(dir),
    logs: diagnostics.entries(),
    connections: [...streams].map((s) => ({
      transport: s.openDeckTransport,
      deviceId: s.openDeckDeviceId || "editor",
    })),
    backups: { count: backups.list().length },
  });
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
      if (
        size >
        (["/api/admin/backups", "/api/admin/migration"].includes(req.url)
          ? 96 * 1024 * 1024
          : 3000000)
      )
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
  const sessionToken = (req) =>
    req.headers.cookie
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("od_session="))
      ?.slice(11);
  const accountResponse = (res, result) => {
    const { sessionToken: token, ...safe } = result;
    if (token)
      res.setHeader(
        "Set-Cookie",
        `od_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.max(1, Math.floor((result.expiresAt - Date.now()) / 1000))}`,
      );
    else if (result.authenticated === false)
      res.setHeader(
        "Set-Cookie",
        "od_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
      );
    return send(res, 200, safe);
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
            "/api/device/settings",
            "/api/device/update",
          ].includes(u.pathname) &&
          !/^\/api\/assets\/[a-f0-9]{64}$/.test(u.pathname) &&
          !/^\/api\/monitor\/incidents\/incident-[a-f0-9]{32}$/.test(
            u.pathname,
          ) &&
          !/^\/api\/extensions\/jimin-os\/mutations(?:\/[0-9a-f-]{36})?$/i.test(
            u.pathname,
          )
        )
          return send(res, 403, {
            error: "Wi-Fi에서는 태블릿 연결만 허용됩니다.",
          });
        if (req.method === "GET" && u.pathname === "/health")
          return send(res, 200, { name: "Open Deck", version: APP_VERSION });
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
            settings: {},
            settingsRevision: 1,
          });
          writeJson(devicesFile, devices);
          pin = String(crypto.randomInt(100000, 1000000));
          pinExpires = Date.now() + 600000;
          diagnostics.log("info", "device.paired", { count: devices.length });
          broadcast();
          return send(res, 200, { token, name: config.name });
        }
        if (u.pathname.startsWith("/api/admin") && !admin)
          return send(res, 403, {
            error: "맥 편집기에서만 변경할 수 있습니다.",
          });
        if (u.pathname.startsWith("/api/") && !authenticated)
          return send(res, 401, { error: "먼저 페어링하세요." });
        if (admin && u.pathname === "/api/admin/account") {
          const token = sessionToken(req);
          if (req.method === "GET") {
            const state = account.status(token);
            return send(res, 200, {
              ...state,
              sessions: state.authenticated ? account.sessions(token) : [],
            });
          }
          if (req.method !== "POST")
            return send(res, 405, { error: "지원하지 않는 메서드입니다." });
          const input = await body(req);
          if (
            !["login", "recover", "logout", "revoke-all"].includes(
              input.operation,
            ) &&
            editorLock.status().locked
          )
            return send(res, 423, { error: "편집기 잠금을 먼저 해제하세요." });
          let result;
          switch (input.operation) {
            case "setup":
              result = account.setup(input);
              editorLock.replaceVerifiedPassword(input.password);
              break;
            case "login":
              result = account.login(input);
              editorLock.replaceVerifiedPassword(input.password);
              break;
            case "recover":
              result = account.recover(input);
              editorLock.replaceVerifiedPassword(input.password);
              break;
            case "update":
              result = account.update(token, input);
              if (input.password !== undefined)
                editorLock.replaceVerifiedPassword(input.password);
              break;
            case "logout":
              result = account.revoke(token);
              break;
            case "revoke-session":
              result = account.revoke(token, { id: input.id });
              break;
            case "revoke-all":
              result = account.revoke(token, { all: true });
              break;
            case "recovery-prepare":
              result = account.prepareRecovery(token, input.password);
              break;
            case "recovery-confirm":
              result = account.confirmRecovery(token, input);
              break;
            case "recovery-lost":
              result = account.markRecoveryLost(token, input.password);
              break;
            default:
              throw Error("계정 작업을 확인하세요.");
          }
          if (result.authenticated === false && editorLock.status().configured)
            editorLock.lock();
          broadcast();
          diagnostics.log("info", "account." + input.operation);
          return accountResponse(res, result);
        }
        if (
          admin &&
          u.pathname === "/api/admin/lock-status" &&
          req.method === "GET"
        )
          return send(res, 200, editorLock.status());
        if (
          admin &&
          u.pathname === "/api/admin/lock" &&
          req.method === "POST"
        ) {
          const input = await body(req);
          if (account.status().configured) {
            account.require(sessionToken(req));
            if (["configure", "disable"].includes(input.operation))
              throw Error("관리자 계정 설정에서 암호를 변경하세요.");
          }
          switch (input.operation) {
            case "configure": {
              const next = mergeSettings(settings, {
                security: {
                  idleLockMinutes:
                    input.idleMinutes ?? settings.security.idleLockMinutes,
                },
              });
              editorLock.configure(input.password, input.currentPassword);
              settings = next;
              writeJson(path.join(dir, "preferences.json"), settings);
              break;
            }
            case "activity":
              if (editorLock.status().locked)
                return send(res, 423, { error: "편집기가 잠겨 있습니다." });
              editorLock.touch();
              break;
            case "unlock":
              editorLock.unlock(input.password);
              break;
            case "lock":
              editorLock.lock();
              break;
            case "disable":
              editorLock.disable(input.password);
              break;
            default:
              throw Error("잠금 작업을 확인하세요.");
          }
          if (editorLock.status().locked)
            for (const stream of streams)
              if (!stream.openDeckDeviceId) {
                stream.end();
                streams.delete(stream);
              }
          diagnostics.log(
            input.operation === "activity" ? "debug" : "info",
            "editor.lock." + input.operation,
          );
          return send(res, 200, editorLock.status());
        }
        if (
          admin &&
          u.pathname.startsWith("/api/") &&
          !["/api/admin/resume", "/api/admin/focus"].includes(u.pathname)
        ) {
          if (!account.authenticate(sessionToken(req)))
            return send(res, 401, {
              error: "관리자 로그인이 필요합니다.",
              code: "ACCOUNT_LOGIN_REQUIRED",
            });
          if (editorLock.status().locked)
            return send(res, 423, {
              error: "편집기가 잠겨 있습니다. 비밀번호로 잠금을 해제하세요.",
            });
          if (
            u.pathname.startsWith("/api/admin/") &&
            !["/api/admin/info", "/api/admin/diagnostics"].includes(u.pathname)
          )
            editorLock.touch();
        }
        if (u.pathname === "/api/admin/vault" && req.method === "GET")
          return send(res, 200, {
            ...vault.status(),
            secrets: vault.status().unlocked ? vault.listSecrets() : [],
          });
        if (u.pathname === "/api/admin/vault" && req.method === "POST") {
          const input = await body(req);
          let result;
          switch (input.operation) {
            case "setup":
              result = vault.setup(input.password);
              break;
            case "unlock":
              result = vault.unlock(input.password);
              break;
            case "lock":
              result = vault.lock();
              break;
            case "password":
              result = vault.changePassword(
                input.currentPassword,
                input.password,
              );
              break;
            case "recovery-prepare":
              result = vault.prepareRecovery();
              break;
            case "recovery-confirm":
              result = vault.confirmRecovery(input);
              break;
            case "recovery-lost":
              result = vault.markRecoveryLost();
              break;
            case "recover":
              result = vault.recover(input);
              break;
            case "encryption":
              result = vault.setBackupEncryption(input.enabled);
              break;
            case "secret-set":
              result = { secrets: vault.setSecret(input), ...vault.status() };
              break;
            case "secret-delete":
              result = {
                secrets: vault.removeSecret(input.id),
                ...vault.status(),
              };
              break;
            default:
              throw Error("저장소 작업을 확인하세요.");
          }
          diagnostics.log("info", "vault." + input.operation);
          return send(res, 200, result);
        }
        if (u.pathname === "/api/device/settings") {
          const d = device(req);
          if (!d)
            return send(res, 403, { error: "페어링된 기기에서 사용하세요." });
          if (req.method === "PUT") {
            const input = await body(req);
            if (
              Object.keys(input).some(
                (k) => !["name", "settings", "model", "appVersion"].includes(k),
              )
            )
              throw Error("지원하지 않는 기기 필드입니다.");
            const metadata = {};
            if (input.model !== undefined && typeof input.model === "string")
              metadata.model = input.model.slice(0, 80);
            if (
              input.appVersion !== undefined &&
              /^\d+\.\d+\.\d+$/.test(input.appVersion)
            )
              metadata.appVersion = input.appVersion;
            updateDevice(d, input, metadata);
            focusSessions.delete(d.id);
          } else if (req.method !== "GET")
            return send(res, 405, { error: "지원하지 않는 메서드입니다." });
          return send(res, 200, devicePayload(d));
        }
        if (
          req.method === "GET" &&
          ["/api/admin/update", "/api/device/update"].includes(u.pathname)
        )
          return send(res, 200, await releaseInfo());
        if (
          req.method === "POST" &&
          u.pathname === "/api/admin/devices/screensaver"
        ) {
          const b = await body(req),
            d = devices.find((d) => d.id === b.id);
          if (!d) throw Error("기기를 찾을 수 없습니다.");
          d.screenSaverAt = Date.now();
          broadcast();
          return send(res, 200, { ok: true });
        }
        if (req.method === "PUT" && u.pathname === "/api/admin/devices") {
          const input = await body(req);
          const updated = updateDevice(
            devices.find((d) => d.id === input.id),
            input,
          );
          focusSessions.delete(input.id);
          return send(res, 200, {
            device: updated,
          });
        }
        if (req.method === "POST" && u.pathname === "/api/admin/focus") {
          const { bundleId } = await body(req);
          const p = config.profiles.find((p) =>
            p.focusApps?.includes(bundleId),
          );
          let changed = false;
          for (const d of devices) {
            if (p) {
              if (!focusSessions.has(d.id))
                focusSessions.set(d.id, {
                  profileId: d.settings?.profileId || "",
                  startPageId: d.settings?.startPageId || "",
                  active: p.id,
                });
              else focusSessions.get(d.id).active = p.id;
              if (d.settings?.profileId !== p.id) {
                updateDevice(d, {
                  settings: { profileId: p.id, startPageId: "" },
                });
                changed = true;
              }
            } else if (focusSessions.has(d.id)) {
              const before = focusSessions.get(d.id);
              focusSessions.delete(d.id);
              if (d.settings?.profileId === before.active) {
                const original = config.profiles.some(
                  (p) => p.id === before.profileId,
                )
                  ? before.profileId
                  : "";
                const originalPage = profileFor(config, {
                  settings: { profileId: original },
                })?.pageIds.includes(before.startPageId)
                  ? before.startPageId
                  : "";
                updateDevice(d, {
                  settings: { profileId: original, startPageId: originalPage },
                });
                changed = true;
              }
            }
          }
          return send(res, 200, { changed });
        }
        if (req.method === "GET" && u.pathname === "/api/admin/settings")
          return send(res, 200, {
            settings,
            version: APP_VERSION,
            buildInfo: buildInfo(),
            network: network(),
            diagnostics: diagnosis(),
            nativeStatus: nativeStatus(dir),
          });
        if (req.method === "PUT" && u.pathname === "/api/admin/settings") {
          const input = await body(req),
            next = mergeSettings(settings, input.settings || input);
          const old = settings;
          if (JSON.stringify(next.network) !== JSON.stringify(old.network))
            await configureNetwork(next.network);
          settings = next;
          try {
            writeJson(path.join(dir, "preferences.json"), settings);
          } catch (e) {
            settings = old;
            await configureNetwork(old.network);
            throw e;
          }
          diagnostics.log("info", "settings.saved");
          return send(res, 200, {
            settings,
            network: network(),
            nativeStatus: nativeStatus(dir),
          });
        }
        if (
          req.method === "POST" &&
          u.pathname === "/api/admin/update/prepare"
        ) {
          const backup = settings.backups.beforeUpdate
            ? backups.create("before-update")
            : null;
          diagnostics.log("info", "update.prepared", { count: backup ? 1 : 0 });
          return send(res, 200, { ok: true, backup });
        }
        if (req.method === "GET" && u.pathname === "/api/admin/licenses")
          return send(res, 200, licenseNotices());
        if (req.method === "GET" && u.pathname === "/api/admin/certificate")
          return send(res, 200, certificateInfo(dir));
        if (
          req.method === "GET" &&
          u.pathname === "/api/admin/certificate/authority"
        )
          return send(res, 200, exportAuthority(dir));
        if (req.method === "POST" && u.pathname === "/api/admin/certificate") {
          const b = await body(req);
          if (
            b.operation === "issue-local-ca" ||
            b.operation === "regenerate-authority"
          )
            issueLocalCertificate(dir, {
              rotateAuthority: b.operation === "regenerate-authority",
            });
          else installCertificate(dir, b.certificatePem, b.privateKeyPem);
          identity = loadIdentity(dir);
          networkListeners.updateIdentity();
          diagnostics.log("info", "certificate.updated");
          for (const stream of streams)
            if (stream.socket?.encrypted) stream.end();
          return send(res, 200, certificateInfo(dir));
        }
        if (req.method === "GET" && u.pathname === "/api/admin/usb")
          return send(res, 200, {
            ...(await adbStatus(settings)),
            autoUpdate: companionUpdater.status(),
          });
        if (req.method === "POST" && u.pathname === "/api/admin/usb") {
          const input = await body(req);
          if (input.operation === "download") {
            const installed = await downloadPlatformTools(dir);
            settings = mergeSettings(settings, {
              usb: { executablePath: installed.executablePath },
            });
            writeJson(path.join(dir, "preferences.json"), settings);
            diagnostics.log("info", "usb.tools.installed");
            return send(res, 200, installed);
          }
          return send(res, 200, await adbOperation(settings, input));
        }
        if (req.method === "POST" && u.pathname === "/api/admin/migration") {
          const input = await body(req);
          const result = await migration.run(input);
          diagnostics.log("info", "migration." + input.operation);
          return send(res, 200, result);
        }
        if (req.method === "POST" && u.pathname === "/api/admin/companion")
          return send(
            res,
            200,
            await installCompanion(settings, (await body(req)).serial),
          );
        if (req.method === "GET" && u.pathname === "/api/admin/diagnostics")
          return send(res, 200, diagnosis());
        if (req.method === "GET" && u.pathname === "/api/admin/backups")
          return send(res, 200, { backups: backups.list() });
        if (req.method === "POST" && u.pathname === "/api/admin/backups") {
          const b = await body(req);
          let result;
          switch (b.operation) {
            case "create":
              result = {
                backup: backups.create("manual", { profileIds: b.profileIds }),
              };
              break;
            case "preview":
              result = { preview: backups.preview(b.id) };
              break;
            case "restore": {
              const previousNetwork = settings.network;
              const archive = backups.export(b.id);
              const restoringPreferences =
                b.restorePreferences === true ||
                (b.restorePreferences !== false && !b.profileIds?.length);
              if (restoringPreferences && archive.preferences)
                await configureNetwork(
                  mergeSettings(settings, archive.preferences).network,
                );
              try {
                result = {
                  ...backups.restore(b.id, {
                    profileIds: b.profileIds,
                    restoreState: b.restoreState,
                    restorePreferences: b.restorePreferences,
                  }),
                  config,
                };
              } catch (e) {
                await configureNetwork(previousNetwork);
                throw e;
              }
              break;
            }
            case "delete":
              backups.remove(b.id);
              result = { ok: true };
              break;
            case "export":
              result = {
                archive: backups.export(b.id, b.password, {
                  profileIds: b.profileIds,
                  recoveryProtected: b.recoveryProtected,
                }),
              };
              break;
            case "encrypt-existing":
              result = backups.encryptExisting();
              break;
            case "import":
              result = { backup: backups.import(b.archive, b.password) };
              break;
            default:
              throw Error("백업 작업을 확인하세요.");
          }
          diagnostics.log("info", "backup." + b.operation);
          return send(res, 200, result);
        }
        if (req.method === "GET" && u.pathname === "/api/admin/info")
          return send(res, 200, {
            pin,
            pinExpires,
            devices: adminDevices(),
            config,
            network: network(),
            recovery: { ...recovery },
            connections: [...streams].map((s) => ({
              transport: s.openDeckTransport,
              address: s.socket?.remoteAddress,
            })),
          });
        if (req.method === "POST" && u.pathname === "/api/admin/resume") {
          resumeConnections();
          return send(res, 200, { ok: true });
        }
        if (req.method === "POST" && u.pathname === "/api/admin/pin") {
          pin = String(crypto.randomInt(100000, 1000000));
          pinExpires = Date.now() + 600000;
          return send(res, 200, { pin, pinExpires });
        }
        if (req.method === "POST" && u.pathname === "/api/admin/revoke") {
          const b = await body(req);
          devices = devices.filter((d) => d.id !== b.id);
          diagnostics.log("info", "device.revoked", { count: devices.length });
          writeJson(devicesFile, devices);
          for (const s of streams) s.end();
          streams.clear();
          return send(res, 200, { ok: true });
        }
        if (req.method === "PUT" && u.pathname === "/api/admin/config") {
          const candidate = validateConfig(await body(req));
          applyConfig(candidate);
          diagnostics.log("info", "deck.saved", { revision: configRevision });
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
          const b = await body(req);
          if (
            !b ||
            typeof b !== "object" ||
            Array.isArray(b) ||
            Object.keys(b).some(
              (k) => !["widgetId", "operation"].includes(k),
            ) ||
            typeof b.widgetId !== "string" ||
            (b.operation !== undefined &&
              !["trigger", "recover"].includes(b.operation))
          )
            throw Error("알림 테스트 작업을 확인하세요.");
          const w = engine.widget(b.widgetId),
            page = config.pages.find((p) =>
              p.widgets.some((w) => w.id === b.widgetId),
            );
          if (!w || !["grafana", "system"].includes(w.type))
            throw Error("모니터 위젯을 선택하세요.");
          const incident = engine.monitorAlerts.testNotification(
            page,
            w,
            b.operation || "trigger",
          );
          broadcast();
          return send(res, 200, {
            ok: true,
            incident,
            inbox: engine.monitorAlerts.inbox(config),
          });
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
        if (
          req.method === "POST" &&
          /^\/api\/monitor\/incidents\/incident-[a-f0-9]{32}$/.test(u.pathname)
        ) {
          const input = await body(req),
            paired = device(req);
          // Body streaming can outlive a pairing/session revocation. Never turn a lost device into admin scope.
          if (!admin && !paired)
            return send(res, 401, { error: "태블릿 연결이 필요합니다." });
          if (
            admin &&
            !account.authenticate(sessionToken(req), { touch: false })
          )
            return send(res, 401, {
              error: "관리자 로그인이 필요합니다.",
              code: "ACCOUNT_LOGIN_REQUIRED",
            });
          if (admin && editorLock.status().locked)
            return send(res, 423, {
              error: "편집기가 잠겨 있습니다. 비밀번호로 잠금을 해제하세요.",
            });
          engine.state();
          const result = engine.monitorAlerts.act(
            config,
            u.pathname.split("/").pop(),
            input,
            admin ? null : monitorScope(paired),
          );
          diagnostics.log("info", "monitor.incident.action");
          broadcast();
          return send(res, 200, result);
        }
        if (req.method === "GET" && u.pathname === "/api/snapshot")
          return send(res, 200, snapshot(device(req), admin));
        if (req.method === "GET" && u.pathname === "/api/events") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
            Connection: "keep-alive",
          });
          res.write(": connected\n\n");
          const d = device(req);
          if (d) {
            d.lastSeenAt = new Date().toISOString();
            res.openDeckDeviceId = d.id;
          } else res.openDeckSession = sessionToken(req);
          res.openDeckTransport = lan ? "wifi" : "usb";
          streams.add(res);
          diagnostics.log("debug", "stream.connected", {
            transport: lan ? "wifi" : "usb",
          });
          broadcast();
          req.on("close", () => {
            streams.delete(res);
            broadcast();
          });
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
          if (
            !allowedWidget(device(req), input.widgetId) ||
            !w ||
            w.provider !== "jimin-os"
          )
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
          if (!allowedWidget(device(req), b.id))
            throw Error("현재 프로필의 버튼이 아닙니다.");
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
          ([
            "/",
            "/app.js",
            "/app.css",
            "/layout.mjs",
            "/monitor-layout.mjs",
            "/monitor-rules.mjs",
            "/monitor-inbox.mjs",
            "/monitor-inbox.css",
            "/settings-ui.mjs",
            "/device-drafts.mjs",
            "/editor-lock.mjs",
            "/profile-tools.mjs",
            "/profiles.mjs",
            "/security-ui.mjs",
            "/downloads.mjs",
            "/migration-ui.mjs",
            "/i18n.mjs",
          ].includes(u.pathname) ||
            /^\/locales\/(ar|pt-BR|cs|nl|en|fr|de|hi|id|it|ja|ko|pl|ru|zh|es|zh-TW|tr|uk)\.json$/.test(
              u.pathname,
            ))
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
              : file.endsWith(".json")
                ? "application/json"
                : file.endsWith(".css")
                  ? "text/css"
                  : "text/html",
          );
          res.end(fs.readFileSync(path.join(publicDir, file)));
          return;
        }
        send(res, 404, { error: "찾을 수 없습니다." });
      } catch (e) {
        diagnostics.log("warn", "request.failed", { status: e.status || 400 });
        if (!res.headersSent)
          send(res, e.status || 400, {
            error: e.message,
            ...(e.code && /^[A-Z_]{1,50}$/.test(e.code)
              ? { code: e.code }
              : {}),
          });
        else res.end();
      }
    };
  const server = http.createServer(handler());
  const advertise = (enabled) => {
    discoveryProcess?.kill();
    discoveryProcess = null;
    const listener = networkListeners?.primary;
    if (enabled && process.platform === "darwin" && listener?.listening) {
      discoveryProcess = spawn(
        "/usr/bin/dns-sd",
        [
          "-R",
          "Open Deck",
          "_opendeck._tcp",
          "local",
          String(listener.address().port),
          "protocol=1",
          networkListeners.tls ? "tls=1" : "tls=0",
        ],
        { stdio: "ignore" },
      );
      discoveryProcess.on("error", () =>
        diagnostics.log("warn", "discovery.failed"),
      );
    }
  };
  networkListeners = new NetworkListeners({
    handler: handler(true),
    identity: () => (identity = loadIdentity(dir)),
    onChange: () => {
      configRevision++;
      broadcast();
    },
    onError: (e) => {
      wifiError = e.code || "listen_failed";
      diagnostics.log("error", "network.failed");
    },
  });
  let firstNetworkConfiguration = true;
  const configureNetwork = async (value) => {
    if (!wifi) return;
    const firstPort =
      firstNetworkConfiguration && wifiPort !== 8841 ? wifiPort : undefined;
    firstNetworkConfiguration = false;
    await networkListeners.configure(value, firstPort);
    wifiError = "";
    advertise(value.wifiEnabled && value.discoveryEnabled);
  };
  if (wifi)
    configureNetwork(settings.network).catch((e) => {
      wifiError = e.code || e.message;
      diagnostics.log("error", "network.failed");
    });
  const backupTimer = metrics
    ? setInterval(() => {
        try {
          backups.tick();
        } catch {
          diagnostics.log("error", "backup.failed");
        }
      }, 60000)
    : null;

  const companionTimer = metrics
    ? setInterval(
        () =>
          companionUpdater
            .tick()
            .catch(() => diagnostics.log("warn", "companion.update.failed")),
        60000,
      )
    : null;
  let lastTick = Date.now();
  const interval = metrics
    ? setInterval(() => {
        const now = Date.now();
        if (now - lastTick > 10000) resumeConnections();
        lastTick = now;
        engine.metrics();
      }, 1000)
    : null;
  const scheduler = new Scheduler(
    () => config,
    (id) => engine.run(id),
  );
  const schedule = metrics ? setInterval(() => scheduler.tick(), 1000) : null;
  server.on("close", () => {
    clearInterval(interval);
    clearInterval(backupTimer);
    clearInterval(companionTimer);
    void companionUpdater.close();
    discoveryProcess?.kill();
    clearInterval(schedule);
    connectors.close();
    extensions.close();
    engine.systemMonitor?.close();
    grafana.close();
    plugins.close();
    vault.lock();
    engine.monitorAlerts.close();
    for (const s of streams) s.end();
  });
  return {
    server,
    get lanServer() {
      return networkListeners.primary;
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
        const listeners = [server];
        Promise.all([
          companionUpdater.close(),
          networkListeners.close(),
          ...listeners.map(
            (s) =>
              new Promise((done) => {
                s.close(done);
                s.closeAllConnections();
              }),
          ),
        ]).then(resolve);
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
