import { t, tf, locale as uiLocale, translateError } from "./i18n.mjs";
export function monitorPage({
  id = crypto.randomUUID(),
  grafana = {
    url: "",
    projects: [{ label: t("프로젝트"), value: "project" }],
    defaultProject: "project",
  },
} = {}) {
  const connection = {
    projectVariable: "project",
    projectGroup: id + "-grafana",
    ...grafana,
  };
  return {
    id,
    name: t("모니터"),
    columns: 12,
    rows: 7,
    theme: "graphite",
    background: "#101720",
    gap: 12,
    radius: 16,
    widgets: [
      {
        id: id + "-grafana-system",
        type: "grafana",
        metric: "system",
        label: t("서버 상태"),
        x: 0,
        y: 0,
        w: 4,
        h: 6,
        color: "#8b9fb5",
        style: { background: "#18222e", textSize: 16, valueSize: 56 },
        ...connection,
      },
      {
        id: id + "-grafana",
        type: "grafana",
        metric: "database",
        label: t("데이터베이스"),
        x: 4,
        y: 0,
        w: 8,
        h: 6,
        color: "#8b9fb5",
        style: { background: "#1c2835", textSize: 16, valueSize: 44 },
        ...connection,
      },
      {
        id: id + "-system-overview",
        type: "system",
        metric: "overview",
        compact: true,
        label: t("내 Mac"),
        x: 0,
        y: 6,
        w: 12,
        h: 1,
        color: "#9bafbd",
        style: { background: "#151f2a", textSize: 14, valueSize: 24 },
      },
    ],
  };
}
