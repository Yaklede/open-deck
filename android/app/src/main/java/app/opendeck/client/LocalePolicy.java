package app.opendeck.client;

import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Locale and interpolation rules shared with the native preference validation tests. */
public final class LocalePolicy {
  private LocalePolicy() {}

  public static Map<String, String> languages() {
    Map<String, String> result = new LinkedHashMap<>();
    result.put("system", "System / 기기 설정");
    result.put("ar", "العربية");
    result.put("pt-BR", "Português (Brasil)");
    result.put("cs", "Čeština");
    result.put("nl", "Nederlands");
    result.put("en", "English");
    result.put("fr", "Français");
    result.put("de", "Deutsch");
    result.put("hi", "हिन्दी");
    result.put("id", "Bahasa Indonesia");
    result.put("it", "Italiano");
    result.put("ja", "日本語");
    result.put("ko", "한국어");
    result.put("pl", "Polski");
    result.put("ru", "Русский");
    result.put("zh", "简体中文");
    result.put("es", "Español");
    result.put("zh-TW", "繁體中文");
    result.put("tr", "Türkçe");
    result.put("uk", "Українська");
    return result;
  }

  public static String resolve(String requested, String system) {
    String value = requested == null || requested.equals("system") ? system : requested;
    value = value == null ? "en" : value.replace('_', '-');
    if (value.matches("(?i)zh-(TW|HK|MO|Hant).*")) return "zh-TW";
    if (value.matches("(?i)pt(?:-.*)?")) return "pt-BR";
    String base = value.split("-")[0].toLowerCase(Locale.ROOT);
    return languages().containsKey(value) && !value.equals("system")
        ? value
        : languages().containsKey(base) ? base : "en";
  }

  public static String format(String template, Object... values) {
    Matcher matcher = Pattern.compile("\\{(\\d+)\\}").matcher(template);
    StringBuffer output = new StringBuffer();
    while (matcher.find()) {
      int n = Integer.parseInt(matcher.group(1));
      matcher.appendReplacement(
          output,
          Matcher.quoteReplacement(
              n < values.length ? String.valueOf(values[n]) : matcher.group()));
    }
    matcher.appendTail(output);
    return output.toString();
  }
}
