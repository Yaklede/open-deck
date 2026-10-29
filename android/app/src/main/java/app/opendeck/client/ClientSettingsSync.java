package app.opendeck.client;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/** UI-thread state: the newest host snapshot, overlaid with durable local edits. */
final class ClientSettingsSync {
  static final class Patch {
    final Map<String, Object> values;
    private final Map<String, Long> edits;

    private Patch(Map<String, Object> values, Map<String, Long> edits) {
      this.values = Collections.unmodifiableMap(new LinkedHashMap<>(values));
      this.edits = new LinkedHashMap<>(edits);
    }
  }

  private final Map<String, Object> values = ClientSettingsPolicy.defaults();
  private final Map<String, Object> pending = new LinkedHashMap<>();
  private final Map<String, Object> remote = new LinkedHashMap<>();
  private final Map<String, Long> edits = new LinkedHashMap<>();
  private long revision = -1, nextEdit;

  Map<String, Object> values() {
    return Collections.unmodifiableMap(values);
  }

  Map<String, Object> pending() {
    return Collections.unmodifiableMap(pending);
  }

  long revision() {
    return revision;
  }

  void restore(Map<String, ?> saved, Map<String, ?> outstanding) {
    values.clear();
    values.putAll(ClientSettingsPolicy.defaults());
    pending.clear();
    edits.clear();
    resetRemote();
    for (String key : values.keySet()) {
      if (saved.containsKey(key))
        try {
          values.put(key, ClientSettingsPolicy.validate(key, saved.get(key)));
        } catch (IllegalArgumentException ignored) {
        }
      if (outstanding.containsKey(key))
        try {
          queue(key, outstanding.get(key));
        } catch (IllegalArgumentException ignored) {
        }
    }
  }

  boolean edit(String key, Object value) {
    Object next = ClientSettingsPolicy.validate(key, value);
    if (Objects.equals(values.get(key), next)) return false;
    queue(key, next);
    return true;
  }

  void queue(String key, Object value) {
    Object next = ClientSettingsPolicy.validate(key, value);
    values.put(key, next);
    pending.put(key, next);
    edits.put(key, ++nextEdit);
  }

  void resetRemote() {
    revision = -1;
    remote.clear();
  }

  void clearProfile() {
    for (String key : new String[] {"profileId", "startPageId"}) {
      values.put(key, "");
      pending.remove(key);
      edits.remove(key);
    }
  }

  Patch snapshot() {
    return new Patch(pending, edits);
  }

  void acknowledge(Patch sent) {
    for (String key : sent.values.keySet()) {
      // Equal values can represent separate edits (A → B → A). Only acknowledge the sent edit.
      if (Objects.equals(edits.get(key), sent.edits.get(key))) {
        pending.remove(key);
        edits.remove(key);
      }
    }
  }

  boolean reconcileNavigation(Map<String, List<String>> catalog, String defaultProfile) {
    boolean changed = false;
    String profile = String.valueOf(values.get("profileId"));
    if (!profile.isEmpty() && !catalog.containsKey(profile) && pending.containsKey("profileId")) {
      pending.remove("profileId");
      edits.remove("profileId");
      Object fallback = remote.getOrDefault("profileId", "");
      profile = String.valueOf(fallback);
      if (!profile.isEmpty() && !catalog.containsKey(profile)) profile = "";
      values.put("profileId", profile);
      changed = true;
    }
    List<String> pages =
        catalog.getOrDefault(profile.isEmpty() ? defaultProfile : profile, List.of());
    String start = String.valueOf(values.get("startPageId"));
    if (!start.isEmpty() && !pages.contains(start) && pending.containsKey("startPageId")) {
      pending.remove("startPageId");
      edits.remove("startPageId");
      String fallback = String.valueOf(remote.getOrDefault("startPageId", ""));
      values.put("startPageId", pages.contains(fallback) ? fallback : "");
      changed = true;
    }
    return changed;
  }

  boolean receive(Map<String, ?> snapshot, long incomingRevision) {
    if (ClientSettingsPolicy.acceptRevision(incomingRevision, revision)) {
      remote.clear();
      for (String key : values.keySet()) {
        if (!snapshot.containsKey(key)) continue;
        try {
          remote.put(key, ClientSettingsPolicy.validate(key, snapshot.get(key)));
        } catch (IllegalArgumentException ignored) {
        }
      }
      revision = incomingRevision;
    }
    boolean changed = false;
    for (Map.Entry<String, Object> item : remote.entrySet()) {
      if (pending.containsKey(item.getKey())) continue;
      if (!Objects.equals(values.get(item.getKey()), item.getValue())) {
        values.put(item.getKey(), item.getValue());
        changed = true;
      }
    }
    return changed;
  }
}
