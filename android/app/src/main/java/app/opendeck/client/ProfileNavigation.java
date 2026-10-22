package app.opendeck.client;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Chooses only a profile advertised by the authenticated host for a known page. */
public final class ProfileNavigation {
  private ProfileNavigation() {}

  public static String startupPage(
      boolean remember,
      String remembered,
      String selected,
      String profileDefault,
      List<String> visiblePages) {
    if (remember && visiblePages.contains(remembered)) return remembered;
    if (visiblePages.contains(selected)) return selected;
    if (visiblePages.contains(profileDefault)) return profileDefault;
    return visiblePages.isEmpty() ? "" : visiblePages.get(0);
  }

  public static Map<String, String> choices(String defaultLabel, Map<String, String> namesById) {
    Map<String, Integer> counts = new LinkedHashMap<>();
    counts.put(defaultLabel, 1);
    for (String name : namesById.values()) counts.merge(name, 1, Integer::sum);
    Map<String, String> result = new LinkedHashMap<>();
    result.put(defaultLabel, "");
    for (Map.Entry<String, String> entry : namesById.entrySet()) {
      String label = entry.getValue();
      if (counts.get(label) > 1) label += " · " + entry.getKey();
      while (result.containsKey(label)) label += " · " + entry.getKey();
      result.put(label, entry.getKey());
    }
    return result;
  }

  public static String targetProfile(
      String page, String selected, String fallback, Map<String, List<String>> profiles) {
    String active = selected == null || selected.isEmpty() ? fallback : selected;
    if (profiles.getOrDefault(active, List.of()).contains(page)) return active;
    for (Map.Entry<String, List<String>> profile : profiles.entrySet())
      if (profile.getValue().contains(page)) return profile.getKey();
    return null;
  }
}
