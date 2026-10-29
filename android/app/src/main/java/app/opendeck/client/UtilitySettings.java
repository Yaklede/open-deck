package app.opendeck.client;

import android.app.Activity;
import android.app.AlertDialog;
import android.os.Handler;
import android.widget.Toast;
import java.net.URLEncoder;
import java.util.*;
import java.util.concurrent.Executor;
import org.json.*;

/** Scoped native forms for the installed Mac utility. Draft edits are committed together. */
final class UtilitySettings {
  interface Host {
    JSONObject request(String route, String method, JSONObject body) throws Exception;

    boolean current();
  }

  private final Activity activity;
  private final Handler ui;
  private final Executor executor;
  private final Host host;
  private final String theme;
  private final String language;
  private final String widgetId;
  private String selectedGroup;
  private final boolean categoryMenu;
  private JSONObject model;
  private JSONObject copy = new JSONObject();

  UtilitySettings(
      Activity activity,
      Handler ui,
      Executor executor,
      Host host,
      String theme,
      String language,
      String widgetId,
      String selectedGroup) {
    this.activity = activity;
    this.ui = ui;
    this.executor = executor;
    this.host = host;
    this.theme = theme;
    this.language = language;
    this.widgetId = widgetId;
    this.selectedGroup = selectedGroup;
    this.categoryMenu = "all".equals(selectedGroup);
  }

  private boolean current() {
    return !activity.isFinishing() && !activity.isDestroyed() && host.current();
  }

  private String label(JSONObject value) {
    return value == null
        ? ""
        : value.optString(language.equals("ko") ? "ko" : "en", value.optString("en"));
  }

  private String text(String key) {
    return copy.optString(key, key);
  }

  void open() {
    executor.execute(
        () -> {
          try {
            JSONObject response =
                host.request(
                    "/api/extensions/vorssaint/settings?widgetId="
                        + URLEncoder.encode(widgetId, "UTF-8")
                        + (selectedGroup == null
                            ? ""
                            : "&group=" + URLEncoder.encode(selectedGroup, "UTF-8")),
                    "GET",
                    null);
            ui.post(
                () -> {
                  if (!current()) return;
                  model = response;
                  JSONObject all = response.optJSONObject("copy");
                  copy =
                      all == null
                          ? new JSONObject()
                          : all.optJSONObject(language.equals("ko") ? "ko" : "en");
                  if (copy == null) copy = new JSONObject();
                  groups();
                });
          } catch (Exception e) {
            ui.post(
                () -> {
                  if (current()) error(e);
                });
          }
        });
  }

  private ClientSettingsPanel panel(
      String title, String description, Map<String, Object> values, Map<String, Object> patch) {
    return new ClientSettingsPanel(
        activity,
        new ClientSettingsPanel.Host() {
          public Object value(String key) {
            return key.equals("theme") ? theme : values.get(key);
          }

          public void save(String key, Object value) {
            values.put(key, value);
            patch.put(key, value);
          }
        },
        title,
        description);
  }

  private void groups() {
    if (!current()) return;
    if (model.has("groups")) {
      ClientSettingsPanel categories =
          panel(text("categories"), text("description"), new HashMap<>(), new HashMap<>());
      JSONArray groups = model.optJSONArray("groups");
      for (int i = 0; groups != null && i < groups.length(); i++) {
        JSONObject group = groups.optJSONObject(i);
        categories.action(
            label(group.optJSONObject("label")),
            "",
            () -> {
              selectedGroup = group.optString("id");
              open();
            });
      }
      categories.show();
      return;
    }
    ClientSettingsPanel panel =
        panel(
            label(model.optJSONObject("group").optJSONObject("label")),
            "Vorssaint "
                + model.optJSONObject("app").optString("version")
                + "\n"
                + text("description"),
            new HashMap<>(),
            new HashMap<>());
    panel.note(text("permission"));
    JSONArray features = model.optJSONArray("features");
    if (features != null)
      for (int i = 0; i < features.length(); i++) {
        JSONObject feature = features.optJSONObject(i);
        if (feature == null) continue;
        String id = feature.optString("id");
        JSONObject values = model.optJSONObject("values");
        String state =
            id.equals("general")
                ? ""
                : values != null && values.optBoolean("featureAvailable." + id)
                    ? text("availableOn")
                    : text("availableOff");
        panel.action(label(feature.optJSONObject("label")), state, () -> feature(feature));
      }
    if (categoryMenu)
      panel.action(
          text("categories"),
          "",
          () -> {
            selectedGroup = "all";
            open();
          });
    panel.show();
  }

