package app.opendeck.client;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Handler;
import android.text.InputType;
import android.view.ContextThemeWrapper;
import android.view.View;
import android.widget.*;
import java.net.URLEncoder;
import java.text.SimpleDateFormat;
import java.util.*;
import java.util.concurrent.Executor;
import java.util.function.Consumer;
import org.json.*;

/** Native live controls. Sliders commit on release; readings never rebuild a dragged control. */
final class MacControlsPanel {
  private final Activity activity;
  private final Handler ui;
  private final Executor executor;
  private final UtilitySettings.Host host;
  private final String language, widgetId;
  private final Context context;
  private final int ink, muted, background, surface, accent;
  private final String title;
  private final Runnable onClosed;
  private final Consumer<JSONObject> onLoaded;
  private final boolean seededForm;
  private JSONObject copy = new JSONObject(), state = new JSONObject();
  private String control = "", structure = "";
  private AlertDialog dialog;
  private AlertDialog childDialog;
  private LinearLayout content;
  private TextView status;
  private final ArrayList<Runnable> updates = new ArrayList<>();
  private final ArrayList<View> controls = new ArrayList<>();
  private boolean reading, saving, closed;
  private int generation;
  private final Runnable poll = () -> fetch(false);

  MacControlsPanel(
      Activity activity,
      Handler ui,
      Executor executor,
      UtilitySettings.Host host,
      String theme,
      String language,
      String widgetId,
      String control,
      String title,
      JSONObject initialState,
      JSONObject initialCopy,
      boolean seededForm,
      Consumer<JSONObject> onLoaded,
      Runnable onClosed) {
    this.activity = activity;
    this.ui = ui;
    this.executor = executor;
    this.host = host;
    this.language = language;
    this.widgetId = widgetId;
    this.control = control;
    this.title = title;
    this.state = initialState == null ? new JSONObject() : initialState;
    JSONObject translated =
        initialCopy == null ? null : initialCopy.optJSONObject(language.equals("ko") ? "ko" : "en");
    this.copy = translated == null ? new JSONObject() : translated;
    this.seededForm = seededForm;
    this.onLoaded = onLoaded;
    this.onClosed = onClosed;
    boolean light =
        theme.equals("light")
            || theme.equals("system")
                && (activity.getResources().getConfiguration().uiMode & 0x30) != 0x20;
    context =
        new ContextThemeWrapper(
            L10n.context(activity),
            light
                ? android.R.style.Theme_Material_Light_Dialog_Alert
                : android.R.style.Theme_Material_Dialog_Alert);
    ink = Color.parseColor(light ? "#182b3c" : "#e4edf5");
    muted = Color.parseColor(light ? "#566b7e" : "#97aabe");
    background = Color.parseColor(light ? "#f8fafc" : "#14202b");
    surface = Color.parseColor(light ? "#e7eef5" : "#203141");
    accent = Color.parseColor(light ? "#315f96" : "#a6c8e8");
  }

  private int dp(float n) {
    return Math.round(n * activity.getResources().getDisplayMetrics().density);
  }

  private boolean alive() {
    return !closed && !activity.isFinishing() && !activity.isDestroyed();
  }

  private String t(String key) {
    return copy.optString(key, key);
  }

  void open() {
    long openedAt = android.os.SystemClock.elapsedRealtime();
    if (seededForm) render();
    else {
      content = vertical();
      content.setPadding(dp(22), dp(18), dp(22), dp(18));
      content.setBackgroundColor(background);
      content.addView(text(title, 23, ink));
      status = text(t("loading"), 15, muted);
      content.addView(status);
      Button close = new Button(context);
      close.setText(t("close"));
      close.setOnClickListener(v -> close());
      content.addView(close);
      showDialog();
    }
    content
        .getViewTreeObserver()
        .addOnDrawListener(
            new android.view.ViewTreeObserver.OnDrawListener() {
              boolean recorded;

              public void onDraw() {
                if (recorded) return;
                recorded = true;
                android.util.Log.d(
                    "OpenDeckUI",
                    "mac-panel-first-frame-ms="
                        + (android.os.SystemClock.elapsedRealtime() - openedAt));
                ui.post(
                    () -> {
                      if (content.getViewTreeObserver().isAlive())
                        content.getViewTreeObserver().removeOnDrawListener(this);
                    });
              }
            });
    fetch(true);
  }

