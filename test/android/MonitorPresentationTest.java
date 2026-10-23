package app.opendeck.client;

import java.util.Locale;

public final class MonitorPresentationTest {
  private static int checks;

  private static void check(boolean result, String message) {
    checks++;
    if (!result) throw new AssertionError(message);
  }

  public static void main(String[] args) {
    check(MonitorPresentation.latencyLabel("mean").equals("평균 응답"), "Mean is not P95");
    check(MonitorPresentation.latencyLabel("p95").equals("P95 응답"), "Explicit P95 label");
    check(!MonitorPresentation.latencyLabel("").contains("P95"), "Unknown is not P95");
    check(
        !MonitorPresentation.latencyLabel("p99").contains("P95"), "Another percentile is not P95");
    for (String key : new String[] {"latency", "errorRate", "rps"}) {
      check(
          MonitorPresentation.visibleServiceValue(key, 0, true, DataFreshness.FRESH) == 0,
          "A real zero remains visible: " + key);
      for (int state : new int[] {DataFreshness.STALE, DataFreshness.MISSING}) {
        double value = MonitorPresentation.visibleServiceValue(key, 37, true, state);
        check(
            MonitorPresentation.serviceNumber(key, value, Locale.US).equals("—"),
            "An old or absent sample never becomes zero: " + key);
      }
      check(
          Double.isNaN(
              MonitorPresentation.visibleServiceValue(key, 37, false, DataFreshness.FRESH)),
          "Disconnected stream suppresses numeric value: " + key);
      check(
          Double.isNaN(MonitorPresentation.visibleServiceValue(key, -1, true, DataFreshness.FRESH)),
          "Invalid negative sample suppressed: " + key);
    }
    check(
        Double.isNaN(
            MonitorPresentation.visibleServiceValue("errorRate", 101, true, DataFreshness.FRESH)),
        "Invalid error percentage suppressed");
    check(
        MonitorPresentation.serviceNumber("errorRate", 0.125, Locale.US).equals("0.13%"),
        "Small error rates are readable");
    check(
        MonitorPresentation.serviceUnit("latency").equals("ms"), "Latency is already milliseconds");
    check(MonitorPresentation.serviceUnit("rps").equals("req/s"), "Request rate units");
    check(
        MonitorPresentation.incidentMatches("service-a", "service-a", "active", false),
        "Project active incident visible");
    check(
        !MonitorPresentation.incidentMatches("service-b", "service-a", "active", false),
        "Other project excluded");
    check(
        MonitorPresentation.incidentMatches("service-a", "service-a", "resolved", true),
        "Recovery retained in history");
    check(
        !MonitorPresentation.incidentMatches("service-a", "service-a", "active", true),
        "Active and history remain separate");
    check(
        allowed(true, true, "service-a", "active", "acknowledge", 0, 0),
        "Fresh selected incident can be acknowledged");
    check(
        !allowed(false, true, "service-a", "active", "acknowledge", 0, 0),
        "Offline action blocked");
    check(
        !allowed(true, false, "service-a", "active", "acknowledge", 0, 0),
        "Repaired host action blocked");
    check(
        !allowed(true, true, "service-b", "active", "acknowledge", 0, 0),
        "Changed project blocked");
    check(
        !allowed(true, true, "service-a", "resolved", "acknowledge", 0, 0),
        "Already recovered incident blocked");
    check(
        !allowed(true, true, "service-a", "active", "acknowledge", 50, 0),
        "Acknowledgment cannot be duplicated");
    check(allowed(true, true, "service-a", "active", "snooze", 0, 0), "Snooze allowed");
    check(
        !allowed(true, true, "service-a", "active", "snooze", 0, 200),
        "Active snooze not duplicated");
    check(
        allowed(true, true, "service-a", "active", "resume", 0, 200), "Current snooze can resume");
    check(
        !allowed(true, true, "service-a", "active", "resume", 0, 50),
        "Expired snooze needs no resume");
    check(!allowed(true, true, "service-a", "active", "delete", 0, 0), "Unknown action blocked");
    System.out.println("MonitorPresentation: " + checks + " checks passed");
  }

  private static boolean allowed(
      boolean fresh,
      boolean samePairing,
      String project,
      String status,
      String action,
      long acknowledgedAt,
      long snoozedUntil) {
    return MonitorPresentation.actionAllowed(
        fresh,
        samePairing,
        project,
        "service-a",
        status,
        action,
        acknowledgedAt,
        snoozedUntil,
        100);
  }
}
