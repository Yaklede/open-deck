package app.opendeck.client;

public final class PanelSessionTest {
  private static void check(boolean condition, String message) {
    if (!condition) throw new AssertionError(message);
  }

  public static void main(String[] args) {
    PanelSession session = new PanelSession();
    long opening = session.begin();
    check(opening > 0, "First tap owns the pending panel");
    for (int i = 0; i < 100; i++)
      check(session.begin() == 0, "Rapid taps cannot queue more panels");
    check(session.current(opening), "The initial request can show its result");
    session.end(opening);
    check(!session.current(opening), "Closing the loading panel cancels late results");
    long next = session.begin();
    check(next > opening, "A later tap gets a new generation");
    session.end(opening);
    check(session.current(next), "A delayed old dismiss cannot close the new panel");
    check(!session.current(opening), "Old network callbacks cannot reopen a modal");
    session.end(next);
    check(!session.current(next), "Activity cleanup invalidates the current panel");
    System.out.println(
        "PanelSession: rapid taps, late responses and delayed dismiss checks passed");
  }
}