  void close() {
    if (closed) return;
    closed = true;
    ui.removeCallbacks(poll);
    if (childDialog != null) childDialog.dismiss();
    if (dialog != null) dialog.dismiss();
    onClosed.run();
  }

  private void schedule() {
    ui.removeCallbacks(poll);
    if (alive()) ui.postDelayed(poll, 2500);
  }

  private void execute(Runnable work) {
    try {
      executor.execute(work);
    } catch (java.util.concurrent.RejectedExecutionException busy) {
      reading = saving = false;
      if (status != null) status.setText(t("busy"));
      schedule();
    }
  }

  private void fetch(boolean initial) {
    if (!alive() || reading || saving) return;
    if (!host.current()) {
      if (status != null) status.setText(t("stale"));
      enabled(false);
      schedule();
      return;
    }
    reading = true;
    final int ticket = generation;
    execute(
        () -> {
          try {
            JSONObject result =
                host.request(
                    "/api/extensions/vorssaint/control?widgetId="
                        + URLEncoder.encode(widgetId, "UTF-8"),
                    "GET",
                    null);
            ui.post(
                () -> {
                  reading = false;
                  if (!alive()) return;
                  if (!host.current() || ticket != generation) {
                    schedule();
                    return;
                  }
                  onLoaded.accept(result);
                  JSONObject all = result.optJSONObject("copy");
                  copy =
                      all == null
                          ? new JSONObject()
                          : all.optJSONObject(language.equals("ko") ? "ko" : "en");
                  if (copy == null) copy = new JSONObject();
                  state = result.optJSONObject("state");
                  if (state == null) state = new JSONObject();
                  control = result.optString("control");
                  render();
                  schedule();
                });
          } catch (Exception e) {
            ui.post(
                () -> {
                  reading = false;
                  if (!alive()) return;
                  if (status != null) {
                    status.setText(t("stale"));
                    enabled(false);
                  }
                  schedule();
                });
          }
        });
  }

  private TextView text(String value, int size, int color) {
    TextView v = new TextView(context);
    v.setText(value);
    v.setTextSize(size);
    v.setTextColor(color);
    v.setTypeface(Typeface.create("sans-serif", Typeface.NORMAL));
    v.setPadding(dp(2), dp(5), dp(2), dp(5));
    return v;
  }

  private LinearLayout vertical() {
    LinearLayout v = new LinearLayout(context);
    v.setOrientation(LinearLayout.VERTICAL);
    return v;
  }

  private LinearLayout row(LinearLayout parent) {
    LinearLayout v = new LinearLayout(context);
    v.setOrientation(LinearLayout.HORIZONTAL);
    v.setGravity(android.view.Gravity.CENTER_VERTICAL);
    parent.addView(v, new LinearLayout.LayoutParams(-1, -2));
    return v;
  }

  private LinearLayout card(LinearLayout parent) {
    LinearLayout v = vertical();
    v.setPadding(dp(16), dp(10), dp(16), dp(10));
    GradientDrawable bg = new GradientDrawable();
    bg.setColor(surface);
    bg.setCornerRadius(dp(12));
    v.setBackground(bg);
    LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(-1, -2);
    p.setMargins(0, dp(5), 0, dp(5));
    parent.addView(v, p);
    return v;
  }