  private String choiceLabel(JSONObject field, Object value) {
    JSONObject labels = field.optJSONObject("choiceLabels");
    String translated = labels == null ? "" : label(labels.optJSONObject(String.valueOf(value)));
    return translated.isEmpty()
        ? String.valueOf(value)
            + (field.optString("unit").isEmpty() ? "" : " " + field.optString("unit"))
        : translated;
  }

  private void feature(JSONObject feature) {
    if (!current()) return;
    Map<String, Object> values = new LinkedHashMap<>(), patch = new LinkedHashMap<>();
    JSONObject all = model.optJSONObject("values");
    if (all != null) {
      Iterator<String> keys = all.keys();
      while (keys.hasNext()) {
        String k = keys.next();
        values.put(k, all.opt(k));
      }
    }
    ClientSettingsPanel panel =
        panel(label(feature.optJSONObject("label")), text("description"), values, patch);
    JSONArray fields = feature.optJSONArray("fields");
    for (int i = 0; fields != null && i < fields.length(); i++) {
      JSONObject field = fields.optJSONObject(i);
      String key = field.optString("key"),
          title = label(field.optJSONObject("label")),
          kind = field.optString("kind");
      if (kind.equals("boolean")) panel.toggle(key, title, "");
      else if (kind.equals("integer")) {
        Map<String, Object> options = new LinkedHashMap<>();
        JSONArray choices = field.optJSONArray("choices");
        String unit = field.optString("unit");
        if (choices != null)
          for (int j = 0; j < choices.length(); j++) {
            int v = choices.optInt(j);
            options.put(choiceLabel(field, v), v);
          }
        else {
          for (int v :
              new int[] {field.optInt("default"), field.optInt("min"), field.optInt("max")})
            options.put(choiceLabel(field, v), v);
        }
        if (choices != null) panel.choices(key, title, options);
        else
          panel.numericChoices(key, title, options, field.optInt("min"), field.optInt("max"), unit);
      } else if (kind.equals("enum")) {
        Map<String, Object> options = new LinkedHashMap<>();
        JSONArray choices = field.optJSONArray("choices");
        for (int j = 0; choices != null && j < choices.length(); j++) {
          String v = choices.optString(j);
          options.put(choiceLabel(field, v), v);
        }
        panel.choices(key, title, options);
      }
    }
    panel.action(text("apply"), "", () -> save(patch));
    panel.action(label(model.optJSONObject("group").optJSONObject("label")), "", this::groups);
    panel.show();
  }

  private void save(Map<String, Object> patch) {
    if (!current() || patch.isEmpty()) return;
    AlertDialog progress =
        new AlertDialog.Builder(L10n.context(activity))
            .setTitle("Vorssaint")
            .setMessage(text("applying"))
            .setCancelable(false)
            .show();
    executor.execute(
        () -> {
          try {
            JSONObject request =
                new JSONObject()
                    .put("widgetId", widgetId)
                    .put("revision", model.optString("revision"))
                    .put("patch", new JSONObject(patch));
            if (selectedGroup != null) request.put("group", selectedGroup);
            JSONObject response =
                host.request("/api/extensions/vorssaint/settings", "POST", request);
            ui.post(
                () -> {
                  progress.dismiss();
                  if (!current()) return;
                  Toast.makeText(
                          activity,
                          text(
                              response.optString("launchError").isEmpty()
                                  ? "saved"
                                  : "savedNotStarted"),
                          Toast.LENGTH_LONG)
                      .show();
                  open();
                });
          } catch (Exception e) {
            ui.post(
                () -> {
                  progress.dismiss();
                  if (current()) error(e);
                });
          }
        });
  }

  private void error(Exception error) {
    String message = String.valueOf(error.getMessage());
    new AlertDialog.Builder(L10n.context(activity))
        .setTitle("Vorssaint")
        .setMessage(text(message.contains("CONFLICT") ? "conflict" : "unavailable"))
        .setPositiveButton(L10n.text("확인"), null)
        .show();
  }
}
