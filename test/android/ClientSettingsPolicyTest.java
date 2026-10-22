package app.opendeck.client;

import java.util.Map;

public final class ClientSettingsPolicyTest {
  private static int checks;

  private static void check(boolean test, String message) {
    checks++;
    if (!test) throw new AssertionError(message);
  }

  private static void rejects(String key, Object value) {
    try {
      ClientSettingsPolicy.validate(key, value);
      throw new AssertionError(key + " accepted " + value);
    } catch (IllegalArgumentException expected) {
      checks++;
    }
  }

  public static void main(String[] args) {
    for (Map.Entry<String, Object> setting : ClientSettingsPolicy.defaults().entrySet())
      check(
          setting
              .getValue()
              .equals(ClientSettingsPolicy.validate(setting.getKey(), setting.getValue())),
          "valid default " + setting.getKey());
    check(
        Boolean.TRUE.equals(ClientSettingsPolicy.defaults().get("awake")),
        "keep existing keep-awake behavior");
    check(
        ClientSettingsPolicy.defaults().get("screenSaverMinutes").equals(0), "idle dim is opt-in");
    check(
        ClientSettingsPolicy.defaults().get("firstTouchWakes").equals(true),
        "wake tap never runs action by default");
    rejects("textScale", 79);
    rejects("textScale", 161);
    rejects("textScale", 100.5);
    rejects("brightness", -2);
    rejects("brightness", 101);
    rejects("dimPercent", 4);
    rejects("vibrationMs", 201);
    rejects("iconResolution", 1024);
    rejects("awake", "true");
    rejects("token", "secret");
    rejects("orientation", "sideways");
    rejects("screenSaverMode", "browser");
    rejects("profileId", "a\nb");
    rejects("timeFormat", "seconds");
    check(ClientSettingsPolicy.validWifiUrl("https://192.168.0.10:8841"), "existing WiFi address");
    check(ClientSettingsPolicy.validWifiUrl("https://10.0.0.2:9443"), "custom TLS port");
    check(!ClientSettingsPolicy.validWifiUrl("http://192.168.0.10:8841"), "reject plaintext WiFi");
    check(
        !ClientSettingsPolicy.validWifiUrl("https://token@192.168.0.10:8841"),
        "reject embedded credentials");
    check(
        !ClientSettingsPolicy.validWifiUrl("https://192.168.0.10:8841/?token=x"),
        "reject credential query");
    check(
        !ClientSettingsPolicy.validWifiUrl("https://192.168.999.10:8841"),
        "reject invalid IP octets");
    check(
        !ClientSettingsPolicy.validWifiUrl("https://example.com:8841"),
        "reject arbitrary public host");
    check(!ClientSettingsPolicy.shouldDim(119999, 0, 2, true), "not before deadline");
    check(ClientSettingsPolicy.shouldDim(120000, 0, 2, true), "exact idle deadline");
    check(!ClientSettingsPolicy.shouldDim(120000, 0, 2, false), "background app never dims");
    check(!ClientSettingsPolicy.shouldDim(120000, 0, 0, true), "disabled idle");
    check(!ClientSettingsPolicy.shouldDim(100, 200, 1, true), "clock rollback safe");
    check(ClientSettingsPolicy.brightness(-1, false, 10) == -1f, "restore system brightness");
    check(
        ClientSettingsPolicy.brightness(5, true, 10) == .05f,
        "dim never raises configured brightness");
    check(ClientSettingsPolicy.brightness(80, true, 10) == .1f, "dim percent applies");
    check(ClientSettingsPolicy.brightness(80, false, 10) == .8f, "restore exact override");
    check(ClientSettingsPolicy.acceptRevision(0, -1), "accept first server settings");
    check(ClientSettingsPolicy.acceptRevision(12, 11), "accept newer remote settings");
    check(
        !ClientSettingsPolicy.acceptRevision(11, 12),
        "late PUT response cannot roll back newer remote settings");
    check(!ClientSettingsPolicy.acceptRevision(12, 12), "repeated SSE settings do not repaint");
    WakeInteractionGuard guard = new WakeInteractionGuard();
    check(guard.beginTouch(true, true, false), "dimmed first down wakes only");
    check(guard.consumeTouch(false), "wake move cannot activate a slider");
    check(guard.consumeTouch(true), "wake release cannot click a button");
    check(!guard.beginTouch(false, true, false), "next tap operates normally");
    check(!guard.consumeTouch(true), "next release operates normally");
    check(guard.beginTouch(true, false, true), "clock always swallows waking tap");
    check(guard.consumeTouch(true), "clock wake completes");
    check(!guard.beginTouch(true, false, false), "explicit dim-only pass-through is respected");
    check(guard.consumeKey(4, true, true, true, false), "Back down wakes instead of leaving");
    check(guard.consumeKey(4, false, false, true, false), "Back up remains swallowed after wake");
    check(!guard.consumeKey(4, true, false, true, false), "later Back works normally");
    check(
        ClientSettingsPolicy.iconResolution(96, 0) == 128,
        "small automatic icons do not allocate 512px");
    check(
        ClientSettingsPolicy.iconResolution(192, 0) == 256,
        "tablet automatic icons preserve detail");
    check(
        ClientSettingsPolicy.iconResolution(400, 0) == 512,
        "large automatic icons preserve detail");
    check(
        ClientSettingsPolicy.iconResolution(400, 128) == 128,
        "explicit low-memory icon size is honored");
    java.util.Map<String, java.util.List<String>> profiles = new java.util.LinkedHashMap<>();
    profiles.put("work", java.util.List.of("workspace", "shared"));
    profiles.put("os", java.util.List.of("jimin-os-page", "shared"));
    check(
        ProfileNavigation.targetProfile("jimin-os-page", "work", "work", profiles).equals("os"),
        "shared navigation can switch to owning profile");
    check(
        ProfileNavigation.targetProfile("shared", "os", "work", profiles).equals("os"),
        "shared page stays in selected profile");
    check(
        ProfileNavigation.targetProfile("workspace", "", "work", profiles).equals("work"),
        "empty selection follows host default profile");
    check(
        ProfileNavigation.targetProfile("unknown-page", "work", "work", profiles) == null,
        "unknown intent cannot invent a profile/page");
    System.out.println("Client settings policy: " + checks + " checks passed");
  }
}
