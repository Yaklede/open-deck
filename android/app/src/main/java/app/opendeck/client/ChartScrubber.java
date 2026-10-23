package app.opendeck.client;

import java.text.NumberFormat;
import java.util.Locale;

/** Actual-sample lookup and display policy. Never interpolates a metric value. */
public final class ChartScrubber {
  public static final long MAX_SNAP_DISTANCE_MS = 60000;

  private ChartScrubber() {}

  private static boolean valid(long[] times, double[] values, int index) {
    return times != null
        && values != null
        && index >= 0
        && index < times.length
        && index < values.length
        && times[index] > 0
        && Double.isFinite(values[index])
        && values[index] >= 0;
  }

  public static long targetTime(ChartTimeRange range, double fraction) {
    if (range == null || !range.hasRange() || !Double.isFinite(fraction)) return 0;
    return range.first
        + Math.round((range.last - range.first) * Math.max(0, Math.min(1, fraction)));
  }

  public static int nearestIndex(long[] times, double[] values, long target) {
    if (target <= 0 || times == null || values == null) return -1;
    int selected = -1;
    long distance = Long.MAX_VALUE;
    for (int i = 0; i < Math.min(times.length, values.length); i++) {
      if (!valid(times, values, i)) continue;
      long candidateDistance = times[i] >= target ? times[i] - target : target - times[i];
      if (candidateDistance < distance
          || candidateDistance == distance && selected >= 0 && times[i] < times[selected]) {
        distance = candidateDistance;
        selected = i;
      }
    }
    return distance <= MAX_SNAP_DISTANCE_MS ? selected : -1;
  }

  public static int exactIndex(long[] times, double[] values, long timestamp) {
    if (times != null && values != null)
      for (int i = 0; i < Math.min(times.length, values.length); i++)
        if (valid(times, values, i) && times[i] == timestamp) return i;
    return -1;
  }

  public static int adjacentIndex(long[] times, double[] values, long timestamp, boolean forward) {
    int result = -1;
    if (times != null && values != null)
      for (int i = 0; i < Math.min(times.length, values.length); i++) {
        if (!valid(times, values, i)) continue;
        boolean eligible =
            timestamp <= 0 || (forward ? times[i] > timestamp : times[i] < timestamp);
        if (eligible
            && (result < 0 || (forward ? times[i] < times[result] : times[i] > times[result])))
          result = i;
      }
    return result;
  }

  public static String valueText(double value, String metric, Locale locale) {
    if (!Double.isFinite(value) || value < 0) return "—";
    String number;
    if (value > 0 && value < 1e-12) {
      // Preserve a genuinely tiny nonzero value rather than displaying a fabricated zero.
      number = String.format(locale, "%.6g", value);
    } else {
      NumberFormat format = NumberFormat.getNumberInstance(locale);
      format.setGroupingUsed(true);
      format.setMinimumFractionDigits(0);
      format.setMaximumFractionDigits(
          value > 0 && value < 1
              ? Math.max(6, Math.min(17, 5 - (int) Math.floor(Math.log10(value))))
              : 6);
      number = format.format(value);
    }
    String unit = unit(metric);
    return number + (unit.equals("%") ? "" : " ") + unit;
  }

  public static String unit(String metric) {
    switch (metric) {
      case "system":
      case "cpu":
      case "memory":
      case "errorRate":
        return "%";
      case "latency":
        return "ms";
      case "tps":
        return "TPS";
      case "qps":
        return "QPS";
      case "rps":
        return "req/s";
      default:
        return "";
    }
  }
}
