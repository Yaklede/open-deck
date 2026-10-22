package app.opendeck.client;

import android.app.AlertDialog;
import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.view.ContextThemeWrapper;
import android.view.Gravity;
import android.widget.*;
import java.util.Map;
import java.util.function.Consumer;

/** Native, scrollable settings forms. The deck remains a native Canvas surface. */
final class ClientSettingsPanel {
  private static final java.util.Set<AlertDialog> openDialogs =
      java.util.Collections.newSetFromMap(new java.util.WeakHashMap<>());

  static boolean dismissForLocaleChange() {
    boolean visible = false;
    for (AlertDialog item : new java.util.ArrayList<>(openDialogs)) {
      if (item.isShowing()) {
        visible = true;
        item.dismiss();
      }
    }
    openDialogs.clear();
    return visible;
  }

  interface Host {
    Object value(String key);

    void save(String key, Object value);
  }

  private final Context context;
  private final Host host;
  private final LinearLayout content;
  private final AlertDialog dialog;
  private final int ink, muted, surface, accent;

  ClientSettingsPanel(Context owner, Host host, String title, String description) {
    this.host = host;
    String mode = String.valueOf(host.value("theme"));
    boolean light =
        mode.equals("light")
            || mode.equals("system")
                && (owner.getResources().getConfiguration().uiMode & 0x30) != 0x20;
    context =
        new ContextThemeWrapper(
            L10n.context(owner),
            light
                ? android.R.style.Theme_Material_Light_Dialog_Alert
                : android.R.style.Theme_Material_Dialog_Alert);
    ink = Color.parseColor(light ? "#172536" : "#e7edf5");
    muted = Color.parseColor(light ? "#5a6a7c" : "#a1aec0");
    surface = Color.parseColor(light ? "#eef2f6" : "#1c2938");
    accent = Color.parseColor(light ? "#315a9d" : "#adc7ec");
    content = new LinearLayout(context);
    content.setOrientation(LinearLayout.VERTICAL);
    content.setLayoutDirection(
        L10n.rtl()
            ? android.view.View.LAYOUT_DIRECTION_RTL
            : android.view.View.LAYOUT_DIRECTION_LTR);
    content.setPadding(dp(20), dp(4), dp(20), dp(16));
    if (!description.isEmpty()) note(description);
    ScrollView scroll = new ScrollView(context);
    scroll.setFillViewport(true);
    scroll.addView(content);
    dialog =
        new AlertDialog.Builder(context)
            .setTitle(title)
            .setView(scroll)
            .setPositiveButton(L10n.text("닫기"), null)
            .create();
  }

  private int dp(float value) {
    return Math.round(value * context.getResources().getDisplayMetrics().density);
  }

  private TextView text(String label, int size, int color) {
    TextView view = new TextView(context);
    view.setText(label);
    view.setTextSize(size);
    view.setTextColor(color);
    view.setIncludeFontPadding(false);
    return view;
  }

  void note(String value) {
    TextView note = text(value, 13, muted);
    note.setPadding(0, dp(8), 0, dp(16));
    content.addView(note);
  }

  void section(String title) {
    TextView label = text(title, 12, accent);
    label.setTypeface(null, Typeface.BOLD);
    label.setPadding(0, dp(18), 0, dp(8));
    content.addView(label);
  }

  private LinearLayout row(String title, String subtitle) {
    LinearLayout row = new LinearLayout(context);
    row.setOrientation(LinearLayout.HORIZONTAL);
    row.setGravity(Gravity.CENTER_VERTICAL);
    row.setPadding(dp(14), dp(12), dp(10), dp(12));
    row.setMinimumHeight(dp(62));
    GradientDrawable bg = new GradientDrawable();
    bg.setColor(surface);
    bg.setCornerRadius(dp(10));
    row.setBackground(bg);
    LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
    params.bottomMargin = dp(5);
    content.addView(row, params);
    LinearLayout labels = new LinearLayout(context);
    labels.setOrientation(LinearLayout.VERTICAL);
    TextView heading = text(title, 16, ink);
    labels.addView(heading);
    if (!subtitle.isEmpty()) {
      TextView desc = text(subtitle, 12, muted);
      desc.setPadding(0, dp(5), 0, 0);
      labels.addView(desc);
    }
    row.addView(labels, new LinearLayout.LayoutParams(0, -2, 1));
    return row;
  }