  private Button button(LinearLayout parent, String label, Runnable action) {
    Button b = new Button(context);
    b.setText(label);
    b.setTextSize(14);
    b.setTextColor(accent);
    b.setAllCaps(false);
    b.setMinHeight(dp(48));
    b.setTag(Boolean.TRUE);
    controls.add(b);
    b.setOnClickListener(
        v -> {
          if (!saving && host.current()) action.run();
        });
    LinearLayout.LayoutParams p =
        parent.getOrientation() == LinearLayout.HORIZONTAL
            ? new LinearLayout.LayoutParams(0, -2, 1)
            : new LinearLayout.LayoutParams(-1, -2);
    parent.addView(b, p);
    return b;
  }

  private void allow(View v, boolean value) {
    v.setTag(value);
    v.setEnabled(value && !saving && host.current());
  }

  private void enabled(boolean value) {
    for (View v : controls) v.setEnabled(value && Boolean.TRUE.equals(v.getTag()));
  }

  private JSONObject object(String key) {
    JSONObject v = state.optJSONObject(key);
    return v == null ? new JSONObject() : v;
  }

  private void send(String operation, JSONObject parameters) {
    if (!alive() || saving || !host.current() || state.optBoolean("applying")) return;
    saving = true;
    generation++;
    enabled(false);
    status.setText(t("applying"));
    execute(
        () -> {
          try {
            JSONObject body =
                new JSONObject()
                    .put("widgetId", widgetId)
                    .put("operation", operation)
                    .put("parameters", parameters);
            JSONObject result = host.request("/api/extensions/vorssaint/control", "POST", body);
            ui.post(
                () -> {
                  saving = false;
                  if (!alive()) return;
                  if (!host.current()) {
                    schedule();
                    return;
                  }
                  JSONObject value = result.optJSONObject("state");
                  if (value != null) state = value;
                  render();
                  if (operation.equals("fan.authorize")) status.setText(t("permissionPending"));
                  else if (object("fan").optBoolean("presetSaveError"))
                    status.setText(t("presetSaveFailed"));
                  schedule();
                });
          } catch (Exception e) {
            ui.post(
                () -> {
                  saving = false;
                  if (!alive()) return;
                  String message = String.valueOf(e.getMessage());
                  String key =
                      message.contains("FAN_AUTHORIZATION_REQUIRED")
                          ? "authorizationRequired"
                          : message.contains("HELPER_UNAVAILABLE")
                              ? "helperUnavailable"
                              : message.contains("alreadyControlled")
                                      || message.contains("unsupportedHardware")
                                  ? "fanUnavailable"
                                  : message.contains("STALE_ACTION")
                                      ? "staleAction"
                                      : message.contains("BUSY") ? "busy" : "failed";
                  status.setText(t(key));
                  enabled(host.current());
                  schedule();
                });
          }
        });
  }

  private JSONObject parameters(Object... pairs) {
    JSONObject result = new JSONObject();
    try {
      for (int i = 0; i < pairs.length; i += 2) result.put(String.valueOf(pairs[i]), pairs[i + 1]);
    } catch (JSONException ignored) {
    }
    return result;
  }

  private String clock(long at) {
    return new SimpleDateFormat("HH:mm:ss", language.equals("ko") ? Locale.KOREAN : Locale.US)
        .format(new Date(at));
  }

  private void render() {
    if (!alive()) return;
    String next =
        control
            + ":"
            + object("fan").optString("access")
            + ":"
            + object("fan").optBoolean("controllable")
            + ":"
            + (object("fan").optJSONArray("fans") == null
                ? 0
                : object("fan").optJSONArray("fans").length())
            + ":"
            + object("audio").optInt("outputId")
            + ":"
            + object("audio").optInt("inputId")
            + ":";
    JSONArray devices = object("audio").optJSONArray("devices"),
        displays = state.optJSONArray("displays");
    if (devices != null)
      for (int i = 0; i < devices.length(); i++) {
        JSONObject d = devices.optJSONObject(i);
        next +=
            d.optInt("id")
                + d.optString("name")
                + d.optBoolean("input")
                + d.optBoolean("output")
                + d.has("inputVolume")
                + d.has("outputVolume")
                + ":";
      }
    if (displays != null)
      for (int i = 0; i < displays.length(); i++)
        next += displays.optJSONObject(i).optInt("id") + ":";
    if (dialog == null || !next.equals(structure)) {
      structure = next;
      build();
    }
    for (Runnable update : updates) update.run();
    boolean available = state.optBoolean("available") && !state.optBoolean("stale");
    enabled(available && host.current() && !saving && !state.optBoolean("applying"));
    status.setText(
        state.optBoolean("applying")
            ? t("applying")
            : available ? t("updated") + " " + clock(state.optLong("at")) : t("stale"));
  }

