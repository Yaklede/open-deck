export function monitorPage({
  id = crypto.randomUUID(),
  grafana = {
    url: "",
    projects: [{ label: "프로젝트", value: "project" }],
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
    name: "모니터",
    columns: 8,
    rows: 7,
    theme: "ocean",
    gap: 12,
    radius: 16,
    widgets: [
      {
        id: id + "-grafana-system",
        type: "grafana",
        metric: "system",
        label: "서버 시스템 CPU · 상태",
        x: 0,
        y: 0,
        w: 4,
        h: 5,
        color: "#86b6ef",
        style: {},
        ...connection,
      },
      {
        id: id + "-grafana",
        type: "grafana",
        metric: "database",
        label: "DB 상태 · CPU · MEM · TPS · QPS",
        x: 4,
        y: 0,
        w: 4,
        h: 5,
        color: "#83cbb9",
        style: {},
        ...connection,
      },
      {
        id: id + "-system-overview",
        type: "system",
        metric: "overview",
        compact: true,
        label: "내 Mac",
        x: 0,
        y: 5,
        w: 8,
        h: 2,
        color: "#9bafbd",
        style: {},
      },
    ],
  };
}
