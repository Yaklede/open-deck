import crypto from "node:crypto";
import {
  monitorSettings,
  monitorLevel,
  monitorRuleNames,
} from "./public/monitor-rules.mjs";
const number = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const rank = { unknown: -1, normal: 0, warning: 1, critical: 2 };
export class MonitorAlerts {
  constructor({ clock = Date.now } = {}) {
    this.clock = clock;
    this.incidents = new Map();
    this.notifications = [];
    this.widgets = {};
  }
  testNotification(page, widget) {
    this.notifications.push({
      id: "monitor-" + crypto.randomUUID(),
      kind: "monitor",
      severity: "warning",
      createdAt: this.clock(),
      pageId: page.id,
      widgetId: widget.id,
      project:
        widget.type === "system"
          ? "mac"
          : widget.defaultProject || widget.projects?.[0]?.value,
      title: "Open Deck · 알림 테스트",
      body: "임계치 알림이 태블릿에 정상적으로 도착했습니다. 실제 장애 알림이 아닙니다.",
    });
  }
  evaluate(config, { grafana, system }) {
    const now = this.clock(),
      wanted = new Set(),
      widgets = {};
    for (const page of config.pages)
      for (const widget of page.widgets) {
        if (!["grafana", "system"].includes(widget.type)) continue;
        const settings = monitorSettings(widget);
        if (!settings.enabled) continue;
        const projects =
          widget.type === "grafana"
            ? widget.projects
            : [{ value: "mac", label: "내 Mac" }];
        for (const project of projects || []) {
          const data =
            widget.type === "grafana"
              ? grafana?.widgets?.[widget.id]?.projects?.[project.value]
              : system;
          const fresh =
            data &&
            (widget.type === "system"
              ? data.status === "connected" && now - data.capturedAt < 10000
              : data.status === "ready" && now - data.capturedAt < 90000);
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
                };
          const metrics = {};
          for (const [key, rule] of Object.entries(settings.rules)) {
            const value = fresh ? values[key] : null;
            metrics[key] = { ...rule, value, level: monitorLevel(value, rule) };
          }
          if (widget.type === "grafana" && widget.metric !== "system")
            metrics.ready = {
              level:
                !fresh || data?.database?.ready == null
                  ? "unknown"
                  : data.database.ready
                    ? "normal"
                    : "critical",
              value: data?.database?.ready,
              enabled: true,
            };
          if (widget.type === "grafana" && widget.metric === "system")
            metrics.collection = {
              level:
                !fresh || !data?.collection?.total
                  ? "unknown"
                  : data.collection.healthy === data.collection.total
                    ? "normal"
                    : "critical",
              value: data?.collection?.healthy,
              enabled: true,
            };
          const level = Object.values(metrics).reduce(
            (best, m) => (rank[m.level] > rank[best] ? m.level : best),
            "unknown",
          );
          (widgets[widget.id] ??= { projects: {} }).projects[project.value] = {
            level,
            metrics,
          };
          const condition = Object.entries(metrics)
            .filter(([, m]) => rank[m.level] > 0)
            .map(([key, m]) => key + ":" + m.level)
            .sort()
            .join(",");
          const id = widget.id + ":" + project.value;
          wanted.add(id);
          const signature = JSON.stringify([settings, widget.label]);
          let incident = this.incidents.get(id);
          if (!incident || incident.signature !== signature) {
            incident = {
              signature,
              level: "normal",
              candidate: level,
              condition,
              activeCondition: "",
              since: now,
              lastSent: 0,
            };
            this.incidents.set(id, incident);
          }
          if (!fresh || level === "unknown") {
            incident.since = now;
            incident.candidate = "unknown";
            incident.condition = "unknown";
            continue;
          }
          if (
            incident.candidate !== level ||
            incident.condition !== condition
          ) {
            incident.condition = condition;
            incident.candidate = level;
            incident.since = now;
          }
          if (now - incident.since < settings.holdSeconds * 1000) continue;
          const previous = incident.level;
          incident.level = level;
          const alarming = rank[level] > 0;
          const shouldSend = alarming
            ? level !== previous ||
              condition !== incident.activeCondition ||
              now - incident.lastSent >= settings.cooldownSeconds * 1000
            : rank[previous] > 0;
          if (!shouldSend || !settings.notify) continue;
          incident.lastSent = now;
          incident.activeCondition = condition;
          const entries = Object.entries(metrics)
            .filter(([, m]) => rank[m.level] > 0)
            .map(([key, m]) =>
              key === "ready"
                ? "DB 준비 상태 확인 필요"
                : key === "collection"
                  ? "지표 수집 실패 대상 있음"
                  : `${monitorRuleNames[key]} ${m.value.toLocaleString("ko-KR", { maximumFractionDigits: 2 })} (${m.level === "critical" ? "위험" : "주의"})`,
            );
          this.notifications.push({
            id: "monitor-" + crypto.randomUUID(),
            kind: "monitor",
            pageId: page.id,
            widgetId: widget.id,
            project: project.value,
            severity: level,
            createdAt: now,
            title: `${project.label} · ${widget.label || "모니터"} · ${alarming ? (level === "critical" ? "위험" : "주의") : "정상 복구"}`,
            body: alarming
              ? entries.join(" · ")
              : "지표가 설정한 정상 범위로 돌아왔습니다.",
          });
        }
      }
    for (const id of this.incidents.keys())
      if (!wanted.has(id)) this.incidents.delete(id);
    this.notifications = this.notifications
      .filter((n) => now - n.createdAt < 86400000)
      .slice(-40);
    this.widgets = widgets;
    return { widgets, notifications: this.notifications };
  }
}