  private void build() {
    updates.clear();
    controls.clear();
    if (content == null) {
      content = vertical();
      content.setPadding(dp(22), dp(18), dp(22), dp(18));
      GradientDrawable bg = new GradientDrawable();
      bg.setColor(background);
      bg.setCornerRadius(dp(18));
      content.setBackground(bg);
    }
    content.removeAllViews();
    LinearLayout header = row(content);
    TextView title = text(t(control) + " · Mac", 23, ink);
    title.setTypeface(Typeface.create("sans-serif", Typeface.BOLD));
    header.addView(title, new LinearLayout.LayoutParams(0, -2, 1));
    Button close = new Button(context);
    close.setText(t("close"));
    close.setAllCaps(false);
    close.setTextColor(accent);
    close.setOnClickListener(
        v -> {
          if (dialog != null) dialog.dismiss();
        });
    header.addView(close);
    if (control.equals("fan")) fan();
    else if (control.equals("audio")) audio();
    else if (control.equals("display")) displays();
    else if (control.equals("awake")) awake();
    status = text("", 12, muted);
    content.addView(status);
    showDialog();
  }

  private void showDialog() {
    if (dialog == null) {
      ScrollView scroll = new ScrollView(context);
      scroll.addView(content);
      dialog = new AlertDialog.Builder(context).setView(scroll).create();
      dialog.setOnDismissListener(d -> close());
      dialog.show();
    }
    if (dialog.getWindow() != null) {
      dialog.getWindow().setBackgroundDrawableResource(android.R.color.transparent);
      int width =
          Math.min(dp(900), (int) (activity.getResources().getDisplayMetrics().widthPixels * .92));
      content.measure(
          View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.AT_MOST),
          View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
      int height =
          Math.min(
              content.getMeasuredHeight() + dp(12),
              (int) (activity.getResources().getDisplayMetrics().heightPixels * .88));
      dialog.getWindow().setLayout(width, height);
    }
  }

