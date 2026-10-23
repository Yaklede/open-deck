package app.opendeck.client;

/** Mutable time window over already-loaded chart history. Does not fetch or invent samples. */
public final class ChartViewport {
  public static final long MIN_SPAN_MS = 5 * 60 * 1000;

  private long fullStart, fullEnd, start, end;

  public boolean hasData() {
    return fullStart > 0;
  }

  public boolean hasRange() {
    return hasData() && fullEnd > fullStart;
  }

  public long start() {
    return start;
  }

  public long end() {
    return end;
  }

  public long fullStart() {
    return fullStart;
  }

  public long fullEnd() {
    return fullEnd;
  }

  public long span() {
    return end - start;
  }

  public long fullSpan() {
    return fullEnd - fullStart;
  }

  public boolean isZoomed() {
    return hasRange() && span() < fullSpan();
  }

  /** Invalid or missing bounds clear the window; one real timestamp is a valid singleton. */
  public boolean updateBounds(long first, long last) {
    if (first <= 0 || last < first) return clear();
    if (first == fullStart && last == fullEnd) return false;
    boolean keepWindow = isZoomed();
    long previousStart = start, previousSpan = span();
    fullStart = first;
    fullEnd = last;
    if (keepWindow) {
      // Preserve the historical interval, moving it only when retained history has rolled off.
      long nextSpan = Math.min(fullSpan(), Math.max(minSpan(), previousSpan));
      setWindow(previousStart, nextSpan);
    } else {
      start = fullStart;
      end = fullEnd;
    }
    return true;
  }

  /** Return to the complete loaded range, including after a stale-data transition. */
  public boolean reset() {
    boolean changed = start != fullStart || end != fullEnd;
    start = fullStart;
    end = fullEnd;
    return changed;
  }

  public boolean clear() {
    boolean changed = hasData();
    fullStart = fullEnd = start = end = 0;
    return changed;
  }

  /** Factors above one zoom in, keeping the timestamp under the anchor fixed until an edge. */
  public boolean zoomAbout(double factor, double anchorFraction) {
    if (!hasRange()
        || !Double.isFinite(factor)
        || factor <= 0
        || factor == 1
        || !Double.isFinite(anchorFraction)) return false;
    double anchor = Math.max(0, Math.min(1, anchorFraction));
    double requested = span() / factor;
    long nextSpan =
        requested >= fullSpan()
            ? fullSpan()
            : requested <= minSpan()
                ? minSpan()
                : Math.max(minSpan(), Math.min(fullSpan(), Math.round(requested)));
    if (nextSpan == span()) return false;
    long anchorAt = start + offset(span(), anchor);
    return setWindow(anchorAt - offset(nextSpan, anchor), nextSpan);
  }

  /** Positive finger motion moves the visible window into the past. */
  public boolean panByFraction(double delta) {
    if (!isZoomed() || !Double.isFinite(delta) || delta == 0) return false;
    if (delta > 0) {
      long shift = Math.min(start - fullStart, Math.round(span() * delta));
      if (shift == 0) return false;
      start -= shift;
      end -= shift;
    } else {
      long shift = Math.min(fullEnd - end, Math.round(span() * -delta));
      if (shift == 0) return false;
      start += shift;
      end += shift;
    }
    return true;
  }

  /** Clamped coordinate for interactions; renderers may calculate an unclamped coordinate. */
  public double fraction(long timestamp) {
    if (span() <= 0 || timestamp <= start) return 0;
    if (timestamp >= end) return 1;
    return (timestamp - start) / (double) span();
  }

  /** Epoch arithmetic uses offsets from the start, avoiding rounding the absolute epoch. */
  public long timestampAt(double fraction) {
    if (!hasData()) return 0;
    if (!Double.isFinite(fraction)) return start;
    return start + offset(span(), Math.max(0, Math.min(1, fraction)));
  }

  private long minSpan() {
    return Math.min(MIN_SPAN_MS, fullSpan());
  }

  private static long offset(long span, double fraction) {
    return Math.max(0, Math.min(span, Math.round(span * fraction)));
  }

  private boolean setWindow(long requestedStart, long requestedSpan) {
    long nextStart = Math.max(fullStart, Math.min(fullEnd - requestedSpan, requestedStart));
    long nextEnd = nextStart + requestedSpan;
    boolean changed = nextStart != start || nextEnd != end;
    start = nextStart;
    end = nextEnd;
    return changed;
  }
}
