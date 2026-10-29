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

    default boolean openControl(String control) {
      return false;
    }
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
  private final Runnable onClosed;
  private boolean closed, reading, saving;
  private long revision;
  private ClientSettingsPanel currentPanel;
  private AlertDialog loading, progress;

  UtilitySettings(
      Activity activity,
      Handler ui,
      Executor executor,
      Host host,
      String theme,
      String language,
      String widgetId,
      String selectedGroup,
      Runnable onClosed) {
    this.activity = activity;
    this.ui = ui;
    this.executor = executor;
    this.host = host;
    this.theme = theme;
    this.language = language;
    this.widgetId = widgetId;
    this.selectedGroup = selectedGroup;
    this.categoryMenu = "all".equals(selectedGroup) || "essentials".equals(selectedGroup);
    this.onClosed = onClosed;
  }

  private boolean current() {
    return !closed && !activity.isFinishing() && !activity.isDestroyed() && host.current();
  }

  void close() {
    if (closed) return;
    closed = true;
    revision++;
    if (loading != null) loading.dismiss();
    if (progress != null) progress.dismiss();
    if (currentPanel != null) currentPanel.dismiss();
    onClosed.run();
  }

  private void show(ClientSettingsPanel next) {
    AlertDialog previousLoading = loading;
    loading = null;
    ClientSettingsPanel previousPanel = currentPanel;
    currentPanel = next;
    if (previousLoading != null) previousLoading.dismiss();
    if (previousPanel != null) previousPanel.dismiss();
    next.onClosed(
            () -> {
              if (currentPanel == next) close();
            })
        .show();
  }

  private String label(JSONObject value) {
    return value == null
        ? ""
        : value.optString(language.equals("ko") ? "ko" : "en", value.optString("en"));
  }

  private String text(String key) {
    return copy.optString(key, key);
  }

  private void execute(Runnable work) {
    try {
      executor.execute(work);
    } catch (java.util.concurrent.RejectedExecutionException busy) {
      reading = saving = false;
      if (progress != null) progress.dismiss();
      if (current()) error(busy);
    }
  }

  void open() {
    if (closed || reading || saving) return;
    reading = true;
    long ticket = ++revision;
    String group = selectedGroup;
    if (currentPanel != null) {
      ClientSettingsPanel previous = currentPanel;
      currentPanel = null;
      previous.dismiss();
    }
    loading =
        new AlertDialog.Builder(L10n.context(activity))
            .setTitle("Vorssaint")
            .setMessage(L10n.text("불러오는 중"))
            .setNegativeButton(L10n.text("닫기"), null)
            .create();
    AlertDialog shown = loading;
    shown.setCanceledOnTouchOutside(false);
    shown.setOnDismissListener(
        d -> {
          if (loading == shown) close();
        });
    AppTypography.show(loading);
    execute(
        () -> {
          try {
            JSONObject response =
                host.request(
                    "/api/extensions/vorssaint/settings?widgetId="
                        + URLEncoder.encode(widgetId, "UTF-8")
                        + (group == null ? "" : "&group=" + URLEncoder.encode(group, "UTF-8")),
                    "GET",
                    null);
            ui.post(
                () -> {
                  reading = false;
                  if (!current() || ticket != revision) return;
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
                  reading = false;
                  if (current() && ticket == revision) error(e);
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
      categories.action(
          text("essentials"),
          text("essentialsDescription"),
          () -> {
            selectedGroup = "essentials";
            open();
          });
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
      show(categories);
      return;
    }
    ClientSettingsPanel panel =
        panel(
            label(model.optJSONObject("group").optJSONObject("label")),
            "essentials".equals(selectedGroup)
                ? text("essentialsDescription")
                : "Vorssaint "
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
            feature.has("control")
                ? text("manualControl")
                : feature.has("activation")
                    ? text(feature.optBoolean("enabled") ? "enabled" : "disabled")
                    : id.equals("general")
                        ? ""
                        : values != null && values.optBoolean("featureAvailable." + id)
                            ? text("availableOn")
                            : text("availableOff");
        panel.action(
            label(feature.optJSONObject("label")),
            state,
            () -> {
              if (feature.has("control")) {
                close();
                if (!host.openControl(feature.optString("control")))
                  Toast.makeText(activity, text("nativeUnavailable"), Toast.LENGTH_LONG).show();
              } else feature(feature);
            });
      }
    if (categoryMenu)
      panel.action(
          text("allCategories"),
          "",
          () -> {
            selectedGroup = "all";
            open();
          });
    show(panel);
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
    JSONObject activation = feature.optJSONObject("activation");
    values.put("$enabled", feature.optBoolean("enabled"));
    ClientSettingsPanel panel =
        activation == null
            ? panel(label(feature.optJSONObject("label")), text("description"), values, patch)
            : new ClientSettingsPanel(
                activity,
                new ClientSettingsPanel.Host() {
                  public Object value(String key) {
                    return key.equals("theme") ? theme : values.get(key);
                  }

                  public void save(String key, Object value) {
                    values.put(key, value);
                    if (key.equals("$enabled")) {
                      boolean enabled = Boolean.TRUE.equals(value);
                      String available = activation.optString("availabilityKey");
                      values.put(available, enabled);
                      patch.put(available, enabled);
                      JSONArray keys = activation.optJSONArray("enabledKeys");
                      boolean any = false;
                      for (int i = 0; keys != null && i < keys.length(); i++)
                        any |= Boolean.TRUE.equals(values.get(keys.optString(i)));
                      JSONObject defaults = activation.optJSONObject("defaults");
                      for (int i = 0; keys != null && i < keys.length(); i++) {
                        String name = keys.optString(i);
                        boolean next =
                            enabled
                                && (any
                                    ? Boolean.TRUE.equals(values.get(name))
                                    : defaults != null && defaults.optBoolean(name));
                        values.put(name, next);
                        patch.put(name, next);
                      }
                      ClientSettingsPanel.refreshOpenPanels();
                    } else patch.put(key, value);
                  }
                },
                label(feature.optJSONObject("label")),
                text("macBehavior"));
    if (activation != null) {
      panel.toggle("$enabled", text("enableFeature"), text("activationHint"));
    }
    JSONArray fields = feature.optJSONArray("fields");
    for (int i = 0; fields != null && i < fields.length(); i++) {
      JSONObject field = fields.optJSONObject(i);
      String key = field.optString("key"),
          title = label(field.optJSONObject("label")),
          kind = field.optString("kind");
      if (activation != null && key.equals(activation.optString("availabilityKey"))) continue;
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
    show(panel);
  }

  private void save(Map<String, Object> patch) {
    if (!current() || patch.isEmpty() || saving) return;
    // The form's action dismisses it before this callback. Its delayed dismiss
    // must not end the session while the save/progress window is still active.
    currentPanel = null;
    saving = true;
    progress =
        new AlertDialog.Builder(L10n.context(activity))
            .setTitle("Vorssaint")
            .setMessage(text("applying"))
            .setCancelable(false)
            .create();
    AppTypography.show(progress);
    execute(
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
                  saving = false;
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
                  saving = false;
                  if (current()) error(e);
                });
          }
        });
  }

  private void error(Exception error) {
    String message = String.valueOf(error.getMessage());
    String detail = text(message.contains("CONFLICT") ? "conflict" : "unavailable");
    if (currentPanel != null) Toast.makeText(activity, detail, Toast.LENGTH_LONG).show();
    else show(panel("Vorssaint", detail, new HashMap<>(), new HashMap<>()));
  }
}
