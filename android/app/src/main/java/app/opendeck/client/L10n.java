package app.opendeck.client;

import android.content.Context;
import android.text.format.DateFormat;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.regex.*;
import org.json.JSONObject;

/** Product strings only. Configuration labels and remote task/calendar content remain untouched. */
final class L10n {
  private static volatile String code = "ko";
  private static volatile JSONObject catalog = new JSONObject();
  private static final Map<String, JSONObject> catalogs = new HashMap<>();

  static Context context(Context owner) {
    android.view.ContextThemeWrapper wrapper = new android.view.ContextThemeWrapper(owner, owner.getTheme());
    android.content.res.Configuration configuration = new android.content.res.Configuration(owner.getResources().getConfiguration());
    configuration.setLocale(locale());
    configuration.setLayoutDirection(locale());
    wrapper.applyOverrideConfiguration(configuration);
    return wrapper;
  }

  static Locale locale() {
    return Locale.forLanguageTag(code);
  }

  static boolean rtl() {
    return code.equals("ar");
  }

  static synchronized boolean configure(Context context, String requested) {
    String next =
        LocalePolicy.resolve(
            requested,
            context.getResources().getConfiguration().getLocales().get(0).toLanguageTag());
    boolean changed = !code.equals(next);
    if (!catalogs.containsKey(next)) {
      try (java.io.InputStream stream = context.getAssets().open("locales/" + next + ".json")) {
        java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int count;
        while ((count = stream.read(chunk)) != -1) buffer.write(chunk, 0, count);
        catalogs.put(next, new JSONObject(new String(buffer.toByteArray(), StandardCharsets.UTF_8)));
      } catch (Exception ignored) {
        catalogs.put(next, new JSONObject());
      }
    }
    code = next;
    catalog = catalogs.get(next);
    return changed;
  }

  static String text(String source) {
    return code.equals("ko") ? source : catalog.optString(source, source);
  }

  static String format(String source, Object... values) {
    return LocalePolicy.format(text(source), values);
  }

  static String error(String source) {
    if (source == null) return "";
    String direct = text(source);
    if (!direct.equals(source)) return direct;
    Iterator<String> keys = catalog.keys();
    while (keys.hasNext()) {
      String key = keys.next();
      if (!key.matches("(?s).*\\{\\d+\\}.*")) continue;
      Matcher parts = Pattern.compile("\\{(\\d+)\\}").matcher(key);
      StringBuilder regex = new StringBuilder("^");
      List<Integer> slots = new ArrayList<>();
      int end = 0;
      while (parts.find()) {
        regex.append(Pattern.quote(key.substring(end, parts.start()))).append("([\\s\\S]*?)");
        slots.add(Integer.parseInt(parts.group(1)));
        end = parts.end();
      }
      regex.append(Pattern.quote(key.substring(end))).append('$');
      Matcher match = Pattern.compile(regex.toString()).matcher(source);
      if (match.matches()) {
        int max = Collections.max(slots);
        Object[] values = new Object[max + 1];
        for (int i = 0; i < slots.size(); i++) values[slots.get(i)] = match.group(i + 1);
        return LocalePolicy.format(catalog.optString(key, key), values);
      }
    }
    return source;
  }

  static String datePattern(String original) {
    if (code.equals("ko")) return original;
    return switch (original) {
      case "M월 d일 EEEE HH:mm" -> DateFormat.getBestDateTimePattern(locale(), "MMMEdHHmm");
      case "M월 d일 EEEE" -> DateFormat.getBestDateTimePattern(locale(), "MMMEd");
      case "yyyy년 M월" -> DateFormat.getBestDateTimePattern(locale(), "yyyyMMMM");
      default -> original;
    };
  }
}
