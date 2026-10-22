package app.opendeck.client;

import java.util.List;
import java.util.Map;

/** Chooses only a profile advertised by the authenticated host for a known page. */
public final class ProfileNavigation {
  private ProfileNavigation() {}

  public static String targetProfile(
      String page, String selected, String fallback, Map<String, List<String>> profiles) {
    String active = selected == null || selected.isEmpty() ? fallback : selected;
    if (profiles.getOrDefault(active, List.of()).contains(page)) return active;
    for (Map.Entry<String, List<String>> profile : profiles.entrySet())
      if (profile.getValue().contains(page)) return profile.getKey();
    return null;
  }
}
