package app.opendeck.client;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

public final class ClientSettingsSyncTest {
  private static int checks;

  private static void equal(Object actual, Object expected, String description) {
    checks++;
    if (!java.util.Objects.equals(actual, expected))
      throw new AssertionError(description + ": expected " + expected + ", got " + actual);
  }

  public static void main(String[] args) {
    newerHostChangeBeforePutResponse();
    newerLocalEditWithSameValue();
    offlineEditsSurviveRestart();
    unrelatedChangesAreMerged();
    removedNavigationDoesNotBlockOtherOfflineEdits();
    openSwitchTracksRemoteWithoutSaving();
    sliderDefersRemoteUntilGestureEnds();
    sliderCommitKeepsNewUserIntent();
    System.out.println("Client settings synchronization: " + checks + " checks passed");
  }

  private static void newerHostChangeBeforePutResponse() {
    ClientSettingsSync sync = new ClientSettingsSync();
    sync.receive(Map.of("brightness", 20), 1);
    sync.edit("brightness", 80);
    ClientSettingsSync.Patch sent = sync.snapshot();
    sync.receive(Map.of("brightness", 80), 2); // SSE echo arrives ahead of the PUT response.
    sync.receive(Map.of("brightness", 50), 3); // The Mac edits the same value meanwhile.
    equal(sync.values().get("brightness"), 80, "unacknowledged local intent remains visible");
    sync.acknowledge(sent);
    sync.receive(Map.of("brightness", 80), 2); // Delayed response must reconcile the newer shadow.
    equal(sync.values().get("brightness"), 50, "latest Mac value survives an older PUT response");
    equal(sync.revision(), 3L, "response cannot roll the host revision back");
    equal(sync.pending().isEmpty(), true, "acknowledged local edit is removed");
    sync.receive(Map.of("brightness", 50), 3);
    equal(sync.values().get("brightness"), 50, "repeated SSE does not regress the value");
  }

  private static void newerLocalEditWithSameValue() {
    ClientSettingsSync sync = new ClientSettingsSync();
    sync.edit("textScale", 120);
    ClientSettingsSync.Patch first = sync.snapshot();
    sync.edit("textScale", 140);
    sync.edit("textScale", 120); // Same value as first request, but a new user decision.
    sync.receive(Map.of("textScale", 90), 3);
    sync.acknowledge(first);
    sync.receive(Map.of("textScale", 120), 2);
    equal(sync.pending().get("textScale"), 120, "old ACK cannot erase A-to-B-to-A edit");
    equal(sync.values().get("textScale"), 120, "latest local intent remains visible");
    ClientSettingsSync.Patch latest = sync.snapshot();
    sync.acknowledge(latest);
    sync.receive(Map.of("textScale", 120), 4);
    equal(sync.pending().isEmpty(), true, "latest ACK clears only the current edit");
  }

  private static void offlineEditsSurviveRestart() {
    ClientSettingsSync before = new ClientSettingsSync();
    before.receive(Map.of("brightness", 25, "sound", false), 9);
    before.edit("brightness", 75);
    before.edit("sound", true);
    Map<String, Object> saved = new LinkedHashMap<>(before.values());
    Map<String, Object> outstanding = new LinkedHashMap<>(before.pending());
    ClientSettingsSync restarted = new ClientSettingsSync();
    restarted.restore(saved, outstanding);
    restarted.receive(Map.of("brightness", 50, "sound", false, "haptics", false), 10);
    equal(restarted.values().get("brightness"), 75, "restart preserves unsent brightness");
    equal(restarted.values().get("sound"), true, "restart preserves unsent switch");
    equal(restarted.values().get("haptics"), false, "unrelated host changes still apply");
    equal(
        restarted.snapshot().values,
        outstanding,
        "reconnection retries the original pending patch");
    ClientSettingsSync.Patch retried = restarted.snapshot();
    restarted.acknowledge(retried);
    restarted.receive(Map.of("brightness", 75, "sound", true, "haptics", false), 11);
    equal(restarted.pending().isEmpty(), true, "retry succeeds after restart");
    ClientSettingsSync secondRestart = new ClientSettingsSync();
    secondRestart.restore(restarted.values(), restarted.pending());
    equal(secondRestart.values().get("brightness"), 75, "acknowledged value also survives restart");
    equal(secondRestart.pending().isEmpty(), true, "successful edits are not resent after restart");
  }

