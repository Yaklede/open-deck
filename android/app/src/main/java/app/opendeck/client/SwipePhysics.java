package app.opendeck.client;

/** Pure gesture decisions; distances and velocities use the caller's pixel units. */
final class SwipePhysics {
  private SwipePhysics() {}

  static float offset(float distance, float width, boolean adjacent) {
    if (width <= 0) return 0;
    if (adjacent) return Math.max(-width, Math.min(width, distance));
    return Math.signum(distance)
        * width
        * .16f
        * (1f - (float) Math.exp(-Math.abs(distance) / (width * .5f)));
  }

  static float distance(float offset, float width, boolean adjacent) {
    if (width <= 0) return 0;
    if (adjacent) return offset;
    float fraction = Math.min(.9999f, Math.abs(offset) / (width * .16f));
    return -Math.signum(offset) * width * .5f * (float) Math.log(1 - fraction);
  }

  static boolean commit(
      float offset,
      float velocity,
      float width,
      float minTravel,
      float minVelocity,
      boolean adjacent) {
    if (!adjacent || width <= 0 || Math.abs(offset) < minTravel) return false;
    if (Math.abs(velocity) >= minVelocity) return Math.signum(offset) == Math.signum(velocity);
    return Math.abs(offset) >= width * .30f;
  }

  static long duration(float from, float to, float velocity, float width) {
    float distance = Math.abs(to - from);
    float duration =
        Math.abs(velocity) > 1
            ? distance / Math.abs(velocity) * 700
            : 140 + 140 * distance / Math.max(1, width);
    return Math.round(Math.max(120, Math.min(280, duration)));
  }
}
