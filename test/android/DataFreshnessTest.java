package app.opendeck.client;

public final class DataFreshnessTest {
  private static void check(boolean value, String name) {
    if (!value) throw new AssertionError(name);
  }

  public static void main(String[] args) {
    long now = 1000000;
    check(
        DataFreshness.classify(now, now - 89999, 90000, 300000) == DataFreshness.FRESH,
        "source remains fresh before warning");
    check(
        DataFreshness.classify(now, now - 90000, 90000, 300000) == DataFreshness.DELAYED,
        "warning boundary");
    check(
        DataFreshness.classify(now, now - 300000, 90000, 300000) == DataFreshness.STALE,
        "stale boundary");
    check(
        DataFreshness.classify(now, 0, 90000, 300000) == DataFreshness.MISSING,
        "missing is not zero age");
    check(
        DataFreshness.classify(now, now + 61000, 90000, 300000) == DataFreshness.MISSING,
        "future timestamp invalid");
    check(
        DataFreshness.classify(now, now - 120000, 180000, 300000) == DataFreshness.FRESH,
        "cloud CPU collection budget differs from scrape budget");
    check(DataFreshness.streamFresh(true, 17000, 10000), "healthy heartbeat");
    check(!DataFreshness.streamFresh(true, 18000, 10000), "stale socket cannot stay connected");
    check(!DataFreshness.streamFresh(true, 10000, 0), "no first snapshot");
    check(!DataFreshness.streamFresh(false, 11000, 10000), "socket closed immediately offline");
    check(DataFreshness.streamFresh(true, 19000, 18500), "new snapshot restores stream");
    check(DataFreshness.osFresh(now, now - 44999, true), "OS collection is fresh before boundary");
    check(
        !DataFreshness.osFresh(now, now - 45000, true), "OS sample ages without new network data");
    check(
        !DataFreshness.osFresh(now, now - 1000, false),
        "failed OS refresh immediately marks cached data stale");
    check(!DataFreshness.osFresh(now, 0, true), "first failed OS read is not a collection");
    System.out.println("Data freshness and heartbeat decisions passed (15 checks)");
  }
}
