package app.opendeck.client;

/** One pending or visible utility panel; late callbacks cannot reclaim a closed session. */
final class PanelSession {
  private long revision;
  private boolean active;

  long begin() {
    if (active) return 0;
    active = true;
    return ++revision;
  }

  boolean current(long ticket) {
    return active && ticket == revision;
  }

  void end(long ticket) {
    if (current(ticket)) active = false;
  }
}
