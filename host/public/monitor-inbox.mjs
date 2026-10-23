import { t, locale } from "./i18n.mjs";
const el = (tag, text, cls) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  return node;
};
const date = (at) =>
  at
    ? new Intl.DateTimeFormat(locale(), {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(at)
    : "—";
const value = (v) =>
  typeof v === "number"
    ? new Intl.NumberFormat(locale(), { maximumFractionDigits: 2 }).format(v)
    : typeof v === "boolean"
      ? v
        ? t("정상", "Healthy")
        : t("확인 필요", "Needs attention")
      : "—";
export function createMonitorInbox({
  api,
  getSnapshot,
  notify = () => {},
  isConnected = () => true,
}) {
  if (!document.querySelector("link[data-monitor-inbox]")) {
    const link = el("link");
    link.rel = "stylesheet";
    link.href = "/monitor-inbox.css";
    link.dataset.monitorInbox = "";
    document.head.append(link);
  }
  const dialog = el("dialog", undefined, "monitor-inbox"),
    head = el("header", undefined, "mi-head"),
    title = el("h2", t("알림 처리함", "Alert inbox"));
  const closeButton = el("button", t("닫기", "Close"), "mi-close");
  closeButton.type = "button";
  closeButton.onclick = () => dialog.close();
  head.append(title, closeButton);
  const summary = el("p", undefined, "mi-summary"),
    filters = el("div", undefined, "mi-filters"),
    projectSelect = el("select"),
    tabs = el("div", undefined, "mi-tabs"),
    list = el("div", undefined, "mi-list");
  projectSelect.setAttribute("aria-label", t("프로젝트", "Project"));
  let snapshot = getSnapshot?.() || {},
    project = "",
    filter = "active",
    busy = new Set(),
    opened = new Set(),
    signature = "",
    revision = 0;
  const tabButtons = {};
  for (const [key, label, en] of [
    ["active", "진행 중", "Active"],
    ["resolved", "복구 이력", "Resolved"],
    ["all", "전체", "All"],
  ]) {
    const button = el("button", t(label, en));
    button.type = "button";
    button.onclick = () => {
      filter = key;
      render(true);
    };
    tabs.append(button);
    tabButtons[key] = button;
  }
  projectSelect.onchange = () => {
    project = projectSelect.value;
    render(true);
  };
  filters.append(projectSelect, tabs);
  dialog.append(head, summary, filters, list);
  dialog.setAttribute("aria-label", t("알림 처리함", "Alert inbox"));
  async function act(id, action) {
    const current = (snapshot.monitoring?.inbox?.incidents || []).find(
      (r) => r.id === id,
    );
    if (
      !current ||
      current.status !== "active" ||
      busy.has(id) ||
      !isConnected()
    )
      return;
    const requestedAtRevision = revision;
    busy.add(id);
    render(true);
    try {
      const result = await api(
        `/api/monitor/incidents/${encodeURIComponent(id)}`,
        "POST",
        { action, ...(action === "snooze" ? { minutes: 30 } : {}) },
      );
      if (result.incident && revision === requestedAtRevision) {
        const inbox = snapshot.monitoring?.inbox || { incidents: [] };
        snapshot = {
          ...snapshot,
          monitoring: {
            ...snapshot.monitoring,
            inbox: {
              ...inbox,
              incidents: inbox.incidents.map((r) =>
                r.id === result.incident.id ? result.incident : r,
              ),
              activeCount: result.activeCount,
              unacknowledgedCount: result.unacknowledgedCount,
            },
          },
        };
      }
      if (result.inbox && revision === requestedAtRevision)
        snapshot = {
          ...snapshot,
          monitoring: { ...snapshot.monitoring, inbox: result.inbox },
        };
      notify(t("저장했습니다.", "Saved."));
    } catch (error) {
      notify(
        error.message ||
          t("요청을 완료하지 못했습니다.", "Could not complete the request."),
      );
    } finally {
      busy.delete(id);
      render(true);
    }
  }
  function render(force = false) {
    if (!dialog.open && !force) return;
    const inbox = snapshot.monitoring?.inbox || {
        incidents: [],
        activeCount: 0,
        unacknowledgedCount: 0,
      },
      all = inbox.incidents || [];
    const next = JSON.stringify([
      inbox,
      project,
      filter,
      [...busy],
      isConnected(),
      locale(),
    ]);
    if (!force && signature === next) return;
    signature = next;
    const active = document.activeElement,
      focus = active?.dataset?.miFocus,
      scroll = list.scrollTop;
    const projects = new Map(all.map((r) => [r.project, r.label || r.project]));
    projectSelect.replaceChildren(
      el("option", t("모든 프로젝트", "All projects")),
    );
    projectSelect.firstChild.value = "";
    for (const [id, label] of projects) {
      const option = el("option", label);
      option.value = id;
      projectSelect.append(option);
    }
    if (project && !projects.has(project)) project = "";
    projectSelect.value = project;
    const selected = all.filter((r) => !project || r.project === project),
      count = selected.filter((r) => r.status === "active").length,
      unread = selected.filter(
        (r) => r.status === "active" && !r.acknowledgedAt,
      ).length;
    summary.textContent = inbox.storageError
      ? t(
          "알림 이력을 저장하지 못했습니다. 디스크 상태를 확인하세요.",
          "Could not save alert history. Check disk availability.",
        )
      : `${t("진행 중", "Active")} ${count} · ${t("확인 전", "Unacknowledged")} ${unread}`;
    for (const [key, button] of Object.entries(tabButtons)) {
      button.classList.toggle("selected", filter === key);
      button.setAttribute("aria-pressed", String(filter === key));
    }
    list.replaceChildren();
    const records = selected.filter(
      (r) => filter === "all" || r.status === filter,
    );
    if (!records.length)
      list.append(
        el("p", t("표시할 알림이 없습니다.", "No alerts to show."), "mi-empty"),
      );
    for (const record of records) {
      const card = el(
        "article",
        undefined,
        "mi-card " +
          (record.status === "resolved" ? "resolved" : record.severity),
      );
      card.dataset.incidentId = record.id;
      const top = el("div", undefined, "mi-card-head"),
        name = el("h3", record.title),
        badges = el("div", undefined, "mi-badges");
      badges.append(
        el(
          "span",
          record.status === "resolved"
            ? t("복구됨", "Resolved")
            : record.severity === "critical"
              ? t("위험", "Critical")
              : t("주의", "Warning"),
          "mi-severity",
        ),
      );
      if (record.synthetic) badges.append(el("span", t("테스트", "Test")));
      if (record.stale && record.status === "active")
        badges.append(
          el("span", t("수집 지연", "Collection delayed"), "mi-stale"),
        );
      if (record.acknowledgedAt)
        badges.append(el("span", t("확인함", "Acknowledged")));
      if (record.snoozedUntil > Date.now())
        badges.append(
          el(
            "span",
            `${t("알림 중지", "Snoozed")} · ${date(record.snoozedUntil)}`,
          ),
        );
      top.append(name, badges);
      card.append(top);
      const metrics = el("div", undefined, "mi-conditions");
      for (const condition of record.conditions || []) {
        const metric = el("div", undefined, "mi-condition");
        metric.append(
          el("span", condition.label),
          el("strong", value(condition.value)),
        );
        metrics.append(metric);
      }
      card.append(metrics);
      const meta = el(
        "p",
        `${t("최초 발생", "First seen")} ${date(record.firstSeenAt)} · ${record.status === "resolved" ? t("복구", "Recovered") : t("최근 확인", "Last seen")} ${date(record.resolvedAt || record.lastSeenAt)} · ${t("발생 횟수", "Occurrences")} ${record.count}`,
        "mi-meta",
      );
      card.append(meta);
      if (record.stale && record.status === "active")
        card.append(
          el(
            "p",
            t(
              "마지막 경고를 유지하고 있습니다. 새 정상 데이터가 확인되면 복구로 처리합니다.",
              "Keeping the last warning. Recovery requires fresh healthy data.",
            ),
            "mi-stale-note",
          ),
        );
      if (record.status === "active") {
        const actions = el("div", undefined, "mi-actions");
        const entries = [
          ...(record.acknowledgedAt
            ? []
            : [["acknowledge", t("확인", "Acknowledge")]]),
          record.snoozedUntil > Date.now()
            ? ["resume", t("알림 재개", "Resume alerts")]
            : ["snooze", t("30분 알림 중지", "Snooze for 30 minutes")],
        ];
        for (const [action, label] of entries) {
          const button = el("button", label);
          button.type = "button";
          button.dataset.miFocus = record.id + ":" + action;
          button.disabled = busy.has(record.id) || !isConnected();
          button.onclick = () => act(record.id, action);
          actions.append(button);
        }
        card.append(actions);
      }
      const details = el("details", undefined, "mi-history"),
        caption = el("summary", t("처리 이력", "Timeline"));
      details.open = opened.has(record.id);
      details.ontoggle = () =>
        details.open ? opened.add(record.id) : opened.delete(record.id);
      details.append(caption);
      const events = el("ol");
      for (const event of [...(record.timeline || [])].reverse()) {
        const names = {
          occurrence: t("경고 발생", "Alert started"),
          acknowledge: t("확인함", "Acknowledged"),
          snooze: t("30분 알림 중지", "Snoozed for 30 minutes"),
          resume: t("알림 재개", "Alerts resumed"),
          recovery: t("정상 복구", "Recovered"),
        };
        const row = el("li");
        row.append(
          el("span", names[event.type] || event.type),
          el("time", date(event.at)),
        );
        events.append(row);
      }
      details.append(events);
      card.append(details);
      list.append(card);
    }
    list.scrollTop = scroll;
    if (focus) {
      const target = [...list.querySelectorAll("[data-mi-focus]")].find(
        (n) => n.dataset.miFocus === focus,
      );
      target?.focus({ preventScroll: true });
    }
  }
  return {
    element: dialog,
    open() {
      snapshot = getSnapshot?.() || snapshot;
      if (!dialog.open) dialog.showModal();
      render(true);
    },
    close() {
      dialog.close();
    },
    update(next) {
      revision++;
      snapshot = next || {};
      render();
    },
  };
}
