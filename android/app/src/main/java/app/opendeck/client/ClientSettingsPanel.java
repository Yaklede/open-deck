package app.opendeck.client;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Handler;
import android.os.Looper;
import android.view.ContextThemeWrapper;
import android.view.Gravity;
import android.widget.*;
import java.util.Map;
import java.util.function.Consumer;
import java.util.function.Supplier;

/** Native, scrollable settings forms. The deck remains a native Canvas surface. */
final class ClientSettingsPanel {
  private static final Handler mainHandler = new Handler(Looper.getMainLooper());
  private static final ThreadLocal<Integer> reopeningScroll = new ThreadLocal<>();
  private static final java.util.Set<AlertDialog> openDialogs =
      java.util.Collections.newSetFromMap(new java.util.WeakHashMap<>());
  private static final java.util.Set<ClientSettingsPanel> openPanels =
      java.util.Collections.newSetFromMap(new java.util.WeakHashMap<>());

  static void refreshOpenPanels() {
    for (ClientSettingsPanel panel : new java.util.ArrayList<>(openPanels)) {
      for (SettingsControlBinding binding : panel.bindings) binding.refresh();
      if (panel.reopen != null
          && !panel.reopening
          && !panel.theme.equals(String.valueOf(panel.host.value("theme")))
          && panel.bindings.stream().noneMatch(SettingsControlBinding::isEditing)) {
        panel.reopening = true;
        int scrollY = panel.scroll.getScrollY();
        for (AlertDialog child : panel.childDialogs) child.dismiss();
        panel.dialog.dismiss();
        // The dismissed view is detached; its View.post queue may never run again.
        mainHandler.post(
            () -> {
              if (panel.ownerActivity == null
                  || panel.ownerActivity.isFinishing()
                  || panel.ownerActivity.isDestroyed()) return;
              reopeningScroll.set(scrollY);
              try {
                panel.reopen.run();
              } finally {
                reopeningScroll.remove();
              }
            });
      }
    }
  }

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
  private final Activity ownerActivity;
  private final Host host;
  private final LinearLayout content;
  private final ScrollView scroll;
  private final AlertDialog dialog;
  private final int ink, muted, surface, accent;
  private final java.util.List<SettingsControlBinding> bindings = new java.util.ArrayList<>();
  private final java.util.List<AlertDialog> childDialogs = new java.util.ArrayList<>();
  private final String theme;
  private Runnable reopen;
  private boolean reopening;

  ClientSettingsPanel onThemeChanged(Runnable reopen) {
    this.reopen = reopen;
    return this;
  }

  private SettingsControlBinding bind(Supplier<Object> model, Consumer<Object> render) {
    SettingsControlBinding binding = new SettingsControlBinding(model, render);
    bindings.add(binding);
    binding.refresh();
    return binding;
  }

  ClientSettingsPanel(Context owner, Host host, String title, String description) {
    this.host = host;
    ownerActivity = owner instanceof Activity activity ? activity : null;
    String mode = String.valueOf(host.value("theme"));
    theme = mode;
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
    scroll = new ScrollView(context);
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
    row.addView(view);
    SettingsControlBinding binding =
        bind(() -> host.value(key), value -> view.setChecked(Boolean.TRUE.equals(value)));
    view.setOnCheckedChangeListener(
        (button, enabled) -> binding.change(enabled, value -> host.save(key, value)));
    row.setOnClickListener(v -> view.setChecked(!view.isChecked()));
  }

  void choices(String key, String title, Map<String, ?> choices) {
    choices(key, title, () -> choices);
  }

