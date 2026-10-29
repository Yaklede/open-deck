package app.opendeck.client;

public final class StreamConnectionPolicyTest {
  private static int checks;

  private static void check(boolean condition, String description) {
    checks++;
    if (!condition) throw new AssertionError(description);
  }

  public static void main(String[] args) {
    check(StreamConnectionPolicy.READ_TIMEOUT_MS == 20000, "Read timeout is twenty seconds");
    check(
        StreamConnectionPolicy.READ_TIMEOUT_MS == StreamConnectionPolicy.TRAFFIC_TIMEOUT_MS,
        "Socket read and traffic budgets use the same timeout");
    StreamConnectionPolicy policy = new StreamConnectionPolicy();
    int[] expected = {1000, 2000, 4000, 8000, 15000, 15000, 15000};
    for (int delay : expected) {
      policy.opened();
      check(policy.failureDelay() == delay, "200 then EOF preserves escalating backoff: " + delay);
    }
    policy.explicitReconnect();
    long now = 100000;
    for (int delay : expected) {
      policy.opened();
      check(!policy.snapshot(now), "One snapshot never declares a stable session");
      check(
          policy.failureDelay() == delay,
          "One snapshot then short EOF preserves escalating backoff: " + delay);
      now += 5000;
    }
    policy.opened();
    check(!policy.snapshot(200000), "New session starts its own stable window");
    check(!policy.snapshot(209999), "Two snapshots just before ten seconds are not stable");
    check(
        policy.snapshot(210000),
        "Two or more snapshots become stable at exact ten-second boundary");
    check(!policy.snapshot(220000), "Stable notification fires only once per session");
    check(policy.failureDelay() == 1000, "A sustained healthy stream resets backoff");
    policy.opened();
    check(!policy.snapshot(300000), "Opening a new session clears prior stability");
    check(policy.failureDelay() == 2000, "A new short session retains previous failure history");
    policy.opened();
    check(!policy.snapshot(400000), "First snapshot is recorded");
    check(policy.snapshot(410001), "Exactly two snapshots can establish sustained health");
    check(policy.failureDelay() == 1000, "A later healthy session can reset backoff again");

    policy.explicitReconnect();
    policy.opened();
    check(!policy.snapshot(-1), "Invalid snapshot time does not start a session");
    check(!policy.snapshot(0), "Zero monotonic time is a valid first snapshot");
    check(policy.snapshot(10000), "Zero-origin stable window is calculated correctly");
    policy.opened();
    check(!policy.snapshot(500000), "First snapshot after reopen is not stable");
    check(!policy.snapshot(499999), "Clock reversal cannot produce stable health");
    check(!policy.snapshot(509999), "Rejected older timestamp does not shorten the window");
    check(policy.snapshot(510000), "Original first-snapshot time remains the anchor");
    policy.opened();
    check(!policy.snapshot(Long.MAX_VALUE - 10000), "Huge monotonic origin remains safe");
    check(policy.snapshot(Long.MAX_VALUE), "Stable time subtraction does not overflow");

    policy.explicitReconnect();
    check(policy.failureDelay() == 1000, "Explicit reconnect resets retry delay");
    check(policy.failureDelay() == 2000, "Retry delay then escalates normally");
    policy.opened();
    check(!policy.snapshot(700000), "Session first snapshot recorded before explicit reset");
    policy.explicitReconnect();
    check(!policy.snapshot(720000), "Explicit reconnect clears old first-snapshot state");
    check(policy.snapshot(730000), "New session must satisfy its own stable window");

    check(
        !StreamConnectionPolicy.trafficAlive(false, 110000, 100000, 109000),
        "Disconnected socket is not alive despite recent traffic");
    check(
        !StreamConnectionPolicy.trafficAlive(true, 100000, 0, 0),
        "No opening or traffic timestamp cannot be live");
    check(
        StreamConnectionPolicy.trafficAlive(true, 119999, 100000, 0),
        "Opened stream is within initial traffic grace");
    check(
        !StreamConnectionPolicy.trafficAlive(true, 120000, 100000, 0),
        "Initial traffic grace expires at exact twenty seconds");
    check(
        StreamConnectionPolicy.trafficAlive(true, 130000, 100000, 129000),
        "A heartbeat extends transport liveness");
    check(
        StreamConnectionPolicy.trafficAlive(true, 119999, 100000, 90000),
        "Old attempt traffic cannot shorten a newly opened stream grace");
    check(
        !StreamConnectionPolicy.trafficAlive(true, 120000, 100000, 90000),
        "Old attempt traffic cannot extend new stream grace");
    check(
        !StreamConnectionPolicy.trafficAlive(true, 99999, 100000, 0),
        "Future opening timestamp is rejected");
    check(
        !StreamConnectionPolicy.trafficAlive(true, 120000, 100000, 120001),
        "Future traffic timestamp is rejected");
    check(
        StreamConnectionPolicy.trafficAlive(true, Long.MAX_VALUE, Long.MAX_VALUE - 19999, 0),
        "Traffic age near long limit remains safe");
    check(
        !StreamConnectionPolicy.trafficAlive(true, Long.MAX_VALUE, Long.MAX_VALUE - 20000, 0),
        "Traffic expiry near long limit remains exact");
    policy.explicitReconnect();
    policy.failureDelay();
    policy.failureDelay();
    policy.opened();
    check(!policy.snapshot(800000), "Initial data is not yet a sustained stream");
    for (long traffic = 802000; traffic <= 830000; traffic += 2000)
      check(
          StreamConnectionPolicy.trafficAlive(true, traffic, 800000, traffic),
          "Heartbeat-only transport remains live without inventing snapshot health");
    check(policy.failureDelay() == 4000, "Heartbeats do not reset snapshot stability backoff");

    policy = new StreamConnectionPolicy();
    check(policy.canPromote(0), "First promotion can be attempted immediately");
    check(!policy.canPromote(-1), "Invalid clock cannot trigger promotion");
    policy.promotionAttempted(100000);
    check(!policy.canPromote(129999), "Promotion waits thirty seconds");
    check(policy.canPromote(130000), "Promotion cooldown deadline is inclusive");
    policy.promotionAttempted(130000);
    policy.opened();
    check(!policy.canPromote(140000), "New stream headers do not bypass promotion cooldown");
    policy.snapshot(131000);
    policy.snapshot(141000);
    check(!policy.canPromote(141000), "Stable snapshots do not bypass promotion cooldown");
    policy.explicitReconnect();
    check(!policy.canPromote(150000), "Explicit retry does not erase a promotion attempt cooldown");
    check(policy.canPromote(160000), "Cooldown remains bounded after reconnect");
    policy.promotionAttempted(-1);
    check(!policy.canPromote(159999), "Invalid promotion timestamp cannot erase a deadline");
    policy.promotionAttempted(Long.MAX_VALUE - 1);
    check(!policy.canPromote(Long.MAX_VALUE - 1), "Promotion deadline cannot wrap into the past");
    check(policy.canPromote(Long.MAX_VALUE), "Saturated promotion deadline is reachable");
    System.out.println("StreamConnectionPolicy: " + checks + " checks passed");
  }
}