  private void fan() {
    JSONObject initial = object("fan");
    JSONArray fans = initial.optJSONArray("fans");
    LinearLayout readings = row(content);
    for (int i = 0; fans != null && i < fans.length(); i++) {
      final int index = i;
      LinearLayout c = vertical();
      c.setPadding(dp(14), dp(8), dp(14), dp(8));
      readings.addView(c, new LinearLayout.LayoutParams(0, -2, 1));
      c.addView(text(t("fan") + " " + (i + 1), 14, muted));
      TextView rpm = text("", 35, ink), target = text("", 13, muted);
      c.addView(rpm);
      c.addView(target);
      updates.add(
          () -> {
            JSONObject f = object("fan").optJSONArray("fans").optJSONObject(index);
            rpm.setText(Math.round(f.optDouble("actualRPM")) + " " + t("rpm"));
            target.setText(
                t("target")
                    + " "
                    + Math.round(f.optDouble("targetRPM"))
                    + " · "
                    + Math.round(f.optDouble("minimumRPM"))
                    + "–"
                    + Math.round(f.optDouble("maximumRPM"))
                    + " "
                    + t("rpm"));
          });
    }
    TextView mode = text("", 16, accent);
    content.addView(mode);
    updates.add(
        () -> {
          JSONObject f = object("fan");
          String key = f.optString("mode", "system");
          String value = t(key);
          JSONArray temperatures = f.optJSONArray("temperatures");
          double temperature = Double.NaN;
          if (temperatures != null)
            for (int i = 0; i < temperatures.length(); i++) {
              JSONObject r = temperatures.optJSONObject(i);
              if (r.optString("source").equals("hottestSoC")) temperature = r.optDouble("celsius");
            }
          mode.setText(
              value
                  + (f.has("level") ? " · " + f.optInt("level") + "%" : "")
                  + (Double.isFinite(temperature)
                      ? String.format(Locale.US, "  ·  %.1f°C", temperature)
                      : "")
                  + (f.has("stopReason") ? "\n" + t(f.optString("stopReason")) : ""));
        });
    if (fans == null || fans.length() == 0) {
      content.addView(text(t("noFans"), 16, muted));
      return;
    }
    if (!initial.optBoolean("controllable")) {
      String access = initial.optString("access"),
          reason =
              initial.optString("error").equals("alreadyControlled")
                      || initial.optString("mode").equals("external")
                  ? "external"
                  : access.equals("enabled")
                      ? "helperUnavailable"
                      : access.equals("installing") ? "permissionPending" : "authorizationRequired";
      content.addView(text(t(reason), 14, muted));
      Button authorize =
          button(content, t("authorize"), () -> send("fan.authorize", new JSONObject()));
      allow(authorize, !access.equals("installing"));
      content.addView(text(t("authorization"), 12, muted));
    }
    int fanControlStart = controls.size();
    LinearLayout modes = row(content);
    button(modes, t("system"), () -> send("fan.system", new JSONObject()));
    button(modes, t("maximum"), () -> send("fan.manual", parameters("level", 100)));
    button(modes, t("curve"), this::curve);
    LinearLayout manual = card(content);
    slider(
        manual,
        t("manual"),
        0,
        20,
        () -> object("fan").optInt("level", object("fan").optInt("presetLevel", 100)) / 5,
        n -> send("fan.manual", parameters("level", n * 5)),
        5,
        "%");
    manual.addView(text(t("fanExplanation"), 12, muted));
    manual.addView(text(t("presetHint"), 12, muted));
    for (int i = fanControlStart; i < controls.size(); i++)
      allow(controls.get(i), initial.optBoolean("controllable"));
  }

  private interface NumberValue {
    int get();
  }

  private interface NumberAction {
    void send(int value);
  }

  private void slider(
      LinearLayout parent,
      String label,
      int minimum,
      int maximum,
      NumberValue value,
      NumberAction action,
      int scale,
      String suffix) {
    TextView caption = text("", 15, ink);
    parent.addView(caption);
    SeekBar slider = new SeekBar(context);
    slider.setMin(minimum);
    slider.setMax(maximum);
    slider.setTag(Boolean.TRUE);
    slider.setContentDescription(label);
    controls.add(slider);
    parent.addView(slider, new LinearLayout.LayoutParams(-1, dp(48)));
    updates.add(
        () -> {
          if (!slider.isPressed()) {
            int current = value.get();
            slider.setProgress(current);
            caption.setText(label + "   " + current * scale + suffix);
          }
        });
    slider.setOnSeekBarChangeListener(
        new SeekBar.OnSeekBarChangeListener() {
          public void onProgressChanged(SeekBar s, int n, boolean user) {
            if (user) caption.setText(label + "   " + n * scale + suffix);
          }

          public void onStartTrackingTouch(SeekBar s) {}

          public void onStopTrackingTouch(SeekBar s) {
            action.send(s.getProgress());
          }
        });
  }

