import crypto from "node:crypto";
import { readSecret } from "./connectors.mjs";

export function grafanaSource(widget) {
  const url = new URL(widget.url);
  const uid = url.pathname.match(/\/d\/([A-Za-z0-9_-]{1,128})(?:\/|$)/)?.[1];
  if (url.protocol !== "https:" || url.username || url.password || !uid)
    throw Error("CONFIG");
  return {
    origin: url.origin,
    uid,
    variable: widget.projectVariable || "project",
  };
}
export const grafanaSecretId = (origin) =>
  "grafana-" +
  crypto.createHash("sha256").update(origin).digest("hex").slice(0, 24);

const finite = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
function series(result, scale, now) {
  if (!result || result.error || (result.status && result.status >= 400))
    throw Error("QUERY");
  const rows = [];
  for (const frame of (result.frames || []).slice(0, 64)) {
    const fields = frame.schema?.fields || [],
      values = frame.data?.values || [];
    const timeIndex = fields.findIndex((f) => f.type === "time");
    if (timeIndex < 0) continue;
    for (let i = 0; i < fields.length; i++) {
      if (fields[i].type !== "number" || !Array.isArray(values[i])) continue;
      const points = values[i]
        .map((value, n) => [values[timeIndex]?.[n], value])
        .filter(
          ([at, v]) =>
            finite(at) && at <= now + 60000 && at >= now - 3600000 && finite(v),
        )
        .map(([at, v]) => [at, v * scale])
        .sort((a, b) => a[0] - b[0])
        .slice(-60);
      if (!points.length || now - points.at(-1)[0] > 300000) continue;
      const labels = fields[i].labels || {};
      rows.push({
        name: String(
          labels["resource.label.pod_name"] ||
            labels.pod ||
            labels.job ||
            fields[i].name ||
            "DB",
        )
          .replace(/[\x00-\x1f\x7f]/g, "")
          .slice(0, 80),
        value: points.at(-1)[1],
        job: String(labels.job || "").slice(0, 80),
        at: points.at(-1)[0],
        points,
      });
    }
  }
  return rows;
}
export function parseGrafanaMetrics(data, now = Date.now()) {
  const cpu = series(data.results?.A, 100, now),
    tps = series(data.results?.B, 1, now);
  // TPS must be the dashboard's aggregate query, never an arbitrary series sum.
  if (tps.length > 1) throw Error("TPS_SERIES");
  const history = new Map();
  for (const row of cpu)
    for (const [at, value] of row.points)
      history.set(at, Math.max(history.get(at) ?? 0, value));
  const cpuHistory = [...history].sort((a, b) => a[0] - b[0]).slice(-60);
  const optional = (key, scale = 1) =>
    data.results?.[key] &&
    !data.results[key].error &&
    (!data.results[key].status || data.results[key].status < 400)
      ? series(data.results[key], scale, now)
      : [];
  const ready = optional("C"),
    system = optional("D", 100),
    up = optional("E"),
    connections = optional("F");
  const systemHistory = new Map();
  for (const row of system)
    for (const [at, value] of row.points)
      systemHistory.set(at, Math.max(systemHistory.get(at) ?? 0, value));
  const qps = optional("G"),
    memory = optional("H", 100),
    memoryBytes = optional("I");
  const trend = (rows, mode) => {
    const points = new Map();
    for (const row of rows)
      for (const [at, value] of row.points)
        points.set(
          at,
          mode === "sum"
            ? (points.get(at) ?? 0) + value
            : Math.max(points.get(at) ?? 0, value),
        );
    return [...points].sort((a, b) => a[0] - b[0]).slice(-60);
  };
  const highestMemory = memory.reduce(
    (best, row) => (!best || row.value > best.value ? row : best),
    null,
  );
  const usedBytes = (name) => {
    const matched = memoryBytes.filter((row) => row.name === name);
    return matched.length === 1 ? matched[0].value : null;
  };
  const exporters = up.filter((row) => row.job === "mariadb-exporter");
  return {
    status: "ready",
    capturedAt: now,
    cpu: {
      value: cpu.length ? Math.max(...cpu.map((r) => r.value)) : null,
      nodes: cpu.map(({ points, ...row }) => row),
      points: cpuHistory,
    },
    tps: {
      value: tps[0]?.value ?? null,
      at: tps[0]?.at ?? null,
      points: tps[0]?.points || [],
    },
    system: {
      value: system.length ? Math.max(...system.map((r) => r.value)) : null,
      nodes: system.map(({ points, ...row }) => row),
      points: [...systemHistory].sort((a, b) => a[0] - b[0]).slice(-60),
    },
    collection: {
      healthy: up.filter((r) => r.value === 1).length,
      total: up.length,
    },
    qps: {
      value: qps.length ? qps.reduce((sum, r) => sum + r.value, 0) : null,
      nodes: qps.map(({ points, ...row }) => row),
      points: trend(qps, "sum"),
    },
    memory: {
      value: memory.length ? Math.max(...memory.map((r) => r.value)) : null,
      usedBytes: highestMemory ? usedBytes(highestMemory.name) : null,
      nodes: memory.map(({ points, ...row }) => ({
        ...row,
        usedBytes: usedBytes(row.name),
      })),
      points: trend(memory, "max"),
    },
    database: {
      ready: ready.length
        ? ready[0].value === 1 && !exporters.some((r) => r.value < 1)
        : null,
      reporters: exporters.length,
      healthyReporters: exporters.filter((r) => r.value === 1).length,
      connections: connections.length
        ? connections.reduce((sum, r) => sum + r.value, 0)
        : null,
    },
  };
}
const message = (code) =>
  ({
    AUTH: "맥에서 Grafana 조회 토큰을 확인해 주세요",
    CONFIG: "맥에서 Grafana 대시보드 주소를 확인해 주세요",
    QUERY: "Grafana 지표 조회를 확인해 주세요",
    TPS_SERIES: "TPS 합계 쿼리를 확인해 주세요",
  })[code] || "Grafana 연결을 확인해 주세요";

