package app.opendeck.client;

/** Main-thread policy for bounded rediscovery of an already-paired Wi-Fi host. */
public final class HostRecoveryPolicy {
  private static final long FIRST_DELAY_MS = 15000;
  private static final long MAX_DELAY_MS = 60000;
  private int failures;
  private long nextAllowed, delay = FIRST_DELAY_MS;

  public void failed() {
    failures = Math.min(2, failures + 1);
  }

  public void connected() {
    failures = 0;
    nextAllowed = 0;
    delay = FIRST_DELAY_MS;
  }

  public boolean shouldSearch(
      long now,
      boolean foreground,
      boolean paired,
      boolean hasPin,
      String mode,
      boolean connected,
      boolean searching) {
    return now >= 0
        && failures >= 2
        && foreground
        && paired
        && hasPin
        && wifiMode(mode)
        && !connected
        && !searching
        && now >= nextAllowed;
  }

  public void searchStarted(long now) {
    long at = Math.max(0, now);
    nextAllowed = at > Long.MAX_VALUE - delay ? Long.MAX_VALUE : at + delay;
    delay = Math.min(MAX_DELAY_MS, delay * 2);
  }

  /** Reject stale callbacks after re-pairing, explicit reconnect, or a USB-only mode change. */
  public static boolean currentAttempt(
      long expectedGeneration,
      int expectedRevision,
      String expectedToken,
      String expectedPin,
      long actualGeneration,
      int actualRevision,
      String actualToken,
      String actualPin,
      String mode) {
    return expectedToken != null
        && !expectedToken.isEmpty()
        && expectedPin != null
        && !expectedPin.isEmpty()
        && expectedGeneration == actualGeneration
        && expectedRevision == actualRevision
        && expectedToken.equals(actualToken)
        && expectedPin.equals(actualPin)
        && wifiMode(mode);
  }

  private static boolean wifiMode(String mode) {
    return "auto".equals(mode) || "wifi".equals(mode);
  }
}
