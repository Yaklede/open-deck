export function monitorPage({
  id = crypto.randomUUID(),
  grafana = {
    url: "",
    projects: [{ label: "프로젝트", value: "project" }],
    defaultProject: "project",
  },
} = {}) {
  const boxes = [
    ["cpu", "CPU", 0, 0, 2, 2, "#86b6ef"],
    ["memory", "메모리", 2, 0, 2, 2, "#b6a6ec"],
    ["disk", "저장 공간", 4, 0, 2, 2, "#efbd73"],
    ["power", "전원 · 발열", 6, 0, 2, 2, "#83cbb9"],
    ["network", "네트워크", 0, 2, 4, 2, "#83cbb9"],
    ["processes", "사용량이 높은 앱", 4, 2, 4, 2, "#86b6ef"],
    ["overview", "내 Mac", 0, 4, 4, 2, "#83cbb9"],
  ];
  return {
    id,
    name: "모니터",
    columns: 8,
    rows: 6,
    theme: "ocean",
    gap: 12,
    radius: 16,
    widgets: [
      ...boxes.map(([metric, label, x, y, w, h, color]) => ({
        id: id + "-system-" + metric,
        type: "system",
        metric,
        label,
        x,
        y,
        w,
        h,
        color,
        style: {},
      })),
      {
        id: id + "-grafana",
        type: "grafana",
        label: "Grafana",
        x: 4,
        y: 4,
        w: 4,
        h: 2,
        color: "#efb17c",
        style: {},
        projectVariable: "project",
        ...grafana,
      },
    ],
  };
}