  void choices(String key, String title, Supplier<Map<String, ?>> source) {
    LinearLayout row = row(title, "");
    TextView value = text("", 14, accent);
    row.addView(value);
    AlertDialog[] picker = new AlertDialog[1];
    Object[][] pickerValues = new Object[1][];
    SettingsControlBinding binding =
        bind(
            () -> new ChoiceSelection(host.value(key), new java.util.LinkedHashMap<>(source.get())),
            selection -> {
              ChoiceSelection selected = (ChoiceSelection) selection;
              Object current = selected.value();
              String label = String.valueOf(current);
              for (Map.Entry<String, ?> entry : selected.choices().entrySet())
                if (java.util.Objects.equals(entry.getValue(), current)) label = entry.getKey();
              value.setText(label + "  ›");
              if (picker[0] != null && picker[0].isShowing()) {
                ListView list = picker[0].getListView();
                pickerValues[0] = selected.choices().values().toArray();
                list.setAdapter(
                    new ArrayAdapter<>(
                        context,
                        android.R.layout.select_dialog_singlechoice,
                        selected.choices().keySet().toArray(new String[0])));
                list.clearChoices();
                for (int i = 0; i < pickerValues[0].length; i++)
                  if (java.util.Objects.equals(pickerValues[0][i], current))
                    list.setItemChecked(i, true);
              }
            });
    row.setOnClickListener(
        v -> {
          Map<String, ?> choices = source.get();
          String[] labels = choices.keySet().toArray(new String[0]);
          Object[] values = choices.values().toArray();
          int checked = -1;
          for (int i = 0; i < values.length; i++)
            if (values[i].equals(host.value(key))) checked = i;
          pickerValues[0] = values;
          picker[0] =
              new AlertDialog.Builder(context)
                  .setTitle(title)
                  .setSingleChoiceItems(
                      labels,
                      checked,
                      (d, index) -> {
                        if (index < pickerValues[0].length)
                          binding.change(
                              pickerValues[0][index], selected -> host.save(key, selected));
                        d.dismiss();
                      })
                  .setNegativeButton(L10n.text("취소"), null)
                  .show();
          openDialogs.add(picker[0]);
          childDialogs.add(picker[0]);
          picker[0].setOnDismissListener(d -> openDialogs.remove((AlertDialog) d));
        });
  }

  private record ChoiceSelection(Object value, Map<String, ?> choices) {}

  void slider(String key, String title, int min, int max, int step, String unit) {
    LinearLayout row = row(title, "");
    row.setOrientation(LinearLayout.VERTICAL);
    row.getChildAt(0).setLayoutParams(new LinearLayout.LayoutParams(-1, -2));
    TextView current = text(host.value(key) + unit, 14, accent);
    row.addView(current);
    SeekBar seek = new SeekBar(context);
    seek.setContentDescription(title);
    seek.setMax((max - min) / step);
    row.addView(seek, new LinearLayout.LayoutParams(-1, dp(42)));
    SettingsControlBinding binding =
        bind(
            () -> host.value(key),
            value -> {
              seek.setProgress((((Number) value).intValue() - min) / step);
              current.setText(value + unit);
            });
    seek.setOnSeekBarChangeListener(
        new SeekBar.OnSeekBarChangeListener() {
          public void onProgressChanged(SeekBar s, int progress, boolean user) {
            if (user) current.setText((min + progress * step) + unit);
          }

          public void onStartTrackingTouch(SeekBar s) {
            binding.beginEdit();
          }

          public void onStopTrackingTouch(SeekBar s) {
            binding.change(min + s.getProgress() * step, value -> host.save(key, value));
            binding.endEdit();
            refreshOpenPanels();
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

  void action(String title, Supplier<String> subtitle, Runnable run) {
    LinearLayout row = row(title, " ");
    TextView description = (TextView) ((LinearLayout) row.getChildAt(0)).getChildAt(1);
    bind(() -> subtitle.get(), value -> description.setText(String.valueOf(value)));
    row.addView(text("›", 21, accent));
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
    openPanels.add(this);
    dialog.setOnDismissListener(
        d -> {
          openDialogs.remove(dialog);
          openPanels.remove(this);
        });
    if (dialog.getWindow() != null) {
      int width =
          Math.min(dp(660), context.getResources().getDisplayMetrics().widthPixels - dp(32));
      int height =
          Math.min(dp(760), context.getResources().getDisplayMetrics().heightPixels - dp(60));
      dialog.getWindow().setLayout(width, height);
    }
    Integer restoreY = reopeningScroll.get();
    if (restoreY != null) {
      scroll
          .getViewTreeObserver()
          .addOnGlobalLayoutListener(
              new android.view.ViewTreeObserver.OnGlobalLayoutListener() {
                @Override
                public void onGlobalLayout() {
                  scroll.getViewTreeObserver().removeOnGlobalLayoutListener(this);
                  if (dialog.isShowing()) scroll.scrollTo(0, restoreY);
                }
              });
    }
  }
}
