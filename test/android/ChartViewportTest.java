package app.opendeck.client;

public final class ChartViewportTest {
  private static int checks;
  private static final long START = 1792746000123L;
  private static final long HOUR = 3600000;

  private static void check(boolean condition, String description) {
    checks++;
    if (!condition) throw new AssertionError(description);
  }

  private static ChartViewport hour() {
    ChartViewport view = new ChartViewport();
    view.updateBounds(START, START + HOUR);
    return view;
  }

  private static void bounded(ChartViewport view, String description) {
    check(
        view.start() >= view.fullStart()
            && view.end() <= view.fullEnd()
            && view.span() >= Math.min(ChartViewport.MIN_SPAN_MS, view.fullSpan()),
        description);
  }

  public static void main(String[] args) {
    ChartViewport empty = new ChartViewport();
    check(!empty.hasData() && !empty.hasRange() && !empty.isZoomed(), "No invented empty range");
    check(empty.start() == 0 && empty.end() == 0 && empty.span() == 0, "Empty bounds are zero");
    check(empty.timestampAt(.5) == 0 && empty.fraction(START) == 0, "Empty mapping is safe");
    check(!empty.zoomAbout(2, .5) && !empty.panByFraction(1), "Empty gestures do nothing");
    check(!empty.reset() && !empty.clear(), "Empty reset is idempotent");
    check(empty.updateBounds(START, START), "One observed timestamp is accepted");
    check(empty.hasData() && !empty.hasRange(), "Singleton does not invent elapsed time");
    check(empty.timestampAt(.9) == START && empty.fraction(START) == 0, "Singleton maps safely");
    check(!empty.zoomAbout(2, .5) && !empty.panByFraction(-1), "Singleton cannot zoom or pan");
    check(empty.updateBounds(0, START) && !empty.hasData(), "Missing start clears old data");
    check(!empty.updateBounds(START + 1, START), "Reversed bounds stay empty");

    ChartViewport view = hour();
    check(view.fullSpan() == HOUR && view.span() == HOUR, "Initial viewport covers loaded hour");
    check(!view.isZoomed(), "Initial full range is not zoomed");
    check(!view.updateBounds(START, START + HOUR), "Same bounds do not mutate viewport");
    check(view.timestampAt(.5) == START + HOUR / 2, "Exact epoch milliseconds retain origin");
    check(view.fraction(START + HOUR / 4) == .25, "Timestamp mapping is time-proportional");
    check(view.timestampAt(-10) == START, "Left interaction coordinate is clamped");
    check(view.timestampAt(10) == START + HOUR, "Right interaction coordinate is clamped");
    check(view.fraction(Long.MIN_VALUE) == 0, "Extreme past does not overflow fraction");
    check(view.fraction(Long.MAX_VALUE) == 1, "Extreme future does not overflow fraction");
    check(view.timestampAt(Double.NaN) == START, "NaN does not invent a timestamp");
    check(view.timestampAt(Double.POSITIVE_INFINITY) == START, "Infinite input is safe");

    long anchor = view.timestampAt(.25);
    check(view.zoomAbout(2, .25), "Pinch out zooms in");
    check(view.span() == HOUR / 2 && view.isZoomed(), "Zoom halves visible duration");
    check(view.timestampAt(.25) == anchor, "Zoom retains time under finger centroid");
    check(view.start() == START + HOUR / 8, "Off-center zoom positions the viewport correctly");
    check(!view.zoomAbout(1, .25), "Unit scale is a no-op");
    long before = view.start();
    check(!view.zoomAbout(0, .5) && !view.zoomAbout(-1, .5), "Invalid scales are ignored");
    check(!view.zoomAbout(Double.NaN, .5), "NaN scale is ignored");
    check(!view.zoomAbout(Double.POSITIVE_INFINITY, .5), "Infinite scale is ignored");
    check(!view.zoomAbout(2, Double.NaN), "NaN centroid is ignored");
    check(!view.panByFraction(Double.NaN), "NaN pan is ignored");
    check(!view.panByFraction(Double.NEGATIVE_INFINITY), "Infinite pan is ignored");
    check(view.start() == before, "Invalid gestures preserve current view");
    check(view.panByFraction(.125), "Positive finger motion pans toward past");
    check(view.start() == before - HOUR / 16, "Pan displacement uses visible span");
    check(view.panByFraction(-.125) && view.start() == before, "Opposite pan reverses exactly");
    check(view.panByFraction(Double.MAX_VALUE), "Huge finite pan clamps without overflow");
    check(view.start() == START && view.span() == HOUR / 2, "Past edge keeps zoom width");
    check(!view.panByFraction(1), "Past edge does not bounce or wrap");
    check(view.panByFraction(-Double.MAX_VALUE), "Huge future pan clamps safely");
    check(view.end() == START + HOUR && view.span() == HOUR / 2, "Future edge keeps zoom width");
    check(!view.panByFraction(-1), "Future edge does not bounce or wrap");

    check(view.zoomAbout(Double.MAX_VALUE, 1), "Large zoom reaches minimum span");
    check(view.span() == ChartViewport.MIN_SPAN_MS, "Minimum loaded window is five minutes");
    check(view.end() == view.fullEnd(), "Right-edge anchor remains at latest timestamp");
    check(!view.zoomAbout(2, .5), "Minimum span cannot shrink further");
    check(view.zoomAbout(Double.MIN_VALUE, .5), "Tiny factor safely expands to full range");
    check(!view.isZoomed() && view.span() == HOUR, "Zoom out never exceeds loaded history");
    check(!view.panByFraction(.5), "Full-range pan does not move or fetch history");

    ChartViewport shortHistory = new ChartViewport();
    shortHistory.updateBounds(START, START + 120000);
    check(!shortHistory.zoomAbout(100, .5), "History shorter than minimum stays complete");
    check(
        shortHistory.span() == 120000 && !shortHistory.isZoomed(), "Short range retains real span");

    view = hour();
    view.zoomAbout(4, .5);
    view.panByFraction(1);
    long historicalStart = view.start(), historicalEnd = view.end();
    check(view.updateBounds(START + 60000, START + HOUR + 60000), "Rolling data refresh accepted");
    check(
        view.start() == historicalStart && view.end() == historicalEnd,
        "Refresh preserves historical interval instead of snapping to newest point");
    view.updateBounds(START + 600000, START + HOUR + 600000);
    check(
        view.start() == START + 600000 && view.span() == HOUR / 4, "Roll-off clamps only old edge");
    check(view.end() < view.fullEnd(), "Roll-off does not jump to latest data");
    check(view.reset() && !view.isZoomed(), "Stale reset returns to full retained history");
    check(!view.reset(), "Repeated stale reset is idempotent");
    view.updateBounds(START + 660000, START + HOUR + 660000);
    check(
        view.start() == view.fullStart() && view.end() == view.fullEnd(),
        "Unzoomed refresh follows loaded range");
    view.zoomAbout(2, .5);
    view.updateBounds(START, START + 600000);
    check(
        !view.isZoomed() && view.span() == 600000,
        "Shorter replacement history bounds previous window");
    check(
        view.clear() && view.timestampAt(.5) == 0, "Missing data clears retained selection domain");
    view.updateBounds(START, START + HOUR);
    check(!view.isZoomed(), "Data after missing starts in full range");

    view = new ChartViewport();
    view.updateBounds(Long.MAX_VALUE - HOUR, Long.MAX_VALUE);
    check(view.timestampAt(1) == Long.MAX_VALUE, "Extreme positive epoch end never overflows");
    view.zoomAbout(2, .5);
    check(view.span() == HOUR / 2, "Zoom uses offsets rather than rounding a huge epoch");
    view.panByFraction(-Double.MAX_VALUE);
    check(view.end() == Long.MAX_VALUE, "Extreme epoch pan stays within exact long bounds");
    view.updateBounds(1, Long.MAX_VALUE);
    view.reset();
    check(view.timestampAt(1) == Long.MAX_VALUE, "Span rounding is clamped before epoch addition");
    view.zoomAbout(2, .7);
    bounded(view, "Huge loaded interval remains bounded after zoom");

    view = hour();
    for (int i = 0; i < 1000; i++) {
      double center = (i % 101) / 100.0;
      view.zoomAbout(i % 3 == 0 ? .8 : 1.2, center);
      view.panByFraction((i % 7 - 3) * .09);
      if (i % 11 == 0) view.updateBounds(START + i * 1000, START + HOUR + i * 1000);
      if (view.start() < view.fullStart()
          || view.end() > view.fullEnd()
          || view.span() < ChartViewport.MIN_SPAN_MS)
        throw new AssertionError("Repeated mixed gestures escaped loaded bounds at " + i);
    }
    bounded(view, "Repeated gestures and rolling refresh preserve all window invariants");
    System.out.println("ChartViewport: " + checks + " checks passed");
  }
}
