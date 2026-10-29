package app.opendeck.client;

import java.util.Locale;

public final class ChartScrubberTest {
  private static int checks;

  private static void check(boolean condition, String message) {
    checks++;
    if (!condition) throw new AssertionError(message);
  }

  public static void main(String[] args) {
    long start = 1792746000000L;
    long[] times = {start, start + 10000, start + 240000};
    double[] values = {3, 20, 7};
    ChartTimeRange range = ChartTimeRange.from(times, values);
    check(
        ChartScrubber.targetTime(range, .5) == start + 120000,
        "X maps to elapsed time, not array index");
    check(
        ChartScrubber.nearestIndex(times, values, ChartScrubber.targetTime(range, .5)) == -1,
        "A long missing interval never snaps to a distant measured point");
    check(
        ChartScrubber.nearestIndex(times, values, start + 20000) == 1,
        "Near sample is selected without interpolation");
    check(
        ChartScrubber.targetTime(range, -4) == start, "Drag beyond left edge clamps to first time");
    check(
        ChartScrubber.targetTime(range, 4) == start + 240000,
        "Drag beyond right edge clamps to last time");
    check(
        ChartScrubber.targetTime(range, Double.NaN) == 0,
        "Invalid coordinate does not invent time");
    check(ChartScrubber.nearestIndex(times, values, 0) == -1, "Invalid target has no sample");
    check(ChartScrubber.nearestIndex(null, null, start) == -1, "Null samples safe");
    check(ChartScrubber.nearestIndex(new long[0], new double[0], start) == -1, "No samples safe");
    check(
        ChartScrubber.nearestIndex(new long[] {start}, new double[] {0}, start) == 0,
        "Observed zero is selectable");
    check(
        ChartScrubber.nearestIndex(new long[] {start}, new double[] {0}, start + 60001) == -1,
        "Snap distance is bounded");
    long[] unordered = {start + 60000, start, start + 120000};
    double[] unorderedValues = {50, 10, 20};
    check(
        ChartScrubber.nearestIndex(unordered, unorderedValues, start + 30000) == 1,
        "Ties choose earlier actual timestamp, independent of array order");
    check(
        ChartScrubber.exactIndex(unordered, unorderedValues, start + 60000) == 0,
        "Refresh retains timestamp even when index moves");
    check(
        ChartScrubber.exactIndex(new long[] {start + 60000}, new double[] {99}, start) == -1,
        "Rolled-off timestamp clears selection instead of selecting neighbor");
    check(
        ChartScrubber.exactIndex(new long[] {start}, new double[] {Double.NaN}, start) == -1,
        "Now-missing selected value clears selection");
    check(
        ChartScrubber.nearestIndex(
                new long[] {0, start, start + 1000, start + 2000},
                new double[] {999, Double.NaN, -1, 0},
                start)
            == 3,
        "Invalid, missing and negative samples ignored, genuine zero retained");
    check(
        ChartScrubber.nearestIndex(
                new long[] {start}, new double[] {Double.POSITIVE_INFINITY}, start)
            == -1,
        "Infinity never displayed");
    check(
        ChartScrubber.exactIndex(new long[] {start, start}, new double[] {5, 6}, start) == 0,
        "Duplicate timestamp chooses stable actual sample");
    check(
        ChartScrubber.adjacentIndex(unordered, unorderedValues, start, true) == 0,
        "Accessibility advances chronologically");
    check(
        ChartScrubber.adjacentIndex(unordered, unorderedValues, start + 120000, false) == 0,
        "Accessibility reverses chronologically");
    check(
        ChartScrubber.adjacentIndex(unordered, unorderedValues, 0, true) == 1,
        "First accessible sample is earliest");
    check(
        ChartScrubber.adjacentIndex(unordered, unorderedValues, 0, false) == 2,
        "Last accessible sample is latest");
    check(
        ChartScrubber.adjacentIndex(unordered, unorderedValues, start + 120000, true) == -1,
        "No accessibility wrap to wrong end");
    check(
        ChartScrubber.valueText(.003, "errorRate", Locale.US).equals("0.003%"),
        "Small error percentage does not become zero");
    check(
        ChartScrubber.valueText(.000001234567, "errorRate", Locale.US).equals("0.00000123457%"),
        "Tiny value retains six significant digits");
    check(
        !ChartScrubber.valueText(1e-14, "rps", Locale.US).equals("0 req/s"),
        "Extremely small nonzero sample stays nonzero");
    check(
        ChartScrubber.valueText(1234567.123456789, "tps", Locale.US).equals("1,234,567.123457 TPS"),
        "No K/M abbreviation and at most six ordinary decimal places");
    check(
        ChartScrubber.valueText(12.5, "cpu", Locale.GERMANY).equals("12,5%"),
        "Locale decimal separator respected");
    check(
        ChartScrubber.valueText(0, "memory", Locale.US).equals("0%"),
        "Observed zero displayed literally");
    check(
        ChartScrubber.valueText(Double.NaN, "qps", Locale.US).equals("—"),
        "Missing sample not formatted as zero");
    for (String metric : new String[] {"system", "cpu", "memory", "errorRate"})
      check(
          ChartScrubber.valueText(12, metric, Locale.US).equals("12%"), "Percent unit: " + metric);
    for (String[] metric :
        new String[][] {{"latency", "ms"}, {"rps", "req/s"}, {"tps", "TPS"}, {"qps", "QPS"}})
      check(
          ChartScrubber.valueText(12, metric[0], Locale.US).equals("12 " + metric[1]),
          "Explicit unit: " + metric[0]);
    System.out.println("ChartScrubber: " + checks + " checks passed");
  }
}
