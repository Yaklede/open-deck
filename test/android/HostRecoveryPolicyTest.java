package app.opendeck.client;

public final class HostRecoveryPolicyTest {
  private static int checks;

  private static void check(boolean condition, String description) {
    checks++;
    if (!condition) throw new AssertionError(description);
  }

  private static boolean eligible(HostRecoveryPolicy policy, long now) {
    return policy.shouldSearch(now, true, true, true, "auto", false, false);
  }

  private static boolean attempt(
      long generation, int revision, String token, String pin, String mode) {
    return HostRecoveryPolicy.currentAttempt(
        7, 12, "paired-token", "stored-pin", generation, revision, token, pin, mode);
  }

  public static void main(String[] args) {
    HostRecoveryPolicy policy = new HostRecoveryPolicy();
    check(!eligible(policy, 0), "A fresh app does not immediately rediscover");
    policy.failed();
    check(!eligible(policy, 1000), "One endpoint failure does not launch discovery");
    policy.failed();
    check(eligible(policy, 1000), "Two failures permit a bounded discovery attempt");
    check(
        policy.shouldSearch(1000, true, true, true, "wifi", false, false),
        "Wi-Fi-only mode permits rediscovery");
    check(
        !policy.shouldSearch(1000, true, true, true, "usb", false, false),
        "USB-only mode never starts Wi-Fi discovery");
    check(
        !policy.shouldSearch(1000, true, true, true, "unknown", false, false),
        "Unknown transport does not enable network discovery");
    check(
        !policy.shouldSearch(1000, true, true, true, null, false, false),
        "Missing transport is rejected safely");
    check(
        !policy.shouldSearch(1000, false, true, true, "auto", false, false),
        "Background app does not start discovery");
    check(
        !policy.shouldSearch(1000, true, false, true, "auto", false, false),
        "Unpaired app does not discover a replacement identity");
    check(
        !policy.shouldSearch(1000, true, true, false, "auto", false, false),
        "Missing trusted certificate disables recovery");
    check(
        !policy.shouldSearch(1000, true, true, true, "auto", true, false),
        "A healthy connection is not displaced by discovery");
    check(
        !policy.shouldSearch(1000, true, true, true, "auto", false, true),
        "Only one search can be active");
    check(!eligible(policy, -1), "Negative monotonic time is rejected");
    policy.searchStarted(1000);
    check(!eligible(policy, 15999), "First search cooldown lasts fifteen seconds");
    check(eligible(policy, 16000), "First cooldown ends at the exact deadline");
    policy.failed();
    check(!eligible(policy, 15999), "More failures do not bypass search cooldown");
    policy.searchStarted(16000);
    check(!eligible(policy, 45999), "Second search waits thirty seconds");
    check(eligible(policy, 46000), "Second search deadline is inclusive");
    policy.searchStarted(46000);
    check(!eligible(policy, 105999), "Third search waits sixty seconds");
    check(eligible(policy, 106000), "Third search deadline is inclusive");
    policy.searchStarted(106000);
    check(!eligible(policy, 165999) && eligible(policy, 166000), "Cooldown caps at sixty seconds");
    check(
        !policy.shouldSearch(166000, true, true, true, "auto", false, true),
        "Expired cooldown cannot overlap an unfinished search");
    policy.connected();
    check(!eligible(policy, 166000), "Connection success resets accumulated failures");
    policy.failed();
    check(!eligible(policy, 166000), "After recovery a single failure remains insufficient");
    policy.failed();
    check(eligible(policy, 166000), "Fresh failure cycle starts without old cooldown");
    policy.searchStarted(166000);
    check(
        !eligible(policy, 180999) && eligible(policy, 181000),
        "Successful connection also resets exponential backoff");
    for (int i = 0; i < 100000; i++) policy.failed();
    check(eligible(policy, 181000), "Failure count saturates rather than overflowing");
    policy.searchStarted(Long.MAX_VALUE - 1);
    check(!eligible(policy, Long.MAX_VALUE - 1), "Cooldown arithmetic cannot wrap into the past");
    check(eligible(policy, Long.MAX_VALUE), "Saturated cooldown remains reachable");

    check(
        attempt(7, 12, "paired-token", "stored-pin", "auto"),
        "Matching current auto attempt accepted");
    check(
        attempt(7, 12, "paired-token", "stored-pin", "wifi"),
        "Matching current Wi-Fi attempt accepted");
    check(
        !attempt(8, 12, "paired-token", "stored-pin", "auto"),
        "Re-pair generation rejects late result");
    check(
        !attempt(7, 13, "paired-token", "stored-pin", "auto"),
        "Explicit reconnect rejects old result");
    check(
        !attempt(7, 12, "new-token", "stored-pin", "auto"), "Token replacement rejects old probe");
    check(
        !attempt(7, 12, "paired-token", "new-pin", "auto"),
        "Certificate replacement rejects old probe");
    check(
        !attempt(7, 12, "paired-token", "stored-pin", "usb"),
        "USB-only transition rejects late probe");
    check(!attempt(7, 12, "paired-token", "stored-pin", null), "Missing mode rejects late probe");
    check(
        !attempt(7, 12, "paired-token", "stored-pin", "unknown"),
        "Unknown mode rejects late probe");
    check(!attempt(7, 12, "", "stored-pin", "auto"), "Unpairing token clear rejects probe");
    check(!attempt(7, 12, "paired-token", "", "auto"), "Cleared certificate rejects probe");
    check(!attempt(7, 12, null, "stored-pin", "auto"), "Null current token is safe");
    check(!attempt(7, 12, "paired-token", null, "auto"), "Null current certificate is safe");
    check(
        !HostRecoveryPolicy.currentAttempt(
            7, 12, "", "stored-pin", 7, 12, "", "stored-pin", "auto"),
        "Matching empty tokens do not authorize adoption");
    check(
        !HostRecoveryPolicy.currentAttempt(
            7, 12, "paired-token", "", 7, 12, "paired-token", "", "auto"),
        "Matching empty pins do not authorize adoption");
    check(
        !HostRecoveryPolicy.currentAttempt(7, 12, null, null, 7, 12, null, null, "auto"),
        "Missing identity inputs are rejected without exception");
    check(
        !attempt(7, 12, "paired-token", "STORED-PIN", "auto"),
        "Identity matching is exact and does not silently normalize changed pins");
    System.out.println("HostRecoveryPolicy: " + checks + " checks passed");
  }
}