  private void curve() {
    LinearLayout form = vertical();
    form.setPadding(dp(20), dp(8), dp(20), dp(8));
    Spinner sensor = new Spinner(context);
    String[] ids = {"hottestSoC", "averageSoC", "hottestCPU", "averageCPU", "hottestGPU"};
    String[] names = new String[ids.length];
    for (int i = 0; i < ids.length; i++) names[i] = t(ids[i]);
    sensor.setAdapter(
        new ArrayAdapter<>(context, android.R.layout.simple_spinner_dropdown_item, names));
    form.addView(text(t("sensor"), 14, muted));
    form.addView(sensor);
    JSONObject configuration = object("fan").optJSONObject("configuration");
    JSONArray curves =
        configuration == null
            ? object("fan").optJSONArray("presetCurves")
            : configuration.optJSONArray("curves");
    JSONObject current = curves == null ? null : curves.optJSONObject(0);
    JSONArray points = current == null ? null : current.optJSONArray("points");
    JSONObject low = points == null ? null : points.optJSONObject(0),
        high = points == null ? null : points.optJSONObject(points.length() - 1);
    if (current != null)
      for (int i = 0; i < ids.length; i++)
        if (ids[i].equals(current.optString("sensor"))) sensor.setSelection(i);
    EditText lowT = number(form, t("lowTemperature"), low == null ? 50 : low.optInt("temperature")),
        highT = number(form, t("highTemperature"), high == null ? 70 : high.optInt("temperature")),
        lowL = number(form, t("lowLevel"), low == null ? 0 : low.optInt("coolingLevel")),
        highL = number(form, t("highLevel"), high == null ? 100 : high.optInt("coolingLevel"));
    TextView error = text("", 13, muted);
    form.addView(error);
    ScrollView curveScroll = new ScrollView(context);
    curveScroll.addView(form);
    AlertDialog editor =
        new AlertDialog.Builder(context)
            .setTitle(t("curve"))
            .setView(curveScroll)
            .setNegativeButton(t("close"), null)
            .setPositiveButton(t("apply"), null)
            .create();
    childDialog = editor;
    editor.setOnDismissListener(
        d -> {
          if (childDialog == editor) childDialog = null;
        });
    editor.setOnShowListener(
        d ->
            editor
                .getButton(AlertDialog.BUTTON_POSITIVE)
                .setOnClickListener(
                    v -> {
                      try {
                        int a = Integer.parseInt(lowT.getText().toString()),
                            b = Integer.parseInt(highT.getText().toString()),
                            c = Integer.parseInt(lowL.getText().toString()),
                            e = Integer.parseInt(highL.getText().toString());
                        if (a < 20
                            || a >= b
                            || b > 110
                            || c < 0
                            || c > e
                            || e > 100
                            || c % 5 != 0
                            || e % 5 != 0) throw new IllegalArgumentException();
                        JSONArray p =
                            new JSONArray()
                                .put(parameters("temperature", a, "coolingLevel", c))
                                .put(parameters("temperature", b, "coolingLevel", e));
                        JSONArray list =
                            new JSONArray()
                                .put(
                                    parameters(
                                        "sensor",
                                        ids[sensor.getSelectedItemPosition()],
                                        "points",
                                        p));
                        editor.dismiss();
                        send("fan.curve", parameters("curves", list));
                      } catch (Exception ignored) {
                        error.setText(t("curveInvalid"));
                      }
                    }));
    editor.show();
  }

  private EditText number(LinearLayout parent, String label, int value) {
    parent.addView(text(label, 14, muted));
    EditText input = new EditText(context);
    input.setText(String.valueOf(value));
    input.setTextColor(ink);
    input.setInputType(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_FLAG_SIGNED);
    input.setContentDescription(label);
    parent.addView(input);
    return input;
  }

  private JSONObject device(String direction) {
    JSONObject a = object("audio");
    int id = a.optInt(direction + "Id");
    JSONArray list = a.optJSONArray("devices");
    for (int i = 0; list != null && i < list.length(); i++) {
      JSONObject d = list.optJSONObject(i);
      if (d.optInt("id") == id) return d;
    }
    return new JSONObject();
  }

