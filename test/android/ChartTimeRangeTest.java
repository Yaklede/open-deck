package app.opendeck.client;

public final class ChartTimeRangeTest {
  private static int checks;

  private static void check(boolean value, String description) {
    checks++;
    if (!value) throw new AssertionError(description);
  }

  public static void main(String[] args) {
    long start = 1792746000000L;
    ChartTimeRange range =
        ChartTimeRange.from(
            new long[] {start, start + 60000, start + 240000}, new double[] {10, 80, 20});
    check(range.hasRange(), "Valid samples provide an axis");
    check(range.first == start && range.last == start + 240000, "Axis uses observed boundaries");
    check(range.middle == start + 120000, "Midpoint follows elapsed time, not sample index");
    check(
        range.peakAt == start + 60000 && range.peakValue == 80,
        "Peak uses the spike's actual timestamp");
    check(
        range.fraction(range.peakAt) == .25, "Irregular samples retain time-proportional position");
    check(
        range.fraction(start - 1) == 0 && range.fraction(start + 300000) == 1,
        "Marker clamps within chart");
    ChartTimeRange missing = ChartTimeRange.from(new long[] {0, 0}, new double[] {10, 20});
    check(
        !missing.hasRange() && missing.first == 0 && missing.peakAt == 0,
        "Missing timestamps never invent an axis");
    ChartTimeRange invalid =
        ChartTimeRange.from(
            new long[] {start, start + 60000, start + 120000},
            new double[] {5, Double.NaN, Double.POSITIVE_INFINITY});
    check(
        !invalid.hasRange() && invalid.peakAt == start,
        "Nonfinite values do not create a false late peak");
    ChartTimeRange unsorted =
        ChartTimeRange.from(
            new long[] {start + 120000, start, start + 60000}, new double[] {30, 30, 10});
    check(
        unsorted.first == start && unsorted.last == start + 120000,
        "Out-of-order input preserves bounds");
    check(unsorted.peakAt == start, "Equal peaks choose first actual occurrence consistently");
    check(
        !ChartTimeRange.from(new long[] {start, start}, new double[] {1, 2}).hasRange(),
        "Duplicate instant has no fabricated duration");
    check(!ChartTimeRange.from(null, null).hasRange(), "Null data is safe");
    check(
        !ChartTimeRange.from(new long[] {start}, new double[] {}).hasRange(),
        "Mismatched data is safe");
    ChartTimeRange zero =
        ChartTimeRange.from(new long[] {start, start + 60000}, new double[] {0, 0});
    check(
        zero.hasRange() && zero.peakValue == 0 && zero.peakAt == start,
        "Observed zeros remain valid");
    System.out.println("ChartTimeRange: " + checks + " checks passed");
  }
}
