package app.opendeck.client;

/** Monotonic-clock policy separating a usable snapshot from a sustained healthy stream. */
public final class StreamConnectionPolicy {
  public static final int READ_TIMEOUT_MS = 20000;
  public static final int TRAFFIC_TIMEOUT_MS = 20000;
  public static final int STABLE_WINDOW_MS = 10000;
  public static final int PROMOTION_COOLDOWN_MS = 30000;
  private static final int INITIAL_RETRY_MS = 1000, MAX_RETRY_MS = 15000;
  private long firstSnapshot = -1, nextPromotion;
  private int snapshots, retryDelay = INITIAL_RETRY_MS;
  private boolean stable;

  /** Receiving headers starts a session but cannot erase previous short-lived failures. */
  public void opened() {
    firstSnapshot = -1;
    snapshots = 0;
    stable = false;
  }

  /** Returns true once per session, after at least two valid snapshots over ten seconds. */
  public boolean snapshot(long now) {
    if (now < 0 || stable || firstSnapshot >= 0 && now < firstSnapshot) return false;
    if (firstSnapshot < 0) firstSnapshot = now;
    snapshots = Math.min(2, snapshots + 1);
    if (snapshots < 2 || now - firstSnapshot < STABLE_WINDOW_MS) return false;
    stable = true;
    retryDelay = INITIAL_RETRY_MS;
    return true;
  }

  public int failureDelay() {
    int result = retryDelay;
    retryDelay = Math.min(MAX_RETRY_MS, retryDelay * 2);
    return result;
  }

  public void explicitReconnect() {
    retryDelay = INITIAL_RETRY_MS;
    opened();
  }

  public boolean canPromote(long now) {
    return now >= 0 && now >= nextPromotion;
  }

  public void promotionAttempted(long now) {
    if (now < 0) return;
    nextPromotion =
        now > Long.MAX_VALUE - PROMOTION_COOLDOWN_MS ? Long.MAX_VALUE : now + PROMOTION_COOLDOWN_MS;
  }

  /** Heartbeats advance transport liveness only; they are not snapshots or metric collections. */
  public static boolean trafficAlive(
      boolean connected, long now, long openedAt, long lastTrafficAt) {
    long last = Math.max(openedAt, lastTrafficAt);
    return connected && last > 0 && now >= last && now - last < TRAFFIC_TIMEOUT_MS;
  }
}
