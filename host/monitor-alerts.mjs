import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  monitorSettings,
  monitorLevel,
  monitorRuleNames,
} from "./public/monitor-rules.mjs";
const number = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const rank = { unknown: -1, normal: 0, warning: 1, critical: 2 };
const DAY = 86400000,
  MAX_INCIDENTS = 100,
  MAX_TIMELINE = 40,
  MAX_CONDITIONS = 32,
  MAX_STORE_BYTES = 4 * 1024 * 1024;
const clean = (value, max = 160) =>
  String(value ?? "")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .slice(0, max);
const stamp = (v) => (Number.isFinite(v) && v >= 0 ? v : null);
const conditionKey = (c) => `${c.widgetId}:${c.key}`;
const signature = (conditions) =>
  conditions
    .map((c) => `${conditionKey(c)}:${c.level}`)
    .sort()
    .join(",");
const severity = (conditions) =>
  conditions.reduce(
    (best, c) => (rank[c.level] > rank[best] ? c.level : best),
    "normal",
  );
function groupId(widget, project, synthetic = false) {
  let source = widget.type === "system" ? "local-mac" : `widget:${widget.id}`;
  try {
    const url = new URL(widget.url);
    const uid = url.pathname.match(/\/d\/([A-Za-z0-9_-]{1,128})(?:\/|$)/)?.[1];
    if (url.protocol === "https:" && !url.username && !url.password && uid)
      source = [url.origin, uid, widget.projectVariable || "project"].join("|");
  } catch {}
  return (
    "incident-" +
    crypto
      .createHash("sha256")
      .update(JSON.stringify([source, project, synthetic]))
      .digest("hex")
      .slice(0, 32)
  );
}
const plain = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const publicIncident = (record) =>
  Object.fromEntries(
    Object.entries(record).filter(([key]) => !key.startsWith("_")),
  );
