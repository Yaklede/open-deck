package app.opendeck.client;

/** Clock-only decisions; source age is independent of query success and connection state. */
public final class DataFreshness {
  public static final int MISSING = 0, FRESH = 1, DELAYED = 2, STALE = 3;

  public static int classify(long now, long sampleAt, long warnAfter, long staleAfter) {
    if (sampleAt <= 0 || sampleAt > now + 60000) return MISSING;
    long age = Math.max(0, now - sampleAt);
    return age >= staleAfter ? STALE : age >= warnAfter ? DELAYED : FRESH;
  }

  public static boolean osFresh(long now, long collectedAt, boolean providerConnected) {
    return providerConnected && classify(now, collectedAt, 45000, 45000) == FRESH;
  }

  public static boolean streamFresh(boolean connected, long elapsed, long lastEvent) {
    return connected && lastEvent > 0 && elapsed >= lastEvent && elapsed - lastEvent < 8000;
  }
}
