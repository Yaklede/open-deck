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
function series(result, scale, now, strictLatest = false) {
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
      const validTime = (at) =>
        finite(at) && at <= now + 60000 && at >= now - 3600000;
      const latestAt = strictLatest
        ? (values[timeIndex] || []).reduce((latest, at) => validTime(at) ? Math.max(latest, at) : latest, -Infinity)
        : null;
      const points = values[i]
        .map((value, n) => [values[timeIndex]?.[n], value])
        .filter(
          ([at, v]) =>
            finite(at) && at <= now + 60000 && at >= now - 3600000 && finite(v),
        )
        .map(([at, v]) => [at, v * scale])
        .filter(([, v]) => !strictLatest || finite(v))
        .sort((a, b) => a[0] - b[0])
        .slice(-60);
      if (strictLatest) {
        if (!finite(latestAt) || now - latestAt >= 300000) continue;
      } else if (!points.length || now - points.at(-1)[0] > 300000) continue;
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
        value: strictLatest && points.at(-1)?.[0] !== latestAt
          ? null : points.at(-1)?.[1] ?? null,
        job: String(labels.job || "").slice(0, 80),
        at: strictLatest ? latestAt : points.at(-1)[0],
        points,
      });
    }
  }
  return rows;
}
// Evaluation timestamps from rate/aggregate queries are not source scrape times.
export function sourceTimestampQuery(query, refId) {
  if (query.datasource?.type !== "prometheus" || typeof query.expr !== "string")
    return null;
  const selectors = [
    ...query.expr.matchAll(/([a-zA-Z_:][a-zA-Z0-9_:]*\{(?:[^"{}]|"(?:\\.|[^"\\])*")*\})/g),
  ].map((m) => m[1]);
  const unique = [...new Set(selectors)];
  if (!unique.length || unique.length > 8) return null;
  const times = unique.map((selector) => `min(timestamp(${selector}))`);
  // Distinct synthetic labels prevent `or` from dropping one aggregate. The
  // intersection requires every input to exist: one missing counter must not
  // make the other counter's scrape time look like a complete ratio sample.
  const expr = times.length === 1 ? times[0]
    : `min(${times.map((value, index) =>
      `label_replace(${value}, "__open_deck_source", "${index}", "__name__", ".*")`,
    ).join(" or ")}) and on() (${times.join(" and on() ")})`;
  return {
    ...query,
    expr,
    refId,
    range: false,
    instant: true,
    maxDataPoints: 1,
  };
}
export function freshnessStatus(sampleAt, now, warnAfterMs, staleAfterMs) {
  if (!finite(sampleAt) || sampleAt === 0 || sampleAt > now + 60000)
    return "missing";
  const age = Math.max(0, now - sampleAt);
  return age >= staleAfterMs
    ? "stale"
    : age >= warnAfterMs
      ? "delayed"
      : "fresh";
}

// These deliberately recognize a bounded set of panel expressions. Panel
// titles are presentation text, not evidence of a percentile or error rate.
const compactExpr = (expr) => typeof expr === "string" && expr.length <= 20000
  ? expr.replace(/"(?:\\.|[^"\\])*"|\s+/g, (part) => part.startsWith('"') ? part : "")
  : "";
function splitExpression(expr, operator) {
  let depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if ("({[".includes(c)) depth++;
    else if (")}]".includes(c)) depth--;
    else if (depth === 0 && c === operator) return [expr.slice(0, i), expr.slice(i + 1)];
  }
  return null;
}
function unwrapExpression(expr) {
  while (expr.startsWith("(") && expr.endsWith(")")) {
    let depth = 0, quoted = false, escaped = false, outer = true;
    for (let i = 0; i < expr.length - 1; i++) {
      const c = expr[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === "(") depth++;
      else if (c === ")" && --depth === 0) { outer = false; break; }
    }
    if (!outer) break;
    expr = expr.slice(1, -1);
  }
  return expr;
}
function labelMatchers(text) {
  const labels = [];
  let rest = text.slice(1, -1);
  while (rest) {
    const match = rest.match(/^([a-zA-Z_][a-zA-Z0-9_]*)(=~|!~|!=|=)("(?:\\.|[^"\\])*")(,|$)/);
    if (!match || labels.some(([key]) => key === match[1])) return null;
    let value;
    try { value = JSON.parse(match[3]); } catch { return null; }
    labels.push([match[1], match[2], value]);
    rest = rest.slice(match[0].length);
  }
  return labels.sort((a, b) => a[0].localeCompare(b[0]));
}
function counterRate(expr) {
  const match = unwrapExpression(compactExpr(expr)).match(
    /^sum(?:by\((job)\))?\((rate|irate)\(([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(?:[^"{}]|"(?:\\.|[^"\\])*")*\})\[((?:[0-9]+(?:ms|s|m|h|d|w|y))+)\]\)\)$/,
  );
  if (!match) return null;
  const labels = labelMatchers(match[4]);
  if (!labels) return null;
  return { group: match[1] || "", fn: match[2], metric: match[3], labels, window: match[5] };
}
function sameRate(a, b, { metric = true, labels = true } = {}) {
  return !!a && !!b && a.group === b.group && a.fn === b.fn && a.window === b.window
    && (!metric || a.metric === b.metric)
    && (!labels || JSON.stringify(a.labels) === JSON.stringify(b.labels));
}
function fiveXxRate(numerator, denominator) {
  if (!sameRate(numerator, denominator, { labels: false })) return false;
  const status = numerator.labels.filter(([key]) => key === "status");
  return status.length === 1 && status[0][1] === "=~"
    && ["5..", "5[0-9][0-9]", "5[0-9]{2}"].includes(status[0][2])
    && JSON.stringify(numerator.labels.filter(([key]) => key !== "status")) === JSON.stringify(denominator.labels);
}
function quotient(expr) {
  let text = unwrapExpression(compactExpr(expr)), multiplier = 1;
  const multiplication = splitExpression(text, "*");
  if (multiplication) {
    if (multiplication[0] === "100") text = unwrapExpression(multiplication[1]);
    else if (multiplication[1] === "100") text = unwrapExpression(multiplication[0]);
    else return null;
    multiplier = 100;
  }
  const parts = splitExpression(text, "/");
  if (!parts) return null;
  const numerator = counterRate(parts[0]), denominator = counterRate(parts[1]);
  return numerator && denominator ? { numerator, denominator, multiplier } : null;
}
function servicePanel(panel) {
  if (!Array.isArray(panel?.targets)) return null;
  const targets = panel.targets.filter((target) => target && !target.hide);
  const unit = panel?.fieldConfig?.defaults?.unit;
  const overrides = panel?.fieldConfig?.overrides || [];
  if (targets.length !== 1 || typeof targets[0].expr !== "string"
    || !Array.isArray(overrides) || overrides.some((override) =>
      !Array.isArray(override?.properties) || override.properties.some((property) =>
        property?.id === "unit" && property.value !== unit))) return null;
  const target = targets[0], datasource = target.datasource || panel.datasource;
  if (datasource?.type !== "prometheus" || !datasource.uid) return null;
  return { panel, target, datasource, unit, expr: target.expr };
}
const sameDatasource = (a, b) => !!a && !!b && a.datasource.uid === b.datasource.uid
  && a.datasource.type === b.datasource.type;
const millisecondsScale = (unit) => ({ s: 1000, ms: 1, "µs": .001, ns: .000001 })[unit];

export function grafanaServicePlan(panels, widget = {}) {
  const find = (key, fallback) => {
    const id = widget[key] ?? fallback;
    return id === 0 ? null : servicePanel(panels.find((panel) => panel.id === id));
  };
  const rps = find("rpsPanelId", 11), latency = find("latencyPanelId", 12),
    errorRate = find("errorRatePanelId", 13);
  const metrics = {}, selected = [];
  const rate = rps?.unit === "reqps" ? counterRate(rps.expr) : null;
  if (rate && /(?:_count|_total)$/.test(rate.metric)) {
    metrics.rps = { ref: "L", sourceRefs: ["TL"], mode: "sum", scale: 1 };
    selected.push([rps.panel, "L", rps.target]);
  }
  const durationScale = millisecondsScale(latency?.unit);
  if (latency && durationScale) {
    const mean = quotient(latency.expr);
    const p95 = compactExpr(latency.expr).match(
      /^histogram_quantile\(0\.95,sumby\((?:le|job,le|le,job)\)\((?:rate|irate)\([a-zA-Z_:][a-zA-Z0-9_:]*_bucket\{(?:[^"{}]|"(?:\\.|[^"\\])*")*\}\[(?:[0-9]+(?:ms|s|m|h|d|w|y))+\]\)\)\)$/,
    );
    if (p95) {
      metrics.latency = { ref: "J", sourceRefs: ["TJ"], mode: "single", scale: durationScale, aggregation: "p95" };
    } else if (metrics.rps && mean?.multiplier === 1 && sameDatasource(latency, rps)
      && sameRate(mean.denominator, rate) && sameRate(mean.numerator, rate, { metric: false })
      && rate.metric.endsWith("_count") && mean.numerator.metric === rate.metric.replace(/_count$/, "_sum")) {
      metrics.latency = { ref: "J", sourceRefs: ["TJ", "TL"], mode: "weighted", scale: durationScale, aggregation: "mean" };
    }
    if (metrics.latency) selected.push([latency.panel, "J", latency.target]);
  }
  if (errorRate && metrics.rps && sameDatasource(errorRate, rps)) {
    const fraction = quotient(errorRate.expr);
    if (errorRate.unit === "reqps" && fiveXxRate(counterRate(errorRate.expr), rate)) {
      metrics.errorRate = { ref: "K", sourceRefs: ["TK", "TL"], mode: "ratio", scale: 1 };
    } else if (fraction && sameRate(fraction.denominator, rate) && fiveXxRate(fraction.numerator, rate)
      && ((errorRate.unit === "percentunit" && fraction.multiplier === 1)
        || (errorRate.unit === "percent" && fraction.multiplier === 100))) {
      metrics.errorRate = { ref: "K", sourceRefs: ["TK", "TL"], mode: "weighted", scale: errorRate.unit === "percentunit" ? 100 : 1 };
    }
    if (metrics.errorRate) selected.push([errorRate.panel, "K", errorRate.target]);
  }
  return { metrics, selected };
}

function parseServiceMetrics(data, now, plan) {
  const service = {}, freshness = {};
  const read = (ref, scale = 1) => {
    const result = data.results?.[ref];
    try {
      if (!Array.isArray(result?.frames) || result.frames.length > 64
        || result.frames.reduce((count, frame) => count + (frame.schema?.fields || []).filter((field) => field.type === "number").length, 0) > 64) return [];
      return series(result, scale, now, true);
    } catch { return []; }
  };
  const rates = plan.rps ? read(plan.rps.ref) : [];
  const rowsByKey = (rows) => {
    const map = new Map();
    for (const row of rows) {
      const key = row.job || (rows.length === 1 ? "__aggregate" : "");
      if (!key || map.has(key)) return null;
      map.set(key, new Map(row.points));
    }
    return map.size ? map : null;
  };
  for (const [key, unit] of Object.entries({ latency: "ms", errorRate: "percent", rps: "req/s" })) {
    const descriptor = plan[key], rows = descriptor ? read(descriptor.ref, descriptor.scale) : [];
    let reason = descriptor ? "missing" : "unsupported", points = [], value = null, at = null;
    const sourceTimes = descriptor?.sourceRefs.map((ref) => {
      const stamps = read(ref).map((row) => row.value * 1000)
        .filter((stamp) => finite(stamp) && stamp > 0 && stamp <= now + 60000);
      return stamps.length ? Math.min(...stamps) : null;
    }) || [];
    const sourceAt = sourceTimes.length && sourceTimes.every((stamp) => stamp !== null)
      ? Math.min(...sourceTimes) : null;
    freshness[key] = {
      sampleAt: rows.length ? sourceAt : null,
      kind: !rows.length ? "missing" : sourceAt === null ? "unavailable" : "source",
      warnAfterMs: 90000, staleAfterMs: 300000,
    };
    if (rows.length && descriptor) {
      const input = rowsByKey(rows), weights = rowsByKey(rates);
      const needsWeights = ["weighted", "ratio"].includes(descriptor.mode);
      const matching = input && (!needsWeights || (weights && input.size === weights.size && [...input.keys()].every((name) => weights.has(name))));
      if (!matching || (descriptor.mode === "single" && rows.length !== 1)) reason = "ambiguous";
      else if (sourceAt === null) reason = "source-unavailable";
      else if (now - sourceAt >= 300000) reason = "stale";
      else {
        const allRows = needsWeights ? [...rows, ...rates] : rows;
        const latestAt = Math.max(...allRows.map((row) => row.at));
        const times = [...new Set(rows.flatMap((row) => row.points.map(([time]) => time)))].sort((a, b) => a - b);
        for (const time of times) {
          let total = 0, denominator = 0, complete = true;
          for (const [name, samples] of input) {
            const sample = samples.get(time), weight = needsWeights ? weights.get(name).get(time) : 1;
            if (!finite(sample) || !finite(weight) || (key === "errorRate" && descriptor.mode === "weighted" && sample > 100)
              || (descriptor.mode === "ratio" && sample > weight)) { complete = false; break; }
            total += descriptor.mode === "weighted" ? sample * weight : sample;
            denominator += weight;
          }
          const computed = needsWeights ? (denominator > 0 ? total / denominator * (descriptor.mode === "ratio" ? 100 : 1) : null) : total;
          if (complete && finite(computed)) points.push([time, computed]);
        }
        points = points.slice(-60);
        const latest = points.find(([time]) => time === latestAt);
        if (latest) { value = latest[1]; at = latest[0]; reason = null; }
        else reason = "incomplete";
      }
    }
    service[key] = { value, points, at, unit, reason,
      ...(key === "latency" ? { aggregation: descriptor?.aggregation || null } : {}) };
  }
  return { service, freshness };
}

export function parseGrafanaMetrics(data, now = Date.now(), servicePlan = {}) {
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
  const one = (rows, name) => {
    const matches = rows.filter((row) => row.name === name);
    return matches.length === 1 ? matches[0] : null;
  };
  const nodeNames = [
    ...new Set([...cpu, ...memory, ...memoryBytes].map((row) => row.name)),
  ]
    .filter((name) => !["DB", "Value", "TPS", "QPS"].includes(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .slice(0, 64);
  const nodes = nodeNames.map((name) => ({
    name,
    cpuPercent: one(cpu, name)?.value ?? null,
    cpuPoints: one(cpu, name)?.points ?? [],
    memoryPercent: one(memory, name)?.value ?? null,
    memoryUsedBytes: usedBytes(name),
    cpuAt: one(cpu, name)?.at ?? null,
    memoryAt: one(memory, name)?.at ?? null,
  }));
  const oldest = (rows) =>
    rows.length ? Math.min(...rows.map((r) => r.at)) : null;
  const sourceTime = (key, rows, prometheus = false) => {
    if (!rows.length)
      return {
        sampleAt: null,
        kind: "missing",
        warnAfterMs: prometheus ? 90000 : 180000,
        staleAfterMs: 300000,
      };
    const timestamps = optional(key)
      .map((row) => row.value * 1000)
      .filter((at) => finite(at) && at > 0 && at <= now + 60000);
    return {
      sampleAt: prometheus
        ? timestamps.length
          ? Math.min(...timestamps)
          : null
        : oldest(rows),
      kind: prometheus
        ? timestamps.length
          ? "source"
          : "unavailable"
        : "point",
      warnAfterMs: prometheus ? 90000 : 180000,
      staleAfterMs: 300000,
    };
  };
  const freshness = {
    cpu: sourceTime(null, cpu),
    memory: sourceTime(null, memory),
    system: sourceTime("TD", system, true),
    tps: sourceTime("TB", tps, true),
    qps: sourceTime("TG", qps, true),
    connections: sourceTime("TF", connections, true),
    ready: sourceTime("TC", ready, true),
    collection: sourceTime("TE", up, true),
  };
  freshness.cpu.missingSeries = nodes.filter(
    (n) => n.cpuPercent === null,
  ).length;
  freshness.memory.missingSeries = nodes.filter(
    (n) => n.memoryPercent === null,
  ).length;
  const serviceMetrics = parseServiceMetrics(data, now, servicePlan);
  Object.assign(freshness, serviceMetrics.freshness);
  return {
    status: "ready",
    capturedAt: now,
    freshness,
    service: serviceMetrics.service,
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
      nodes,
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
    this.generation = 0;
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
            widget.latencyPanelId ?? 12,
            widget.errorRatePanelId ?? 13,
            widget.rpsPanelId ?? 11,
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
      const partialQuery = route === "/api/ds/query" && body && response.status === 400;
      if (!response.ok && !partialQuery)
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
      const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      // Grafana can use HTTP 400 for a mixed batch with valid core results.
      // Optional service errors must not discard a successful CPU/TPS query.
      if (partialQuery && !["A", "B"].every((key) => {
        const metric = result?.results?.[key];
        return metric && !metric.error && (!metric.status || metric.status < 400)
          && Array.isArray(metric.frames);
      })) throw Error("QUERY");
      return result;
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(controller);
    }
  }
  async collect(entry, generation = this.generation) {
    const { source, project, widget } = entry;
    const token = widget.auth
      ? await this.secret(grafanaSecretId(source.origin))
      : "";
    if (this.closed || generation !== this.generation) throw Error("RESUMED");
    if (widget.auth && !token) throw Error("AUTH");
    const key = JSON.stringify([source.origin, source.uid, !!widget.auth]);
    let dashboard = this.dashboards.get(key);
    if (!dashboard || this.clock() - dashboard.at > 300000) {
      const result = await this.request(
        source,
        "/api/dashboards/uid/" + source.uid,
        token,
      );
      if (generation !== this.generation) throw Error("RESUMED");
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
    const servicePlan = grafanaServicePlan(panels, widget);
    selected.push(...servicePlan.selected);
    const queries = selected.map(([panel, refId, target]) => {
      const query = JSON.parse(
        JSON.stringify(target || panel.targets[0])
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
    queries.push(
      ...queries
        .map((q) => sourceTimestampQuery(q, "T" + q.refId))
        .filter(Boolean),
    );
    if (generation !== this.generation) throw Error("RESUMED");
    const now = this.clock();
    return parseGrafanaMetrics(
      await this.request(source, "/api/ds/query", token, {
        from: String(now - 3600000),
        to: String(now),
        queries,
      }),
      now,
      servicePlan.metrics,
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
      const generation = this.generation;
      this.collect(entry, generation)
        .then((data) => {
          if (
            !this.closed &&
            generation === this.generation &&
            this.cache.get(entry.key) === record
          ) {
            for (const [key, item] of Object.entries(data.freshness || {})) {
              item.lastSampleAt =
                item.sampleAt ||
                record.data?.freshness?.[key]?.sampleAt ||
                record.data?.freshness?.[key]?.lastSampleAt ||
                null;
            }
            Object.assign(record, {
              status: "ready",
              data,
              message: undefined,
            });
          }
        })
        .catch((error) => {
          if (
            !this.closed &&
            generation === this.generation &&
            this.cache.get(entry.key) === record
          )
            Object.assign(record, {
              status: "error",
              message: message(error.message),
            });
        })
        .finally(() => {
          if (generation !== this.generation) return;
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
            : {
                ...record.data,
                status: "stale",
                message: "지표 조회가 중단됐어요 · 다시 연결 중",
              };
      else if (record?.status === "error")
        data = { ...record.data, status: "error", message: record.message };
      if (data.freshness)
        data = {
          ...data,
          freshness: Object.fromEntries(
            Object.entries(data.freshness).map(([key, item]) => [
              key,
              {
                ...item,
                status: freshnessStatus(
                  item.sampleAt || item.lastSampleAt,
                  this.clock(),
                  item.warnAfterMs,
                  item.staleAfterMs,
                ),
              },
            ]),
          ),
        };
      widgets[entry.widget.id] ??= { projects: {} };
      widgets[entry.widget.id].projects[entry.project.value] = data;
    }
    return { widgets };
  }
  resume() {
    if (this.closed) return;
    this.generation++;
    for (const controller of this.controllers) controller.abort();
    this.active = 0;
    this.dashboards.clear();
    for (const record of this.cache.values()) {
      record.running = false;
      record.next = 0;
    }
    this.tick();
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