  private void audio() {
    for (String direction : new String[] {"output", "input"}) {
      LinearLayout c = card(content);
      c.addView(text(t(direction), 14, muted));
      Button choose = button(c, "", () -> chooseDevice(direction));
      updates.add(() -> choose.setText(device(direction).optString("name", "—")));
      if (device(direction).has(direction + "Volume"))
        slider(
            c,
            t("volume"),
            0,
            100,
            () -> device(direction).optInt(direction + "Volume"),
            n ->
                send(
                    "audio.volume",
                    parameters(
                        "deviceId",
                        device(direction).optInt("id"),
                        "direction",
                        direction,
                        "value",
                        n)),
            1,
            "%");
      else c.addView(text(t("unsupportedVolume"), 13, muted));
      if (device(direction).has(direction + "Muted")) {
        Button mute =
            button(
                c,
                t("mute"),
                () ->
                    send(
                        "audio.mute",
                        parameters(
                            "deviceId",
                            device(direction).optInt("id"),
                            "direction",
                            direction,
                            "value",
                            !device(direction).optBoolean(direction + "Muted"))));
        updates.add(
            () ->
                mute.setText(
                    t(device(direction).optBoolean(direction + "Muted") ? "unmute" : "mute")));
      }
    }
  }

  private void chooseDevice(String direction) {
    JSONArray all = object("audio").optJSONArray("devices");
    ArrayList<JSONObject> choices = new ArrayList<>();
    ArrayList<String> labels = new ArrayList<>();
    for (int i = 0; all != null && i < all.length(); i++) {
      JSONObject d = all.optJSONObject(i);
      if (d.optBoolean(direction)) {
        choices.add(d);
        labels.add(d.optString("name"));
      }
    }
    new AlertDialog.Builder(context)
        .setTitle(t(direction))
        .setItems(
            labels.toArray(new String[0]),
            (d, n) ->
                send(
                    "audio.device",
                    parameters("deviceId", choices.get(n).optInt("id"), "direction", direction)))
        .setNegativeButton(t("close"), null)
        .show();
  }

  private void displays() {
    JSONArray list = state.optJSONArray("displays");
    if (list == null || list.length() == 0) {
      content.addView(text(t("noDisplays"), 16, muted));
      return;
    }
    for (int i = 0; i < list.length(); i++) {
      JSONObject display = list.optJSONObject(i);
      int id = display.optInt("id");
      LinearLayout c = card(content);
      c.addView(text(display.optString("name"), 16, ink));
      slider(
          c,
          t("brightness"),
          1,
          100,
          () -> {
            JSONArray values = state.optJSONArray("displays");
            for (int j = 0; values != null && j < values.length(); j++)
              if (values.optJSONObject(j).optInt("id") == id)
                return values.optJSONObject(j).optInt("brightness");
            return 50;
          },
          n -> send("display.brightness", parameters("displayId", id, "value", n)),
          1,
          "%");
    }
  }

  private void awake() {
    LinearLayout c = card(content);
    TextView reading = text("", 24, ink);
    c.addView(reading);
    updates.add(
        () -> {
          JSONObject a = object("awake");
          reading.setText(
              t(a.optBoolean("active") ? "active" : "stopped")
                  + (a.has("until") ? " · " + t("until") + " " + clock(a.optLong("until")) : ""));
        });
    CheckBox display = new CheckBox(context);
    display.setText(t("keepDisplay"));
    display.setTextColor(ink);
    display.setChecked(object("awake").optBoolean("display"));
    c.addView(display);
    display.setTag(Boolean.TRUE);
    controls.add(display);
    LinearLayout durations = row(c);
    for (int minutes : new int[] {15, 30, 60})
      button(
          durations,
          minutes + " " + t("minutes"),
          () ->
              send("awake.start", parameters("minutes", minutes, "display", display.isChecked())));
    LinearLayout actions = row(c);
    button(
        actions,
        t("unlimited"),
        () -> send("awake.start", parameters("minutes", 0, "display", display.isChecked())));
    button(actions, t("stop"), () -> send("awake.stop", new JSONObject()));
  }
}