  void toggle(String key, String title, String subtitle) {
    LinearLayout row = row(title, subtitle);
    Switch view = new Switch(context);
    view.setContentDescription(title);
    view.setChecked(Boolean.TRUE.equals(host.value(key)));
    row.addView(view);
    view.setOnCheckedChangeListener((button, enabled) -> host.save(key, enabled));
    row.setOnClickListener(v -> view.setChecked(!view.isChecked()));
  }

  void choices(String key, String title, Map<String, ?> choices) {
    String current = String.valueOf(host.value(key));
    String[] labels = choices.keySet().toArray(new String[0]);
    Object[] values = choices.values().toArray();
    int selected = 0;
    for (int i = 0; i < values.length; i++)
      if (String.valueOf(values[i]).equals(current)) selected = i;
    LinearLayout row = row(title, "");
    TextView value = text(labels[selected] + "  ›", 14, accent);
    row.addView(value);
    row.setOnClickListener(
        v -> {
          int checked = 0;
          for (int i = 0; i < values.length; i++)
            if (values[i].equals(host.value(key))) checked = i;
          new AlertDialog.Builder(context)
              .setTitle(title)
              .setSingleChoiceItems(
                  labels,
                  checked,
                  (d, index) -> {
                    host.save(key, values[index]);
                    value.setText(labels[index] + "  ›");
                    d.dismiss();
                  })
              .setNegativeButton(L10n.text("취소"), null)
              .show();
        });
  }

  void slider(String key, String title, int min, int max, int step, String unit) {
    LinearLayout row = row(title, "");
    row.setOrientation(LinearLayout.VERTICAL);
    row.getChildAt(0).setLayoutParams(new LinearLayout.LayoutParams(-1, -2));
    TextView current = text(host.value(key) + unit, 14, accent);
    row.addView(current);
    SeekBar seek = new SeekBar(context);
    seek.setContentDescription(title);
    seek.setMax((max - min) / step);
    seek.setProgress((((Number) host.value(key)).intValue() - min) / step);
    row.addView(seek, new LinearLayout.LayoutParams(-1, dp(42)));
    seek.setOnSeekBarChangeListener(
        new SeekBar.OnSeekBarChangeListener() {
          public void onProgressChanged(SeekBar s, int progress, boolean user) {
            current.setText((min + progress * step) + unit);
          }

          public void onStartTrackingTouch(SeekBar s) {}

          public void onStopTrackingTouch(SeekBar s) {
            host.save(key, min + s.getProgress() * step);
          }
        });
  }

  void action(String title, String subtitle, Runnable run) {
    LinearLayout row = row(title, subtitle);
    TextView arrow = text("›", 21, accent);
    row.addView(arrow);
    row.setOnClickListener(
        v -> {
          dialog.dismiss();
          run.run();
        });
  }

  void input(String title, String initial, String message, Consumer<String> save) {
    EditText field = new EditText(context);
    field.setText(initial);
    field.setSingleLine(true);
    int pad = dp(20);
    field.setPadding(pad, dp(10), pad, dp(10));
    AlertDialog prompt =
        new AlertDialog.Builder(context)
            .setTitle(title)
            .setMessage(message)
            .setView(field)
            .setNegativeButton(L10n.text("취소"), null)
            .setPositiveButton(L10n.text("저장"), null)
            .create();
    prompt.setOnShowListener(
        d ->
            prompt
                .getButton(AlertDialog.BUTTON_POSITIVE)
                .setOnClickListener(
                    v -> {
                      try {
                        save.accept(field.getText().toString().trim());
                        prompt.dismiss();
                      } catch (Exception e) {
                        field.setError(L10n.error(e.getMessage()));
                      }
                    }));
    prompt.show();
  }

  void show() {
    dialog.show();
    openDialogs.add(dialog);
    dialog.setOnDismissListener(d -> openDialogs.remove(dialog));
    if (dialog.getWindow() != null) {
      int width =
          Math.min(dp(660), context.getResources().getDisplayMetrics().widthPixels - dp(32));
      int height =
          Math.min(dp(760), context.getResources().getDisplayMetrics().heightPixels - dp(60));
      dialog.getWindow().setLayout(width, height);
    }
  }
}