function safeCondition(c) {
  if (
    !plain(c) ||
    !["warning", "critical"].includes(c.level) ||
    typeof c.key !== "string" ||
    typeof c.widgetId !== "string"
  )
    return null;
  return {
    key: clean(c.key, 40),
    label: clean(c.label),
    level: c.level,
    value: typeof c.value === "boolean" ? c.value : number(c.value),
    widgetId: clean(c.widgetId, 128),
  };
}
function safeRecord(r) {
  if (
    !plain(r) ||
    !/^incident-[a-f0-9]{32}$/.test(r.id) ||
    !["active", "resolved"].includes(r.status)
  )
    return null;
  const conditions = (Array.isArray(r.conditions) ? r.conditions : [])
    .slice(0, MAX_CONDITIONS)
    .map(safeCondition)
    .filter(Boolean);
  const timeline = (Array.isArray(r.timeline) ? r.timeline : [])
    .slice(-MAX_TIMELINE)
    .flatMap((event) => {
      if (
        !plain(event) ||
        !["occurrence", "acknowledge", "snooze", "resume", "recovery"].includes(
          event.type,
        ) ||
        stamp(event.at) === null
      )
        return [];
      return [
        {
          type: event.type,
          at: event.at,
          ...(stamp(event.until) !== null ? { until: event.until } : {}),
          ...(["warning", "critical", "normal"].includes(event.severity)
            ? { severity: event.severity }
            : {}),
        },
      ];
    });
  return {
    id: r.id,
    project: clean(r.project, 128),
    label: clean(r.label),
    title: clean(r.title),
    severity: ["warning", "critical"].includes(r.severity)
      ? r.severity
      : "warning",
    status: r.status,
    firstSeenAt: stamp(r.firstSeenAt) ?? 0,
    lastSeenAt: stamp(r.lastSeenAt) ?? 0,
    resolvedAt: stamp(r.resolvedAt),
    acknowledgedAt: stamp(r.acknowledgedAt),
    snoozedUntil: stamp(r.snoozedUntil),
    count: Math.min(1e9, Math.max(1, Number.isInteger(r.count) ? r.count : 1)),
    conditions,
    timeline,
    widgetIds: [
      ...new Set(
        (Array.isArray(r.widgetIds)
          ? r.widgetIds
          : conditions.map((c) => c.widgetId)
        )
          .filter((v) => typeof v === "string")
          .map((v) => clean(v, 128)),
      ),
    ].slice(0, MAX_CONDITIONS),
    pageIds: [
      ...new Set(
        (Array.isArray(r.pageIds) ? r.pageIds : [])
          .filter((v) => typeof v === "string")
          .map((v) => clean(v, 128)),
      ),
    ].slice(0, 128),
    stale: r.status === "active" && r.synthetic !== true,
    synthetic: r.synthetic === true,
    _lastNotifiedAt: stamp(r._lastNotifiedAt) ?? 0,
    _loaded: true,
  };
}
export class MonitorAlerts {
  constructor({ clock = Date.now, dir, onError = () => {} } = {}) {
    this.clock = clock;
    this.onError = onError;
    this.storageError = false;
    this.file = dir ? path.join(dir, "monitor-incidents.json") : null;
    this.incidents = new Map();
    this.trackers = new Map();
    this.notifications = [];
    this.widgets = {};
    this.dirty = false;
    this.lastWriteAt = 0;
    if (this.file && fs.existsSync(this.file)) {
      try {
        if (fs.statSync(this.file).size <= MAX_STORE_BYTES) {
          const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
          if (saved.version === 1 && Array.isArray(saved.incidents))
            for (const input of saved.incidents.slice(-MAX_INCIDENTS)) {
              const r = safeRecord(input);
              if (r) this.incidents.set(r.id, r);
            }
        } else throw Error("HISTORY_SIZE");
      } catch {
        this.storageError = true;
        this.onError("read");
      }
    }
  }
  persist(force = false) {
    if (!this.file || !this.dirty) return true;
    if (!force && this.clock() - this.lastWriteAt < 10000)
      return !this.storageError;
    const temp = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    this.lastWriteAt = this.clock();
    try {
      const data = JSON.stringify({
        version: 1,
        incidents: [...this.incidents.values()].map((record) => {
          const r = publicIncident(safeRecord(record));
          delete r.widgetIds; // Reconstructed from the bounded condition IDs and current configuration.
          r.pageIds = r.pageIds.slice(0, 1);
          return { ...r, _lastNotifiedAt: record._lastNotifiedAt };
        }),
      });
      if (Buffer.byteLength(data) > MAX_STORE_BYTES)
        throw Error("HISTORY_SIZE");
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(temp, data, { mode: 0o600 });
      fs.renameSync(temp, this.file);
      fs.chmodSync(this.file, 0o600);
      this.dirty = false;
      this.storageError = false;
      return true;
    } catch {
      if (!this.storageError) this.onError("write");
      this.storageError = true;
      return false;
    } finally {
      try {
        if (fs.existsSync(temp)) fs.unlinkSync(temp);
      } catch {}
    }
  }
  close() {
    this.persist(true);
  }
  timeline(record, type, extra = {}) {
    record.timeline.push({ type, at: this.clock(), ...extra });
    record.timeline = record.timeline.slice(-MAX_TIMELINE);
    this.dirty = true;
  }
  scopes(config) {
    const groups = new Map();
    for (const page of config.pages || [])
      for (const widget of page.widgets || []) {
        if (
          typeof page.id !== "string" ||
          page.id.length > 128 ||
          typeof widget.id !== "string" ||
          widget.id.length > 128
        )
          continue;
        if (
          !["grafana", "system"].includes(widget.type) ||
          !monitorSettings(widget).enabled
        )
          continue;
        const projects =
          widget.type === "system"
            ? [{ value: "mac", label: "내 Mac" }]
            : widget.projects || [];
        for (const project of projects)
          for (const synthetic of [false, true]) {
            const id = groupId(widget, project.value, synthetic);
            const group = groups.get(id) || {
              id,
              project: clean(project.value, 128),
              label: clean(project.label || project.value),
              members: [],
            };
            if (!group.members.some((m) => m.widget.id === widget.id))
              group.members.push({ page, widget });
            groups.set(id, group);
          }
      }
    return groups;
  }
  inbox(config, allowedWidgetIds = null) {
    const scopes = this.scopes(config),
      allowed = allowedWidgetIds ? new Set(allowedWidgetIds) : null;
    const incidents = [...this.incidents.values()]
      .flatMap((record) => {
        const scope = scopes.get(record.id);
        if (!scope) return [];
        const members = scope.members.filter(
          (m) => !allowed || allowed.has(m.widget.id),
        );
        if (!members.length) return [];
        const ids = new Set(members.map((m) => m.widget.id));
        const result = {
          ...publicIncident(record),
          widgetIds: [...ids],
          pageIds: [...new Set(members.map((m) => m.page.id))],
          conditions: record.conditions.filter((c) => ids.has(c.widgetId)),
        };
        if (result.conditions.length)
          result.severity = severity(result.conditions);
        // Do not disclose an incident generated exclusively by a different profile.
        if (allowed && record.conditions.length && !result.conditions.length)
          return [];
        return [result];
      })
      .sort(
        (a, b) =>
          (a.status === "active" ? 0 : 1) - (b.status === "active" ? 0 : 1) ||
          b.lastSeenAt - a.lastSeenAt,
      );
    return {
      incidents,
      activeCount: incidents.filter((r) => r.status === "active").length,
      storageError: this.storageError,
      unacknowledgedCount: incidents.filter(
        (r) => r.status === "active" && !r.acknowledgedAt,
      ).length,
    };
  }
  act(config, id, input, allowedWidgetIds = null) {
    if (
      !plain(input) ||
      Object.keys(input).some((k) => !["action", "minutes"].includes(k)) ||
      !["acknowledge", "snooze", "resume"].includes(input.action) ||
      (input.minutes !== undefined &&
        (input.action !== "snooze" || input.minutes !== 30))
    )
      throw Object.assign(Error("알림 처리 작업을 확인하세요."), {
        status: 400,
      });
    const current = this.inbox(config, allowedWidgetIds).incidents.find(
      (r) => r.id === id,
    );
    if (!current)
      throw Object.assign(Error("알림을 찾을 수 없습니다."), { status: 404 });
    if (current.status !== "active")
      throw Object.assign(Error("이미 복구된 알림입니다."), { status: 409 });
    const record = this.incidents.get(id),
      now = this.clock();
    const before = structuredClone(record);
    if (input.action === "acknowledge" && !record.acknowledgedAt) {
      record.acknowledgedAt = now;
      this.timeline(record, "acknowledge");
    } else if (input.action === "snooze") {
      record.snoozedUntil = now + 30 * 60000;
      this.timeline(record, "snooze", { until: record.snoozedUntil });
    } else if (input.action === "resume" && record.snoozedUntil) {
      record.snoozedUntil = null;
      record._lastNotifiedAt = 0;
      this.timeline(record, "resume");
    }
    if (!this.persist(true)) {
      this.incidents.set(id, before);
      throw Object.assign(
        Error("알림 이력을 저장하지 못했습니다. 디스크 상태를 확인하세요."),
        { status: 503 },
      );
    }
    const inbox = this.inbox(config, allowedWidgetIds);
    return {
      incident: inbox.incidents.find((r) => r.id === id),
      activeCount: inbox.activeCount,
      unacknowledgedCount: inbox.unacknowledgedCount,
    };
  }
  newRecord(group, conditions, synthetic = false) {
    if (this.incidents.size >= MAX_INCIDENTS) {
      const oldest = [...this.incidents.values()]
        .filter((r) => r.status === "resolved")
        .sort((a, b) => a.lastSeenAt - b.lastSeenAt)[0];
      if (!oldest) return null; // Preserve active incidents; never rotate them into repeated "new" alerts.
      this.incidents.delete(oldest.id);
    }
    conditions = conditions.slice(0, MAX_CONDITIONS);
    const now = this.clock();
    const record = {
      id: group.id,
      project: group.project,
      label: group.label,
      title: synthetic ? "Open Deck · 알림 테스트" : `${group.label} · 모니터`,
      severity: severity(conditions),
      status: "active",
      firstSeenAt: now,
      lastSeenAt: now,
      resolvedAt: null,
      acknowledgedAt: null,
      snoozedUntil: null,
      count: 1,
      conditions,
      widgetIds: group.members.map((m) => m.widget.id).slice(0, 128),
      pageIds: [...new Set(group.members.map((m) => m.page.id))],
      timeline: [],
      stale: false,
      synthetic,
      _lastNotifiedAt: 0,
    };
    this.incidents.set(group.id, record);
    this.timeline(record, "occurrence", { severity: record.severity });
    return record;
  }
  notify(record, recovery = false, conditions = record.conditions) {
    const now = this.clock();
    record._lastNotifiedAt = now;
    this.dirty = true;
    const notificationSeverity = recovery ? "normal" : severity(conditions);
    const body = record.synthetic
      ? "임계치 알림 테스트입니다. 실제 장애 알림이 아닙니다."
      : recovery
        ? "지표가 설정한 정상 범위로 돌아왔습니다."
        : conditions
            .map((c) =>
              c.key === "ready"
                ? "DB 준비 상태 확인 필요"
                : c.key === "collection"
                  ? "지표 수집 실패 대상 있음"
                  : `${c.label} ${typeof c.value === "number" ? c.value.toLocaleString("ko-KR", { maximumFractionDigits: 2 }) : "—"} (${c.level === "critical" ? "위험" : "주의"})`,
            )
            .join(" · ");
    this.notifications.push({
      id: "monitor-" + crypto.randomUUID(),
      incidentId: record.id,
      kind: "monitor",
      pageId: record.pageIds[0],
      widgetId: record.widgetIds[0],
      project: record.project,
      severity: notificationSeverity,
      conditions: conditions.slice(0, MAX_CONDITIONS),
      createdAt: now,
      synthetic: record.synthetic,
      title:
        record.title +
        " · " +
        (recovery
          ? "정상 복구"
          : notificationSeverity === "critical"
            ? "위험"
            : "주의"),
      body,
    });
  }
  testNotification(page, widget, operation = "trigger") {
    if (!["trigger", "recover"].includes(operation))
      throw Error("알림 테스트 작업을 확인하세요.");
    const project =
      widget.type === "system"
        ? { value: "mac", label: "내 Mac" }
        : widget.projects?.find((p) => p.value === widget.defaultProject) ||
          widget.projects?.[0];
    if (!project || !monitorSettings(widget).enabled)
      throw Error("모니터 위젯을 선택하세요.");
    const group = {
      id: groupId(widget, project.value, true),
      project: project.value,
      label: project.label,
      members: [{ page, widget }],
    };
    let record = this.incidents.get(group.id);
    if (operation === "recover") {
      if (record?.status === "active") {
        record.status = "resolved";
        record.resolvedAt = this.clock();
        record.stale = false;
        this.timeline(record, "recovery");
        if (!(record.snoozedUntil > this.clock())) this.notify(record, true);
      }
    } else {
      const conditions = [
        {
          key: "test",
          label: "알림 테스트",
          level: "warning",
          value: 1,
          widgetId: widget.id,
        },
      ];
      if (!record) record = this.newRecord(group, conditions, true);
      else {
        if (record.status !== "active") record.count++;
        record.status = "active";
        record.resolvedAt = null;
        record.acknowledgedAt = null;
        record.snoozedUntil = null;
        record.conditions = conditions;
        record.stale = false;
        record.lastSeenAt = this.clock();
        this.timeline(record, "occurrence", { severity: "warning" });
      }
      if (!record)
        throw Error("활성 알림이 너무 많습니다. 복구된 뒤 다시 시도하세요.");
      this.notify(record);
    }
    this.dirty = true;
    this.prune(this.scopes({ pages: [{ ...page, widgets: [widget] }] }), false);
    this.persist(true);
    return record ? publicIncident(record) : null;
  }
  prune(scopes, removeMissing = true) {
    const now = this.clock();
    for (const [id, r] of this.incidents)
      if (
        (removeMissing && !scopes.has(id)) ||
        (r.status === "resolved" &&
          now - (r.resolvedAt || r.lastSeenAt) > 30 * DAY)
      ) {
        this.incidents.delete(id);
        this.dirty = true;
      }
    const history = [...this.incidents.values()]
      .filter((r) => r.status === "resolved")
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    for (const record of history.slice(80)) {
      this.incidents.delete(record.id);
      this.dirty = true;
    }
    const records = [...this.incidents.values()].sort(
      (a, b) =>
        (a.status === "resolved" ? 0 : 1) - (b.status === "resolved" ? 0 : 1) ||
        a.lastSeenAt - b.lastSeenAt,
    );
    for (const record of records.slice(
      0,
      Math.max(0, records.length - MAX_INCIDENTS),
    )) {
      this.incidents.delete(record.id);
      this.dirty = true;
    }
    this.notifications = this.notifications
      .filter((n) => now - n.createdAt < DAY)
      .slice(-40);
  }
  evaluate(config, { grafana, system } = {}) {
    const now = this.clock(),
      scopes = this.scopes(config),
      widgets = {},
      wanted = new Set();
    let transition = false;
    for (const group of scopes.values()) {
      const syntheticId = groupId(group.members[0].widget, group.project, true);
      if (group.id === syntheticId) {
        const testRecord = this.incidents.get(group.id);
        if (testRecord?.snoozedUntil && testRecord.snoozedUntil <= now) {
          testRecord.snoozedUntil = null;
          this.timeline(testRecord, "resume");
          transition = true;
        }
        continue;
      }
      const previous = this.incidents.get(group.id);
      const conditions = [],
        freshConditions = [];
      let allKnown = true,
        cooldown = Infinity,
        observedAt = 0;
      for (const { page, widget } of group.members) {
        const settings = monitorSettings(widget);
        cooldown = Math.min(cooldown, settings.cooldownSeconds * 1000);
        const data =
          widget.type === "system"
            ? system
            : grafana?.widgets?.[widget.id]?.projects?.[group.project];
        const fresh =
          !!data &&
          Number.isFinite(data.capturedAt) &&
          data.capturedAt <= now + 1000 &&
          (widget.type === "system"
            ? data.status === "connected" && now - data.capturedAt < 10000
            : data.status === "ready" && now - data.capturedAt < 90000);
        if (fresh) observedAt = Math.max(observedAt, data.capturedAt);
        const values =
          widget.type === "system"
            ? {
                cpu: number(data?.cpu?.percent),
                memory:
                  data?.memory?.totalBytes > 0 &&
                  number(data?.memory?.usedBytes) !== null
                    ? (100 * data.memory.usedBytes) / data.memory.totalBytes
                    : null,
              }
            : {
                cpu: number(
                  widget.metric === "system"
                    ? data?.system?.value
                    : data?.cpu?.value,
                ),
                memory: number(data?.memory?.value),
                tps: number(data?.tps?.value),
                qps: number(data?.qps?.value),
                connections: number(data?.database?.connections),
                latency: number(data?.service?.latency?.value),
                errorRate: number(data?.service?.errorRate?.value),
                rps: number(data?.service?.rps?.value),
              };
        const metrics = {};
        for (const [key, rule] of Object.entries(settings.rules)) {
          const source =
              data?.freshness?.[
                key === "cpu" && widget.metric === "system" ? "system" : key
              ],
            value =
              fresh &&
              (!source || (source.status === "fresh" && !source.missingSeries))
                ? values[key]
                : null;
          metrics[key] = { ...rule, value, level: monitorLevel(value, rule) };
        }
        if (widget.type === "grafana") {
          const key = widget.metric === "system" ? "collection" : "ready",
            source = data?.freshness?.[key];
          const valid =
            fresh &&
            (!source || (source.status === "fresh" && !source.missingSeries));
          const value =
            key === "ready" ? data?.database?.ready : data?.collection?.healthy;
          const known =
            key === "ready"
              ? typeof value === "boolean"
              : number(data?.collection?.total) !== null &&
                data.collection.total > 0 &&
                number(value) !== null;
          metrics[key] = {
            enabled: true,
            value,
            level:
              !valid || !known
                ? "unknown"
                : (key === "ready" ? value : value === data.collection.total)
                  ? "normal"
                  : "critical",
          };
        }
        const level = Object.values(metrics)
          .filter((m) => m.enabled)
          .reduce(
            (best, m) => (rank[m.level] > rank[best] ? m.level : best),
            "unknown",
          );
        (widgets[widget.id] ??= { projects: {} }).projects[group.project] = {
          level,
          metrics,
        };
        for (const [key, metric] of Object.entries(metrics)) {
          if (!metric.enabled) continue;
          const trackerId = group.id + ":" + widget.id + ":" + key;
          wanted.add(trackerId);
          const ruleSignature = JSON.stringify([
            metric.enabled,
            metric.direction,
            metric.warning,
            metric.critical,
            settings.holdSeconds,
          ]);
          let tracker = this.trackers.get(trackerId);
          if (!tracker || tracker.signature !== ruleSignature) {
            const saved =
              previous?.status === "active"
                ? previous.conditions.find(
                    (c) => c.widgetId === widget.id && c.key === key,
                  )
                : null;
            tracker = {
              signature: ruleSignature,
              candidate: "unknown",
              since: now,
              condition: saved ? { ...saved } : null,
            };
            this.trackers.set(trackerId, tracker);
          }
          if (metric.level === "unknown") {
            allKnown = false;
            tracker.candidate = "unknown";
            tracker.since = now;
          } else {
            if (tracker.candidate !== metric.level) {
              tracker.candidate = metric.level;
              tracker.since = now;
            }
            if (now - tracker.since >= settings.holdSeconds * 1000)
              tracker.condition =
                rank[metric.level] > 0
                  ? {
                      key,
                      label: clean(
                        monitorRuleNames[key] ||
                          (key === "ready" ? "DB 준비 상태" : "지표 수집 상태"),
                      ),
                      level: metric.level,
                      value: metric.value,
                      widgetId: widget.id,
                    }
                  : null;
            else if (tracker.condition && rank[metric.level] === 0)
              allKnown = false;
          }
          if (tracker.condition) {
            conditions.push({ ...tracker.condition });
            if (
              settings.notify &&
              metric.level === tracker.condition.level &&
              now - tracker.since >= settings.holdSeconds * 1000
            )
              freshConditions.push({ ...tracker.condition });
          }
        }
      }
      let record = previous;
      if (!record && conditions.length) {
        record = this.newRecord(group, conditions);
        transition = true;
      }
      if (!record) continue;
      const beforeRecord = JSON.stringify(publicIncident(record));
      const recoveryNotify = record.conditions.some((c) =>
        group.members.some(
          (m) => m.widget.id === c.widgetId && monitorSettings(m.widget).notify,
        ),
      );
      const oldSignature = signature(record.conditions),
        oldStatus = record.status;
      record.widgetIds = group.members.map((m) => m.widget.id).slice(0, 128);
      record.pageIds = [...new Set(group.members.map((m) => m.page.id))];
      record.label = group.label;
      record.title = clean(`${group.label} · 모니터`);
      const loaded = record._loaded;
      if (loaded) {
        delete record._loaded;
        record._lastNotifiedAt = now;
      }
      if (record.snoozedUntil && record.snoozedUntil <= now) {
        record.snoozedUntil = null;
        this.timeline(record, "resume");
        transition = true;
      }
      if (conditions.length) {
        if (oldStatus === "resolved") {
          record.count++;
          record.acknowledgedAt = null;
          record.snoozedUntil = null;
          record.resolvedAt = null;
          this.timeline(record, "occurrence", {
            severity: severity(conditions),
          });
          transition = true;
        }
        record.status = "active";
        record.conditions = conditions.slice(0, MAX_CONDITIONS);
        record.severity = severity(conditions);
        record.stale = !allKnown;
        if (allKnown) record.lastSeenAt = observedAt || now;
        const changed =
          oldSignature !== signature(record.conditions) ||
          oldStatus !== "active";
        if (
          !loaded &&
          freshConditions.length > 0 &&
          !record.acknowledgedAt &&
          !(record.snoozedUntil > now) &&
          (changed ||
            !record._lastNotifiedAt ||
            now - record._lastNotifiedAt >= cooldown)
        ) {
          this.notify(record, false, freshConditions);
          transition = true;
        }
      } else if (record.status === "active" && allKnown) {
        record.status = "resolved";
        record.resolvedAt = now;
        record.lastSeenAt = now;
        record.stale = false;
        this.timeline(record, "recovery", { severity: "normal" });
        transition = true;
        if (recoveryNotify && !loaded && !(record.snoozedUntil > now))
          this.notify(record, true);
      } else if (record.status === "active") record.stale = true;
      if (beforeRecord !== JSON.stringify(publicIncident(record)))
        this.dirty = true;
    }
    for (const id of this.trackers.keys())
      if (!wanted.has(id)) this.trackers.delete(id);
    this.prune(scopes);
    this.widgets = widgets;
    this.persist(transition);
    return {
      widgets,
      notifications: this.notifications,
      inbox: this.inbox(config),
    };
  }
}
