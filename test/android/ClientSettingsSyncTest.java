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
    allSettingsRoundTripAndRestart();
    everyFieldSurvivesInFlightEditAndNewerSnapshot();
    everyFieldKeepsSameValueReedit();
    completeRemoteMapUpdatesEveryOpenControl();
    numericNormalizationAndCancelledInput();
    startupSelectionUsesProfileDefault();
    duplicateNavigationNamesRemainSelectable();
    idleDisableRespectsManualPreview();
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

  private static Map<String, Object> allChangedSettings() {
    Map<String, Object> values = new LinkedHashMap<>();
    values.put("awake", false);
    values.put("orientation", "portrait");
    values.put("theme", "light");
    values.put("language", "ar");
    values.put("allowInsecureWifi", true);
    values.put("timeFormat", "12h");
    values.put("renderMode", "simple");
    values.put("fullscreen", false);
    values.put("brightness", 35);
    values.put("textScale", 117);
    values.put("haptics", false);
    values.put("fixedVibration", true);
    values.put("vibrationMs", 83);
    values.put("sound", true);
    values.put("swipeEnabled", false);
    values.put("reducedMotion", true);
    values.put("showHeader", false);
    values.put("showNavigation", false);
    values.put("settingsButtonHidden", true);
    values.put("screenSaverMinutes", 7);
    values.put("screenSaverMode", "clock");
    values.put("dimPercent", 17);
    values.put("firstTouchWakes", false);
    values.put("rememberPage", false);
    values.put("startPageId", "work-home");
    values.put("profileId", "work");
    values.put("iconResolution", 512);
    values.put("osNotifications", false);
    values.put("monitorNotifications", false);
    values.put("notificationBanner", false);
    return values;
  }

  private static void allSettingsRoundTripAndRestart() {
    Map<String, Object> changed = allChangedSettings();
    equal(
        changed.keySet(),
        ClientSettingsPolicy.defaults().keySet(),
        "all supported keys have explicit non-default fixtures");
    ClientSettingsSync first = new ClientSettingsSync();
    for (Map.Entry<String, Object> item : changed.entrySet()) {
      equal(
          first.edit(item.getKey(), item.getValue()),
          true,
          item.getKey() + " has a non-default local edit");
    }
    equal(first.snapshot().values, changed, "a full-map patch contains every local change");
    ClientSettingsSync restarted = new ClientSettingsSync();
    restarted.restore(new LinkedHashMap<>(first.values()), new LinkedHashMap<>(first.pending()));
    restarted.receive(ClientSettingsPolicy.defaults(), 90);
    for (String key : changed.keySet()) {
      equal(restarted.values().get(key), changed.get(key), key + " survives offline restart");
      equal(
          restarted.pending().get(key),
          changed.get(key),
          key + " remains queued after the old host snapshot");
    }
    ClientSettingsSync.Patch retry = restarted.snapshot();
    restarted.acknowledge(retry);
    restarted.receive(changed, 91);
    equal(
        restarted.pending().isEmpty(), true, "one full-map acknowledgement clears all sent edits");
    ClientSettingsSync cleanRestart = new ClientSettingsSync();
    cleanRestart.restore(
        new LinkedHashMap<>(restarted.values()), new LinkedHashMap<>(restarted.pending()));
    equal(cleanRestart.values(), changed, "all accepted settings survive another app restart");
    cleanRestart.receive(ClientSettingsPolicy.defaults(), 92);
    for (String key : changed.keySet())
      equal(
          cleanRestart.values().get(key),
          ClientSettingsPolicy.defaults().get(key),
          key + " accepts a later Mac edit after restart");
  }

  private static void everyFieldSurvivesInFlightEditAndNewerSnapshot() {
    Map<String, Object> changed = allChangedSettings(), defaults = ClientSettingsPolicy.defaults();
    for (String key : changed.keySet()) {
      ClientSettingsSync sync = new ClientSettingsSync();
      sync.receive(defaults, 1);
      sync.edit(key, changed.get(key));
      ClientSettingsSync.Patch sent = sync.snapshot();
      Map<String, Object> putResponse = new LinkedHashMap<>(defaults);
      putResponse.put(key, changed.get(key));
      Map<String, Object> newestHost = new LinkedHashMap<>(changed);
      newestHost.put(key, defaults.get(key));
      sync.receive(putResponse, 2);
      sync.receive(newestHost, 3);
      equal(
          sync.values().get(key),
          changed.get(key),
          key + " keeps pending intent over a racing Mac snapshot");
      sync.acknowledge(sent);
      sync.receive(putResponse, 2);
      equal(
          sync.values(),
          newestHost,
          key + " reconciles the latest full host map after a delayed ACK");
      equal(sync.pending().isEmpty(), true, key + " old request acknowledgement is complete");
    }
  }

  private static void everyFieldKeepsSameValueReedit() {
    ClientSettingsSync sync = new ClientSettingsSync();
    Map<String, Object> changed = allChangedSettings(), defaults = ClientSettingsPolicy.defaults();
    changed.forEach(sync::queue);
    ClientSettingsSync.Patch first = sync.snapshot();
    defaults.forEach(sync::queue);
    changed.forEach(sync::queue);
    sync.receive(defaults, 6);
    sync.acknowledge(first);
    sync.receive(changed, 5);
    for (String key : changed.keySet()) {
      equal(
          sync.pending().get(key),
          changed.get(key),
          key + " same-value later edit is not cleared by the old ACK");
      equal(sync.values().get(key), changed.get(key), key + " latest local edit stays visible");
    }
  }

  private static void completeRemoteMapUpdatesEveryOpenControl() {
    ClientSettingsSync sync = new ClientSettingsSync();
    Map<String, Object> displayed = new LinkedHashMap<>();
    Map<String, SettingsControlBinding> bindings = new LinkedHashMap<>();
    for (String key : ClientSettingsPolicy.defaults().keySet()) {
      SettingsControlBinding binding =
          new SettingsControlBinding(
              () -> sync.values().get(key), value -> displayed.put(key, value));
      bindings.put(key, binding);
      binding.refresh();
    }
    sync.receive(allChangedSettings(), 2);
    bindings.values().forEach(SettingsControlBinding::refresh);
    for (String key : allChangedSettings().keySet())
      equal(
          displayed.get(key),
          allChangedSettings().get(key),
          key + " open binding displays its remote value");
    equal(sync.pending().isEmpty(), true, "remote rendering of all controls does not queue edits");
  }

  private static void numericNormalizationAndCancelledInput() {
    ClientSettingsSync sync = new ClientSettingsSync();
    sync.receive(
        Map.of(
            "brightness",
            35L,
            "textScale",
            117.0,
            "vibrationMs",
            83L,
            "dimPercent",
            17.0,
            "screenSaverMinutes",
            7L),
        1);
    for (String key :
        new String[] {
          "brightness", "textScale", "vibrationMs", "dimPercent", "screenSaverMinutes"
        }) {
      equal(
          sync.values().get(key).getClass(),
          Integer.class,
          key + " JSON numeric representation is normalized");
      equal(
          sync.values().get(key),
          allChangedSettings().get(key),
          key + " keeps its exact integer value");
    }
    equal(
        ClientSettingsPolicy.parseNumericInput("brightness", " -1 "),
        -1,
        "system brightness sentinel remains supported");
    equal(
        ClientSettingsPolicy.parseNumericInput("brightness", "35"),
        35,
        "custom brightness accepts non-preset values");
    equal(
        ClientSettingsPolicy.parseNumericInput("screenSaverMinutes", "120"),
        120,
        "maximum custom idle interval is available");
    for (String input : new String[] {"", "1.5", "abc", "121", "999999999999999999"}) {
      boolean rejected = false;
      try {
        ClientSettingsPolicy.parseNumericInput("screenSaverMinutes", input);
      } catch (IllegalArgumentException expected) {
        rejected = true;
      }
      equal(rejected, true, "invalid custom input is rejected: " + input);
    }
    AtomicReference<Object> displayed = new AtomicReference<>();
    SettingsControlBinding binding =
        new SettingsControlBinding(() -> sync.values().get("brightness"), displayed::set);
    binding.refresh();
    binding.beginEdit(); // Opening and typing in the number prompt does not commit.
    sync.receive(Map.of("brightness", 42), 2);
    binding.refresh();
    equal(displayed.get(), 35, "typing is not overwritten by a Mac update");
    binding.endEdit(); // Cancel, with no binding.change call.
    equal(displayed.get(), 42, "cancel returns to the latest Mac value");
    equal(sync.pending().isEmpty(), true, "cancel never saves the typed number");
  }

  private static void startupSelectionUsesProfileDefault() {
    java.util.List<String> pages = java.util.List.of("first", "preferred", "remembered");
    equal(
        ProfileNavigation.startupPage(false, "remembered", "", "preferred", pages),
        "preferred",
        "disabled remember uses the profile default even when not first");
    equal(
        ProfileNavigation.startupPage(true, "remembered", "first", "preferred", pages),
        "remembered",
        "valid remembered page takes precedence");
    equal(
        ProfileNavigation.startupPage(false, "remembered", "first", "preferred", pages),
        "first",
        "explicit startup page takes precedence over the profile default");
    equal(
        ProfileNavigation.startupPage(true, "removed", "", "preferred", pages),
        "preferred",
        "removed remembered page falls back to the profile default");
    equal(
        ProfileNavigation.startupPage(false, "", "removed", "preferred", pages),
        "preferred",
        "invalid explicit page falls back safely");
    equal(
        ProfileNavigation.startupPage(false, "", "", "removed", pages),
        "first",
        "only invalid profile defaults use the first available page");
    equal(
        ProfileNavigation.startupPage(false, "", "", "", java.util.List.of()),
        "",
        "empty profiles do not produce an invalid navigation target");
  }

  private static void duplicateNavigationNamesRemainSelectable() {
    Map<String, String> names = new LinkedHashMap<>();
    names.put("work", "Work");
    names.put("work-copy", "Work");
    names.put("default-copy", "Follow Mac");
    names.put("literal", "Work · work");
    Map<String, String> options = ProfileNavigation.choices("Follow Mac", names);
    equal(options.size(), 5, "all same-name entries and the default remain selectable");
    equal(options.get("Follow Mac"), "", "reserved default cannot be overwritten");
    equal(options.get("Work · work"), "work", "first duplicate includes its stable ID");
    equal(options.get("Work · work-copy"), "work-copy", "second duplicate includes its own ID");
    equal(
        options.get("Follow Mac · default-copy"),
        "default-copy",
        "same name as default remains selectable");
    equal(options.containsValue("literal"), true, "literal suffix collisions cannot drop a page");
  }

  private static void idleDisableRespectsManualPreview() {
    equal(
        ClientSettingsPolicy.shouldWakeAfterIdleChange(7, 0, true),
        true,
        "disabling automatic idle wakes an automatically dimmed screen");
    equal(
        ClientSettingsPolicy.shouldWakeAfterIdleChange(7, 0, false),
        false,
        "manual preview survives a change to automatic idle settings");
    equal(
        ClientSettingsPolicy.shouldWakeAfterIdleChange(0, 0, true),
        false,
        "unrelated setting snapshots cannot wake an already disabled idle timer");
    equal(
        ClientSettingsPolicy.shouldWakeAfterIdleChange(7, 8, true),
        false,
        "changing an enabled delay does not dismiss the current screen saver");
  }
}
