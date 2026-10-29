package app.opendeck.client;

import java.util.Locale;

/** Pure display and action rules shared by the monitor's native card and dialogs. */
public final class MonitorPresentation {
  private MonitorPresentation() {}

  public static boolean serviceMetric(String key) {
    return "latency".equals(key) || "errorRate".equals(key) || "rps".equals(key);
  }

  public static String latencyLabel(String aggregation) {
    return "p95".equals(aggregation) ? "P95 응답" : "mean".equals(aggregation) ? "평균 응답" : "응답 시간";
  }

  public static double visibleServiceValue(
      String key, double value, boolean queryFresh, int sourceState) {
    return serviceMetric(key)
            && queryFresh
            && sourceState != DataFreshness.MISSING
            && sourceState != DataFreshness.STALE
            && Double.isFinite(value)
            && value >= 0
            && (!"errorRate".equals(key) || value <= 100)
        ? value
        : Double.NaN;
  }

  public static String serviceNumber(String key, double value, Locale locale) {
    if (!Double.isFinite(value)) return "—";
    if ("errorRate".equals(key)) return String.format(locale, "%.2f%%", value);
    return String.format(locale, value >= 1000 ? "%,.0f" : "%,.1f", value);
  }

  public static String serviceUnit(String key) {
    return "latency".equals(key) ? "ms" : "rps".equals(key) ? "req/s" : "%";
  }

  public static boolean incidentMatches(
      String incidentProject, String selectedProject, String status, boolean history) {
    return selectedProject != null
        && !selectedProject.isEmpty()
        && selectedProject.equals(incidentProject)
        && (history ? "resolved".equals(status) : "active".equals(status));
  }

  public static boolean actionAllowed(
      boolean streamFresh,
      boolean samePairing,
      String incidentProject,
      String selectedProject,
      String status,
      String action,
      long acknowledgedAt,
      long snoozedUntil,
      long now) {
    if (!streamFresh
        || !samePairing
        || !incidentMatches(incidentProject, selectedProject, status, false)) return false;
    return "acknowledge".equals(action)
        ? acknowledgedAt <= 0
        : "snooze".equals(action)
            ? snoozedUntil <= now
            : "resume".equals(action) && snoozedUntil > now;
  }
}
