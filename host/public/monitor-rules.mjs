export const monitorRuleNames = {
  cpu: "CPU (%)",
  memory: "MEM (%)",
  tps: "TPS (커밋/초)",
  qps: "QPS (쿼리/초)",
  connections: "DB 연결 수",
};
export function monitorSettings(widget) {
  const saved = widget.alerts || {};
  const defaults = {
    cpu: { enabled: true, direction: "above", warning: 80, critical: 90 },
    memory: { enabled: true, direction: "above", warning: 85, critical: 95 },
    tps: { enabled: false, direction: "above", warning: null, critical: null },
    qps: { enabled: false, direction: "above", warning: null, critical: null },
    connections: {
      enabled: false,
      direction: "above",
      warning: null,
      critical: null,
    },
  };
  const keys =
    widget.type === "system"
      ? ["cpu", "memory"]
      : widget.metric === "system"
        ? ["cpu"]
        : Object.keys(defaults);
  return {
    enabled: saved.enabled !== false,
    notify: saved.notify !== false,
    holdSeconds: saved.holdSeconds ?? 60,
    cooldownSeconds: saved.cooldownSeconds ?? 600,
    rules: Object.fromEntries(
      keys.map((key) => [key, { ...defaults[key], ...saved.rules?.[key] }]),
    ),
  };
}
export function validateMonitorSettings(widget) {
  if (widget.alerts === undefined) return;
  const input = widget.alerts;
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw Error("모니터 임계치 설정을 확인하세요.");
  for (const key of ["enabled", "notify"])
    if (input[key] !== undefined && typeof input[key] !== "boolean")
      throw Error("모니터 알림 설정을 확인하세요.");
  const settings = monitorSettings(widget);
  for (const [key, min, max] of [
    ["holdSeconds", 0, 3600],
    ["cooldownSeconds", 60, 86400],
  ])
    if (
      !Number.isInteger(settings[key]) ||
      settings[key] < min ||
      settings[key] > max
    )
      throw Error("알림 지속 시간과 재알림 간격을 확인하세요.");
  if (
    input.rules !== undefined &&
    (!input.rules ||
      Array.isArray(input.rules) ||
      typeof input.rules !== "object" ||
      Object.keys(input.rules).some((k) => !Object.hasOwn(settings.rules, k)))
  )
    throw Error("모니터 지표별 임계치를 확인하세요.");
  if (
    input.rules &&
    Object.values(input.rules).some(
      (rule) => !rule || typeof rule !== "object" || Array.isArray(rule),
    )
  )
    throw Error("지표별 임계치를 확인하세요.");
  for (const [key, rule] of Object.entries(settings.rules)) {
    if (
      typeof rule.enabled !== "boolean" ||
      !["above", "below"].includes(rule.direction)
    )
      throw Error("임계치 방향을 확인하세요.");
    const upper = ["cpu", "memory"].includes(key) ? 100 : 1e12;
    const valid = (v) => Number.isFinite(v) && v >= 0 && v <= upper;
    if (
      [rule.warning, rule.critical].some((v) => v !== null && !valid(v)) ||
      (rule.enabled && (!valid(rule.warning) || !valid(rule.critical)))
    )
      throw Error("활성화할 지표의 주의·위험 임계치를 입력하세요.");
    if (
      valid(rule.warning) &&
      valid(rule.critical) &&
      (rule.direction === "above"
        ? rule.warning >= rule.critical
        : rule.warning <= rule.critical)
    )
      throw Error("주의·위험 임계치 순서를 확인하세요.");
  }
}
export function monitorLevel(value, rule) {
  if (!Number.isFinite(value)) return "unknown";
  if (!rule?.enabled) return "normal";
  const exceeds = (threshold) =>
    rule.direction === "below" ? value <= threshold : value >= threshold;
  return exceeds(rule.critical)
    ? "critical"
    : exceeds(rule.warning)
      ? "warning"
      : "normal";
}
