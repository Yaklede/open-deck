package app.opendeck.client;

/** Prevents the wake gesture (including its release event) from activating a deck control. */
public final class WakeInteractionGuard {
  private boolean touch;
  private int key = -1;

  public boolean beginTouch(boolean dimmed, boolean firstTouchWakes, boolean clock) {
    touch = dimmed && (firstTouchWakes || clock);
    return touch;
  }

  public boolean consumeTouch(boolean finished) {
    boolean consumed = touch;
    if (finished) touch = false;
    return consumed;
  }

  public boolean consumeKey(
      int code, boolean down, boolean dimmed, boolean firstTouchWakes, boolean clock) {
    if (key == code) {
      if (!down) key = -1;
      return true;
    }
    if (down && dimmed && (firstTouchWakes || clock)) {
      key = code;
      return true;
    }
    return false;
  }
}