export class GrafanaMonitor {
  constructor(
    getConfig,
    onChange,
    {
      fetcher = fetch,
      secret = readSecret,
      clock = Date.now,
      interval = 30000,
    } = {},
  ) {
    this.getConfig = getConfig;
    this.onChange = onChange;
    this.fetcher = fetcher;
    this.secret = secret;
    this.clock = clock;
    this.interval = interval;
    this.cache = new Map();
    this.dashboards = new Map();
    this.controllers = new Set();
    this.active = 0;
    this.closed = false;
  }
  entries() {
    const entries = [];
    for (const widget of this.getConfig()
      .pages.flatMap((p) => p.widgets)
      .filter((w) => w.type === "grafana" && w.url)) {
      for (const project of widget.projects || []) {
        try {
          const source = grafanaSource(widget);
          const key = JSON.stringify([
            source,
            !!widget.auth,
            project.value,
            widget.cpuPanelId || 1,
            widget.tpsPanelId || 2,
          ]);
          entries.push({ widget, project, source, key });
        } catch {}
      }
    }
    return entries;
  }
  async request(source, route, token, body) {
    const controller = new AbortController();
    this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 12000);
    timeout.unref?.();
    try {
      const response = await this.fetcher(source.origin + route, {
        method: body ? "POST" : "GET",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          ...(token ? { Authorization: "Bearer " + token } : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!response.ok)
        throw Error([401, 403].includes(response.status) ? "AUTH" : "HTTP");
      let size = 0;
      const chunks = [];
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 2097152) {
          controller.abort();
          throw Error("SIZE");
        }
        chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(controller);
    }
  }
  async collect(entry) {
    const { source, project, widget } = entry;
    const token = widget.auth
      ? await this.secret(grafanaSecretId(source.origin))
      : "";
    if (widget.auth && !token) throw Error("AUTH");
    const key = JSON.stringify([source.origin, source.uid, !!widget.auth]);
    let dashboard = this.dashboards.get(key);
    if (!dashboard || this.clock() - dashboard.at > 300000) {
      const result = await this.request(
        source,
        "/api/dashboards/uid/" + source.uid,
        token,
      );
      dashboard = { at: this.clock(), value: result.dashboard };
      this.dashboards.set(key, dashboard);
    }
    const panels = dashboard.value?.panels || [];
    const cpu = panels.find((p) => p.id === (widget.cpuPanelId || 1));
    const tps = panels.find((p) => p.id === (widget.tpsPanelId || 2));
    if (
      !cpu?.targets?.[0] ||
      cpu.fieldConfig?.defaults?.unit !== "percentunit" ||
      !tps?.targets?.[0]
    )
      throw Error("CONFIG");
    const selected = [
      [cpu, "A"],
      [tps, "B"],
      ...[3, 14, 15, 7, 8, 6, 16]
        .map((id, i) => [
          panels.find((p) => p.id === id),
          ["C", "D", "E", "F", "G", "H", "I"][i],
        ])
        .filter(([p]) => p?.targets?.[0]),
    ];
    const queries = selected.map(([panel, refId]) => {
      const query = JSON.parse(
        JSON.stringify(panel.targets[0])
          .replaceAll("${" + source.variable + "}", project.value)
          .replace(
            new RegExp("\\$" + source.variable + "\\b", "g"),
            project.value,
          ),
      );
      return {
        ...query,
        datasource: query.datasource || panel.datasource,
        refId,
        intervalMs: 60000,
        maxDataPoints: 60,
        range: true,
        instant: false,
      };
    });
    if (queries.some((q) => !q.datasource?.uid)) throw Error("CONFIG");
    const now = this.clock();
    return parseGrafanaMetrics(
      await this.request(source, "/api/ds/query", token, {
        from: String(now - 3600000),
        to: String(now),
        queries,
      }),
      now,
    );
  }
  tick() {
    if (this.closed) return;
    const entries = this.entries(),
      wanted = new Set(entries.map((e) => e.key));
    for (const key of this.cache.keys())
      if (!wanted.has(key)) this.cache.delete(key);
    for (const entry of entries) {
      const old = this.cache.get(entry.key);
      if (this.active >= 2 || old?.running || (old && this.clock() < old.next))
        continue;
      const record = {
        ...old,
        running: true,
        next: this.clock() + this.interval,
        status: old?.status || "loading",
      };
      this.cache.set(entry.key, record);
      this.active++;
      this.collect(entry)
        .then((data) => {
          if (!this.closed && this.cache.get(entry.key) === record)
            Object.assign(record, {
              status: "ready",
              data,
              message: undefined,
            });
        })
        .catch((error) => {
          if (!this.closed && this.cache.get(entry.key) === record)
            Object.assign(record, {
              status: "error",
              message: message(error.message),
              data: undefined,
            });
        })
        .finally(() => {
          record.running = false;
          this.active--;
          if (!this.closed) this.onChange();
        });
    }
  }
  state() {
    const widgets = {};
    for (const entry of this.entries()) {
      const record = this.cache.get(entry.key);
      let data = { status: "loading" };
      if (record?.status === "ready")
        data =
          this.clock() - record.data.capturedAt < 90000
            ? record.data
            : { status: "stale", message: "지표 갱신이 지연되고 있어요" };
      else if (record?.status === "error")
        data = { status: "error", message: record.message };
      widgets[entry.widget.id] ??= { projects: {} };
      widgets[entry.widget.id].projects[entry.project.value] = data;
    }
    return { widgets };
  }
  refresh() {
    this.dashboards.clear();
    for (const r of this.cache.values()) r.next = 0;
    this.tick();
  }
  close() {
    this.closed = true;
    for (const c of this.controllers) c.abort();
  }
}