  private static void unrelatedChangesAreMerged() {
    ClientSettingsSync sync = new ClientSettingsSync();
    sync.edit("sound", true);
    ClientSettingsSync.Patch sent = sync.snapshot();
    sync.receive(Map.of("sound", false, "orientation", "portrait", "textScale", 150), 20);
    equal(sync.values().get("sound"), true, "only pending keys override host values");
    equal(sync.values().get("orientation"), "portrait", "host orientation updates immediately");
    sync.edit("showNavigation", false);
    sync.acknowledge(sent);
    sync.receive(Map.of("sound", true, "orientation", "landscape", "textScale", 100), 19);
    equal(
        sync.values().get("orientation"),
        "portrait",
        "stale response cannot overwrite another key");
    equal(
        sync.pending(), Map.of("showNavigation", false), "ACK preserves later edits to other keys");
  }

  private static void openSwitchTracksRemoteWithoutSaving() {
    AtomicReference<Object> model = new AtomicReference<>(false);
    AtomicReference<Object> view = new AtomicReference<>();
    AtomicInteger writes = new AtomicInteger();
    SettingsControlBinding[] binding = new SettingsControlBinding[1];
    binding[0] =
        new SettingsControlBinding(
            model::get,
            value -> {
              view.set(value);
              // Android Switch.setChecked invokes its listener for programmatic changes too.
              binding[0].change(value, ignored -> writes.incrementAndGet());
            });
    binding[0].refresh();
    model.set(true);
    binding[0].refresh();
    equal(view.get(), true, "an already-open switch reflects the Mac value");
    equal(writes.get(), 0, "programmatic rendering never creates a network write");
    binding[0].change(
        false,
        value -> {
          model.set(value);
          writes.incrementAndGet();
        });
    equal(writes.get(), 1, "a real user switch change is saved exactly once");
  }

  private static void removedNavigationDoesNotBlockOtherOfflineEdits() {
    ClientSettingsSync sync = new ClientSettingsSync();
    sync.receive(Map.of("profileId", "main", "startPageId", "home"), 1);
    sync.queue("profileId", "removed");
    sync.queue("startPageId", "removed-page");
    sync.edit("sound", true);
    sync.receive(Map.of("profileId", "main", "startPageId", "home", "sound", false), 2);
    sync.reconcileNavigation(Map.of("main", java.util.List.of("home")), "main");
    equal(
        sync.values().get("profileId"),
        "main",
        "deleted pending profile falls back to current host profile");
    equal(sync.values().get("startPageId"), "home", "deleted page falls back to valid host page");
    equal(
        sync.pending(),
        Map.of("sound", true),
        "invalid navigation cannot poison unrelated offline edits");
    sync.queue("profileId", "work");
    sync.queue("startPageId", "work-home");
    sync.reconcileNavigation(
        Map.of("main", java.util.List.of("home"), "work", java.util.List.of("work-home")), "main");
    equal(sync.pending().get("profileId"), "work", "valid offline profile intent remains queued");
    equal(
        sync.pending().get("startPageId"), "work-home", "valid offline page intent remains queued");
  }

  private static void sliderDefersRemoteUntilGestureEnds() {
    AtomicReference<Object> model = new AtomicReference<>(100);
    AtomicReference<Object> view = new AtomicReference<>();
    SettingsControlBinding binding = new SettingsControlBinding(model::get, view::set);
    binding.refresh();
    binding.beginEdit();
    view.set(130); // A finger is moving; no commit yet.
    model.set(80);
    binding.refresh();
    equal(view.get(), 130, "remote refresh does not move the slider under the finger");
    model.set(90);
    binding.endEdit(); // Gesture cancelled; no new local setting.
    equal(view.get(), 90, "after cancellation the latest remote value is rendered");
  }

  private static void sliderCommitKeepsNewUserIntent() {
    ClientSettingsSync sync = new ClientSettingsSync();
    AtomicReference<Object> view = new AtomicReference<>();
    SettingsControlBinding binding =
        new SettingsControlBinding(() -> sync.values().get("textScale"), view::set);
    binding.refresh();
    binding.beginEdit();
    view.set(140);
    sync.receive(Map.of("textScale", 90), 2);
    binding.refresh();
    binding.change(140, value -> sync.edit("textScale", value));
    binding.endEdit();
    equal(view.get(), 140, "gesture commit wins over a host value received during dragging");
    equal(sync.pending().get("textScale"), 140, "committed gesture is queued for the Mac");
  }
}
