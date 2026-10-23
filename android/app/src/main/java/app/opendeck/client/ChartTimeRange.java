package app.opendeck.client;

/** A time axis and peak derived only from observed, finite chart samples. */
public final class ChartTimeRange {
  public final long first, middle, last, peakAt;
  public final double peakValue;
  public final int samples;

  private ChartTimeRange(long first, long last, long peakAt, double peakValue, int samples) {
    this.first = first;
    this.middle = first + (last - first) / 2;
    this.last = last;
    this.peakAt = peakAt;
    this.peakValue = peakValue;
    this.samples = samples;
  }

  public boolean hasRange() {
    return samples >= 2 && last > first;
  }

  public static ChartTimeRange from(long[] timestamps, double[] values) {
    long first = Long.MAX_VALUE, last = 0, peakAt = 0;
    double peak = Double.NEGATIVE_INFINITY;
    int samples = 0;
    if (timestamps != null && values != null)
      for (int i = 0; i < Math.min(timestamps.length, values.length); i++) {
        long at = timestamps[i];
        double value = values[i];
        if (at <= 0 || !Double.isFinite(value) || value < 0) continue;
        first = Math.min(first, at);
        last = Math.max(last, at);
        if (value > peak || value == peak && at < peakAt) {
          peak = value;
          peakAt = at;
        }
        samples++;
      }
    return new ChartTimeRange(
        samples == 0 ? 0 : first, last, peakAt, samples == 0 ? Double.NaN : peak, samples);
  }

  public double fraction(long at) {
    return hasRange() ? Math.max(0, Math.min(1, (at - first) / (double) (last - first))) : 0;
  }
}
