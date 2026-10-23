package app.opendeck.client;

public final class SwipePhysicsTest {
  private static void check(boolean condition, String message) {
    if (!condition) throw new AssertionError(message);
  }

  public static void main(String[] args) {
    check(SwipePhysics.offset(300, 1000, true) == 300, "drag tracks the finger exactly");
    check(SwipePhysics.offset(-600, 1000, true) == -600, "leftward drag tracks exactly");
    check(SwipePhysics.offset(1300, 1000, true) == 1000, "at most one page per gesture");
    check(
        SwipePhysics.offset(300, 1000, false) > 0 && SwipePhysics.offset(300, 1000, false) < 100,
        "edge has resistance");
    check(!SwipePhysics.commit(200, 0, 1000, 24, 650, true), "short slow drag snaps back");
    check(SwipePhysics.commit(350, 0, 1000, 24, 650, true), "long slow drag commits");
    check(SwipePhysics.commit(-350, 0, 1000, 24, 650, true), "long left drag commits");
    check(SwipePhysics.commit(50, 900, 1000, 24, 650, true), "short deliberate fling commits");
    check(SwipePhysics.commit(-50, -900, 1000, 24, 650, true), "left fling commits");
    check(!SwipePhysics.commit(10, 900, 1000, 24, 650, true), "tiny jitter is not a fling");
    check(!SwipePhysics.commit(500, -900, 1000, 24, 650, true), "fling back cancels a long drag");
    check(!SwipePhysics.commit(-500, 900, 1000, 24, 650, true), "reverse left drag cancels");
    check(!SwipePhysics.commit(500, 900, 1000, 24, 650, false), "no page beyond the edge");
    check(
        SwipePhysics.duration(800, 1000, 0, 1000) < SwipePhysics.duration(100, 1000, 0, 1000),
        "settle scales with remaining distance");
    check(SwipePhysics.duration(0, 1000, 99999, 1000) >= 120, "fast settle stays readable");
    check(
        SwipePhysics.duration(0, 1000, 2, 1000) <= 280,
        "slow release never queues a long animation");
    check(
        Math.abs(SwipePhysics.distance(SwipePhysics.offset(300, 1000, false), 1000, false) - 300)
            < .01f,
        "grabbing edge settle preserves position");
    check(SwipePhysics.distance(-300, 1000, true) == -300, "grabbing a page preserves its offset");
    System.out.println("Swipe gesture decisions passed (18 checks)");
  }
}
