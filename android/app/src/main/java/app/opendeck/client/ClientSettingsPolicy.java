package app.opendeck.client;

import java.net.URI;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/** Shared validation for local preferences and authenticated host device settings. */
public final class ClientSettingsPolicy {
  private ClientSettingsPolicy() {}

  public static Map<String, Object> defaults() {
    Map<String, Object> v = new LinkedHashMap<>();
    v.put("awake", true);
    v.put("orientation", "auto");
    v.put("theme", "system");
    v.put("language", "system");
    v.put("allowInsecureWifi", false);
    v.put("timeFormat", "24h");
    v.put("renderMode", "standard");
    v.put("fullscreen", true);
    v.put("brightness", -1);
    v.put("textScale", 100);
    v.put("haptics", true);
    v.put("fixedVibration", false);
    v.put("vibrationMs", 80);
    v.put("sound", false);
    v.put("swipeEnabled", true);
    v.put("reducedMotion", false);
    v.put("showHeader", true);
    v.put("showNavigation", true);
    v.put("settingsButtonHidden", false);
    v.put("screenSaverMinutes", 0);
    v.put("screenSaverMode", "dim");
    v.put("dimPercent", 10);
    v.put("firstTouchWakes", true);
    v.put("rememberPage", true);
    v.put("startPageId", "");
    v.put("profileId", "");
    v.put("iconResolution", 0);
    v.put("osNotifications", true);
    v.put("monitorNotifications", true);
    v.put("notificationBanner", true);
    return v;
  }

  public static Object validate(String key, Object value) {
    Object fallback = defaults().get(key);
    if (fallback == null || value == null) throw new IllegalArgumentException("지원하지 않는 기기 설정입니다.");
    if (fallback instanceof Boolean) {
      if (!(value instanceof Boolean)) throw new IllegalArgumentException("스위치 값이 필요합니다.");
      return value;
    }
    if (fallback instanceof Integer) {
      if (!(value instanceof Number number) || number.doubleValue() != number.intValue())
        throw new IllegalArgumentException("정수 값이 필요합니다.");
      int n = ((Number) value).intValue();
      boolean valid =
          switch (key) {
            case "brightness" -> n == -1 || n >= 0 && n <= 100;
            case "textScale" -> n >= 80 && n <= 160;
            case "vibrationMs" -> n >= 20 && n <= 200;
            case "dimPercent" -> n >= 5 && n <= 50;
            case "screenSaverMinutes" -> n >= 0 && n <= 120;
            case "iconResolution" -> Set.of(0, 128, 256, 512).contains(n);
            default -> false;
          };
      if (!valid) throw new IllegalArgumentException("설정 값이 허용 범위를 벗어났습니다.");
      return n;
    }
    if (!(value instanceof String s)) throw new IllegalArgumentException("문자열 값이 필요합니다.");
    boolean valid =
        switch (key) {
          case "orientation" -> Set.of("auto", "portrait", "landscape").contains(s);
          case "language" ->
              Set.of(
                      "system", "ar", "pt-BR", "cs", "nl", "en", "fr", "de", "hi", "id", "it", "ja",
                      "ko", "pl", "ru", "zh", "es", "zh-TW", "tr", "uk")
                  .contains(s);
          case "theme" -> Set.of("system", "light", "dark").contains(s);
          case "timeFormat" -> Set.of("24h", "12h").contains(s);
          case "renderMode" -> Set.of("standard", "simple").contains(s);
          case "screenSaverMode" -> Set.of("dim", "clock").contains(s);
          default -> s.length() <= 128 && !s.contains("\n");
        };
    if (!valid) throw new IllegalArgumentException("설정 값을 확인하세요.");
    return s;
  }

  public static boolean validWifiUrl(String value) {
    return validWifiUrl(value, false);
  }

  public static int parseNumericInput(String key, String text) {
    try {
      return (Integer) validate(key, Integer.parseInt(text.trim()));
    } catch (NumberFormatException e) {
      throw new IllegalArgumentException("정수 값이 필요합니다.");
    }
  }

  public static boolean validWifiUrl(String value, boolean allowInsecureWifi) {
    try {
      URI u = new URI(value);
      String host = u.getHost();
      if (host == null) return false;
      String[] octets = host.split("\\.");
      if (octets.length != 4) return false;
      for (String octet : octets) {
        if (!octet.matches("[0-9]{1,3}") || Integer.parseInt(octet) > 255) return false;
      }
      return ("https".equals(u.getScheme()) || allowInsecureWifi && "http".equals(u.getScheme()))
          && u.getUserInfo() == null
          && u.getQuery() == null
          && u.getFragment() == null
          && (u.getPath() == null || u.getPath().isEmpty())
          && u.getPort() >= 1024
          && u.getPort() <= 65535
          && u.getHost() != null
          && u.getHost().matches("(?:10\\.|192\\.168\\.|172\\.(?:1[6-9]|2[0-9]|3[01])\\.)[0-9.]+");
    } catch (Exception e) {
      return false;
    }
  }

  public static int iconResolution(float displayedPixels, int configured) {
    return configured != 0
        ? configured
        : displayedPixels <= 128 ? 128 : displayedPixels <= 256 ? 256 : 512;
  }

  public static boolean acceptRevision(long incoming, long applied) {
    return incoming >= 0 && incoming > applied;
  }

  public static boolean shouldDim(long now, long lastInteraction, int minutes, boolean foreground) {
    return foreground
        && minutes > 0
        && now >= lastInteraction
        && now - lastInteraction >= minutes * 60_000L;
  }

  public static boolean shouldWakeAfterIdleChange(
      int previousMinutes, int minutes, boolean automatic) {
    return automatic && previousMinutes > 0 && minutes == 0;
  }

  public static float brightness(int configured, boolean dimmed, int dimPercent) {
    if (dimmed) return Math.min(configured < 0 ? 1f : configured / 100f, dimPercent / 100f);
    return configured < 0 ? -1f : Math.max(.01f, configured / 100f);
  }
}
