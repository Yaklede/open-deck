package app.opendeck.client;

import android.app.*;
import android.content.*;
import android.graphics.*;
import android.os.*;
import android.security.keystore.*;
import android.text.InputType;
import android.util.Base64;
import android.util.LruCache;
import android.view.*;
import android.view.inputmethod.InputMethodManager;
import android.widget.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.text.SimpleDateFormat;
import java.util.*;
import java.util.concurrent.*;
import java.util.regex.*;
import javax.crypto.*;
import javax.crypto.spec.GCMParameterSpec;
import org.json.*;

/**
 * Native Canvas renderer. No WebView, JavaScript runtime, third-party analytics or account service.
 */
public class MainActivity extends Activity {
  private final Handler ui = new Handler(Looper.getMainLooper());
  private final ExecutorService commands =
      new ThreadPoolExecutor(0, 4, 15, TimeUnit.SECONDS, new SynchronousQueue<>());
  private final Map<String, Long> pending = new HashMap<>();
  private final Map<String, Integer> colors = new HashMap<>();
  private long serverTime = 0, receivedAt = 0, lastReconnectAt = -5000;
  private volatile long lastEventAt = 0, streamOpenedAt = 0;
  private String renderedConfig = "";
  private final Set<String> runningIds = new HashSet<>();
  private volatile boolean stopped = false, connected = false;
  private boolean foreground = false;
  private volatile HttpURLConnection eventConnection;
  private volatile String token = "", base = ("http://127.0.0.1:" + BuildConfig.USB_PORT);
  private String pageId = "", requestedNavigationPage = "";
  private boolean navigationProfileRequested, deviceMetadataSent;
  private volatile String wifiPin = "", transport = "auto";
  private volatile List<String> wifiUrls = new ArrayList<>();
  private volatile int connectionRevision = 0;
  private String connectionError = "";
  private long lastWifiProbe = -15000;
  private volatile JSONObject config = new JSONObject(), state = new JSONObject();
  private JSONObject savedNavigationCatalog = new JSONObject();
  private DeckView deck;
  private final ExecutorService images = Executors.newFixedThreadPool(2);
  private final Set<String> loadingImages = ConcurrentHashMap.newKeySet();
  private final LruCache<String, Bitmap> bitmapCache =
      new LruCache<String, Bitmap>(32 * 1024 * 1024) {
        @Override
        protected int sizeOf(String key, Bitmap value) {
          return value.getAllocationByteCount();
        }
      };
  private static final Pattern TEMPLATE = Pattern.compile("\\{\\{\\s*([a-zA-Z0-9_]+)\\s*\\}\\}");
  private Typeface font;
  private int osMonthOffset = 0;
  private final Map<String, SimpleDateFormat> osDateFormats = new HashMap<>();
  private final Map<String, Integer> osEventDays = new HashMap<>();
  private final Set<String> osTaskDays = new HashSet<>();
  private long osIndexedAt = -1;
  private final Set<String> deliveredNotifications = new HashSet<>();
  private Thread events;
  private SharedPreferences prefs;
  private final ClientSettingsSync settingsSync = new ClientSettingsSync();
  private final Map<String, Object> clientSettings = settingsSync.values();
  private final Map<String, Object> pendingSettings = settingsSync.pending();
  private final ExecutorService settingRequests = Executors.newSingleThreadExecutor();
  private final ArrayDeque<String> connectionLog = new ArrayDeque<>();
  private String deviceName = Build.MANUFACTURER + " " + Build.MODEL;
  private long lastInteraction = SystemClock.elapsedRealtime();
  private boolean idleDimmed, automaticIdle, cornerConsumed, firstConfig = true;
  private final WakeInteractionGuard wakeGuard = new WakeInteractionGuard();
  private long lastScreenSaverAt;
  private volatile long pairingGeneration;
  private float cornerX, cornerY;
  private final Runnable cornerSettings =
      () -> {
        cornerConsumed = true;
        if (deck != null) {
          deck.releasePress();
          deck.gestureBlocked = true;
        }
        settings();
      };
  private android.net.nsd.NsdManager discoveryManager;
  private android.net.nsd.NsdManager.DiscoveryListener discoveryListener;
  private PopupWindow monitorBanner;
  private final Map<String, Long> lastErrors = new HashMap<>();
  private final Runnable tick =
      new Runnable() {
        public void run() {
          if (foreground
              && !token.isEmpty()
              && !streamFresh()
              && connected
              && SystemClock.elapsedRealtime() - Math.max(lastEventAt, streamOpenedAt) >= 8000
              && SystemClock.elapsedRealtime() - lastReconnectAt >= 5000) {
            lastReconnectAt = SystemClock.elapsedRealtime();
            connected = false;
            connectionRevision++;
            disconnectEvents();
            if (deck != null) {
              deck.updateState();
              deck.invalidate();
            }
          }
          if (deck != null && foreground) {
            if (!idleDimmed
                && ClientSettingsPolicy.shouldDim(
                    SystemClock.elapsedRealtime(),
                    lastInteraction,
                    settingInt("screenSaverMinutes"),
                    true)) setIdleDimmed(true, true);
            deck.tick();
            if (idleDimmed && settingString("screenSaverMode").equals("clock")) deck.invalidate();
          }
          ui.postDelayed(this, 1000);
        }
      };

  @Override
  public void onCreate(Bundle b) {
    super.onCreate(b);
    font =
        new Typeface.Builder(getAssets(), "NotoSansKR.ttf")
            .setFontVariationSettings("'wght' 500")
            .build();
    prefs = getSharedPreferences("open-deck", MODE_PRIVATE);
    loadClientSettings();
    L10n.configure(this, settingString("language"));
    pageId =
        settingBool("rememberPage") ? prefs.getString("page", "") : settingString("startPageId");
    applyNotificationIntent(getIntent());
    transport = prefs.getString("transport", "auto");
    wifiPin = prefs.getString("wifiPin", "");
    try {
      JSONArray urls = new JSONArray(prefs.getString("wifiUrls", "[]"));
      for (int i = 0; i < urls.length(); i++) wifiUrls.add(urls.getString(i));
    } catch (Exception ignored) {
    }
    deliveredNotifications.addAll(
        prefs.getStringSet("deliveredNotifications", Collections.emptySet()));
    NotificationManager notificationManager = getSystemService(NotificationManager.class);
    NotificationChannel channel =
        new NotificationChannel(
            "jimin-os", L10n.text("Jimin OS 일정과 업무"), NotificationManager.IMPORTANCE_DEFAULT);
    channel.setDescription(L10n.text("일정 시작, 할 일 마감, 새 업무 요청을 알려드려요."));
    channel.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
    notificationManager.createNotificationChannel(channel);
    NotificationChannel monitorChannel =
        new NotificationChannel(
            "monitor-alerts", L10n.text("시스템·DB 임계치 알림"), NotificationManager.IMPORTANCE_HIGH);
    monitorChannel.setDescription(L10n.text("주의·위험 임계치 초과와 정상 복구를 알려드려요."));
    monitorChannel.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
    notificationManager.createNotificationChannel(monitorChannel);
    token = readToken();
    loadNavigationCatalog();
    applyClientSettings();
    if (token.isEmpty()) pairScreen();
    else showDeck();
    ui.post(tick);
    if (getIntent().getBooleanExtra("openOS", false)) pageId = "jimin-os-page";
    if (getIntent().getBooleanExtra("openSettings", false)) ui.post(this::settings);
  }

  @Override
  public void onResume() {
    super.onResume();
    foreground = true;
    wakeDisplay();
    if (!token.isEmpty() && !streamFresh()) {
      connectionRevision++;
      disconnectEvents();
    }
    if (deck != null) {
      deck.rebuild();
      deck.updateState();
    }
  }

  @Override
  public void onPause() {
    foreground = false;
    ui.removeCallbacks(cornerSettings);
    setIdleDimmed(false);
    if (monitorBanner != null) monitorBanner.dismiss();
    if (deck != null) {
      deck.finishPageTransition();
      deck.clearVelocity();
      deck.gestureBlocked = true;
    }
    super.onPause();
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    if (intent.getBooleanExtra("openSettings", false)) ui.post(this::settings);
    String previousPage = pageId;
    applyNotificationIntent(intent);
    if (deck != null && (intent.hasExtra("openPage") || intent.getBooleanExtra("openOS", false))) {
      String destination = pageId;
      pageId = previousPage;
      navigate(destination);
      deck.updateState();
    }
  }

  private void applyNotificationIntent(Intent intent) {
    if (intent.getBooleanExtra("openOS", false)) pageId = "jimin-os-page";
    String page = intent.getStringExtra("openPage"),
        group = intent.getStringExtra("projectGroup"),
        project = intent.getStringExtra("project");
    if (page != null && !page.isEmpty()) pageId = page;
    if (intent.getBooleanExtra("openOS", false) || (page != null && !page.isEmpty())) {
      requestedNavigationPage = pageId;
      navigationProfileRequested = false;
    }
    if (group != null && project != null)
      prefs.edit().putString("grafana-project-" + group, project).apply();
  }

  private JSONObject osProvider() {
    JSONObject all = state.optJSONObject("extensions");
    return all == null ? null : all.optJSONObject("jimin-os");
  }

  private JSONObject osData() {
    JSONObject p = osProvider();
    return p == null ? null : p.optJSONObject("data");
  }

  private boolean osFresh() {
    JSONObject provider = osProvider(), data = osData();
    return streamFresh()
        && provider != null
        && data != null
        && provider.optString("status").equals("connected")
        && DataFreshness.osFresh(hostNow(), data.optLong("updatedAt"), true);
  }

  private String osSyncNotice() {
    JSONObject data = osData();
    if (data == null) return L10n.text("OS 연결 대기 · 자동 재연결 중");
    long at = data.optLong("updatedAt"), seconds = Math.max(0, (hostNow() - at) / 1000);
    String age =
        seconds < 60
            ? seconds + L10n.text("초 전")
            : seconds < 3600 ? seconds / 60 + L10n.text("분 전") : seconds / 3600 + L10n.text("시간 전");
    return (osFresh() ? L10n.text("OS 최신") : L10n.text("OS 이전 데이터 · 재연결 중"))
        + " · "
        + osDate(at, "M/d HH:mm:ss")
        + L10n.text(" 수집 · ")
        + age;
  }

  private JSONArray osRows(String key) {
    JSONObject data = osData();
    JSONArray rows = data == null ? null : data.optJSONArray(key);
    return rows == null ? new JSONArray() : rows;
  }

  private long instant(String value) {
    try {
      return java.time.Instant.parse(value).toEpochMilli();
    } catch (Exception ignored) {
      return 0;
    }
  }

  private String osDate(long at, String pattern) {
    SimpleDateFormat formatter = osDateFormats.get(pattern);
    if (formatter == null) {
      formatter =
          new SimpleDateFormat(
              L10n.datePattern(pattern),
              pattern.equals("yyyy-MM-dd") ? Locale.ROOT : L10n.locale());
      formatter.setTimeZone(TimeZone.getTimeZone("Asia/Seoul"));
      osDateFormats.put(pattern, formatter);
    }
    return formatter.format(new Date(at));
  }

  private void indexOSCalendar() {
    JSONObject data = osData();
    long revision = data == null ? 0 : data.optLong("updatedAt");
    if (osIndexedAt == revision) return;
    osIndexedAt = revision;
    osEventDays.clear();
    osTaskDays.clear();
    JSONArray events = osRows("events");
    for (int i = 0; i < events.length(); i++) {
      long at = instant(events.optJSONObject(i).optString("startsAt"));
      if (at > 0) {
        long end = instant(events.optJSONObject(i).optString("endsAt"));
        java.time.ZoneId zone = java.time.ZoneId.of("Asia/Seoul");
        java.time.LocalDate day = java.time.Instant.ofEpochMilli(at).atZone(zone).toLocalDate();
        java.time.LocalDate last =
            java.time.Instant.ofEpochMilli(Math.max(at, end - 1)).atZone(zone).toLocalDate();
        for (int count = 0; count < 63 && !day.isAfter(last); count++, day = day.plusDays(1)) {
          String key = day.toString();
          osEventDays.put(key, osEventDays.getOrDefault(key, 0) + 1);
        }
      }
    }
    JSONArray tasks = osRows("tasks");
    for (int i = 0; i < tasks.length(); i++) {
      long at = instant(tasks.optJSONObject(i).optString("dueAt"));
      if (at > 0) osTaskDays.add(osDate(at, "yyyy-MM-dd"));
    }
  }

  private void showMonitorBanner(JSONObject notification, Intent open) {
    if (monitorBanner != null) monitorBanner.dismiss();
    LinearLayout row = new LinearLayout(this);
    row.setOrientation(LinearLayout.HORIZONTAL);
    row.setPadding((int) dp(16), (int) dp(12), (int) dp(8), (int) dp(12));
    android.graphics.drawable.GradientDrawable background =
        new android.graphics.drawable.GradientDrawable();
    background.setColor(Color.parseColor("#172631"));
    background.setCornerRadius(dp(14));
    background.setStroke((int) dp(2), monitorColor(notification.optString("severity")));
    row.setBackground(background);
    LinearLayout messages = new LinearLayout(this);
    messages.setOrientation(LinearLayout.VERTICAL);
    row.addView(messages, new LinearLayout.LayoutParams(0, -2, 1f));
    TextView title = new TextView(this);
    title.setTypeface(font, Typeface.BOLD);
    title.setTextSize(17);
    title.setIncludeFontPadding(false);
    title.setTextColor(monitorColor(notification.optString("severity")));
    title.setText(notification.optString("title"));
    messages.addView(title);
    TextView body = new TextView(this);
    body.setTypeface(font);
    body.setTextSize(14);
    body.setIncludeFontPadding(false);
    body.setTextColor(Color.parseColor("#e0e9fa"));
    body.setPadding(0, (int) dp(7), 0, 0);
    body.setText(notification.optString("body"));
    messages.addView(body);
    TextView close = new TextView(this);
    close.setText("×");
    close.setTextSize(24);
    close.setTextColor(Color.parseColor("#e0e9fa"));
    close.setGravity(Gravity.CENTER);
    close.setContentDescription(L10n.text("모니터 알림 닫기"));
    row.addView(close, new LinearLayout.LayoutParams((int) dp(42), (int) dp(42)));
    PopupWindow popup =
        new PopupWindow(
            row,
            (int) Math.min(dp(650), getResources().getDisplayMetrics().widthPixels - dp(36)),
            ViewGroup.LayoutParams.WRAP_CONTENT,
            false);
    popup.setElevation(dp(12));
    popup.setOutsideTouchable(false);
    popup.setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(Color.TRANSPARENT));
    close.setOnClickListener(v -> popup.dismiss());
    messages.setOnClickListener(
        v -> {
          popup.dismiss();
          String previous = pageId;
          applyNotificationIntent(open);
          String destination = pageId;
          pageId = previous;
          navigate(destination);
          if (deck != null) deck.updateState();
        });
    monitorBanner = popup;
    popup.showAtLocation(deck, Gravity.TOP | Gravity.CENTER_HORIZONTAL, 0, (int) dp(18));
    ui.postDelayed(
        () -> {
          if (monitorBanner == popup) popup.dismiss();
        },
        12000);
  }

  private void showOSNotifications() {
    JSONObject provider = osProvider();
    if (((provider != null && provider.optBoolean("enabled"))
            || (state.optJSONObject("monitoring") != null
                && state.optJSONObject("monitoring").optJSONObject("widgets") != null
                && state.optJSONObject("monitoring").optJSONObject("widgets").length() > 0))
        && foreground
        && Build.VERSION.SDK_INT >= 33
        && !prefs.getBoolean("osNotificationPermissionAsked", false)) {
      prefs.edit().putBoolean("osNotificationPermissionAsked", true).apply();
      if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
          != android.content.pm.PackageManager.PERMISSION_GRANTED)
        requestPermissions(new String[] {android.Manifest.permission.POST_NOTIFICATIONS}, 71);
    }
    JSONArray feed = state.optJSONArray("notifications");
    if (feed == null) return;
    boolean permission =
        Build.VERSION.SDK_INT < 33
            || checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                == android.content.pm.PackageManager.PERMISSION_GRANTED;
    boolean updated = false;
    int shown = 0;
    for (int i = feed.length() - 1; i >= 0; i--) {
      JSONObject n = feed.optJSONObject(i);
      if (n == null) continue;
      String id = n.optString("id");
      if (id.isEmpty() || deliveredNotifications.contains(id)) continue;
      boolean monitor = n.optString("kind").equals("monitor");
      if (!(monitor ? settingBool("monitorNotifications") : settingBool("osNotifications"))) {
        deliveredNotifications.add(id);
        updated = true;
        continue;
      }
      if (!permission && !(monitor && foreground)) continue;
      deliveredNotifications.add(id);
      updated = true;
      if (hostNow() - n.optLong("createdAt") > 3600000 || shown >= 3) continue;
      Intent open =
          new Intent(this, MainActivity.class)
              .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
      if (monitor) {
        open.putExtra("openPage", n.optString("pageId"));
        JSONArray pages = config.optJSONArray("pages");
        if (pages != null)
          for (int pi = 0; pi < pages.length(); pi++) {
            JSONArray widgets = pages.optJSONObject(pi).optJSONArray("widgets");
            if (widgets != null)
              for (int wi = 0; wi < widgets.length(); wi++) {
                JSONObject widget = widgets.optJSONObject(wi);
                if (widget.optString("id").equals(n.optString("widgetId")))
                  open.putExtra(
                          "projectGroup", widget.optString("projectGroup", widget.optString("id")))
                      .putExtra("project", n.optString("project"));
              }
          }
        if (foreground && shown == 0 && settingBool("notificationBanner"))
          showMonitorBanner(n, open);
      } else open.putExtra("openOS", true);
      PendingIntent pending =
          PendingIntent.getActivity(
              this,
              n.optString("id").hashCode(),
              open,
              PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
      Notification notification =
          new Notification.Builder(this, monitor ? "monitor-alerts" : "jimin-os")
              .setSmallIcon(app.opendeck.client.R.drawable.opendeck_icon)
              .setContentTitle(n.optString("title"))
              .setContentText(n.optString("body"))
              .setStyle(new Notification.BigTextStyle().bigText(n.optString("body")))
              .setVisibility(Notification.VISIBILITY_PRIVATE)
              .setContentIntent(pending)
              .setAutoCancel(true)
              .setGroup(monitor ? "monitor-alerts" : "jimin-os")
              .build();
      if (permission)
        getSystemService(NotificationManager.class).notify(id.hashCode(), notification);
      wakeDisplay();
      shown++;
    }
    if (updated) {
      if (deliveredNotifications.size() > 200) {
        deliveredNotifications.clear();
        for (int i = 0; i < feed.length(); i++)
          deliveredNotifications.add(feed.optJSONObject(i).optString("id"));
      }
      prefs
          .edit()
          .putStringSet("deliveredNotifications", new HashSet<>(deliveredNotifications))
          .apply();
    }
  }

  @Override
  public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
    super.onRequestPermissionsResult(request, permissions, results);
    if (request == 71) showOSNotifications();
  }

  private JSONObject macSystem() {
    JSONObject data = state.optJSONObject("system");
    return connected
            && data != null
            && data.optString("status").equals("connected")
            && hostNow() - data.optLong("capturedAt") < 10000
        ? data
        : null;
  }

  private String metricBytes(double value) {
    if (!Double.isFinite(value) || value < 0) return "—";
    String[] units = {"B", "KiB", "MiB", "GiB", "TiB"};
    int i = 0;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i++;
    }
    return String.format(L10n.locale(), value >= 100 ? "%.0f %s" : "%.1f %s", value, units[i]);
  }

  private double metric(JSONObject data, String key) {
    return data == null || data.isNull(key) ? Double.NaN : data.optDouble(key, Double.NaN);
  }

  private String metricPercent(double value) {
    return Double.isFinite(value) ? String.format(L10n.locale(), "%.1f%%", value) : "—";
  }

  private String pressureText(String value) {
    return value.equals("normal")
        ? L10n.text("정상")
        : value.equals("warning")
            ? L10n.text("주의")
            : value.equals("critical") ? L10n.text("높음") : L10n.text("확인 중");
  }

  private String thermalText(String value) {
    return value.equals("normal")
        ? L10n.text("정상")
        : value.equals("fair")
            ? L10n.text("약간 높음")
            : value.equals("serious")
                ? L10n.text("높음")
                : value.equals("critical") ? L10n.text("매우 높음") : L10n.text("확인 중");
  }

  private List<String> systemWarnings(JSONObject data) {
    List<String> warnings = new ArrayList<>();
    JSONObject mem = data.optJSONObject("memory"),
        disk = data.optJSONObject("disk"),
        power = data.optJSONObject("power");
    if (mem != null
        && (mem.optString("pressure").equals("warning")
            || mem.optString("pressure").equals("critical")))
      warnings.add(L10n.text("메모리 압력 ") + pressureText(mem.optString("pressure")));
    double available = metric(disk, "availableBytes"), total = metric(disk, "totalBytes");
    if (Double.isFinite(available)
        && (available < 20d * 1024 * 1024 * 1024 || available / total < .05))
      warnings.add(L10n.text("저장 공간 여유 ") + metricBytes(available));
    if (power != null
        && (power.optString("thermal").equals("serious")
            || power.optString("thermal").equals("critical")))
      warnings.add(L10n.text("발열 부담 ") + thermalText(power.optString("thermal")));
    return warnings;
  }

  private String systemDetailText(JSONObject data, String kind) {
    StringBuilder body = new StringBuilder();
    JSONObject cpu = data.optJSONObject("cpu"),
        memory = data.optJSONObject("memory"),
        disk = data.optJSONObject("disk"),
        power = data.optJSONObject("power"),
        network = data.optJSONObject("network"),
        io = data.optJSONObject("io");
    if (kind.equals("overview")) {
      body.append(data.optString("model", L10n.text("내 Mac")))
          .append(" · ")
          .append(data.optInt("logicalCores"))
          .append(L10n.text("코어\n"));
      List<String> alerts = systemWarnings(data);
      body.append(alerts.isEmpty() ? L10n.text("확인할 상태가 없어요.") : String.join("\n", alerts))
          .append("\n\n");
    }
    if (kind.equals("cpu") || kind.equals("overview")) {
      body.append(L10n.text("전체 CPU  ")).append(metricPercent(metric(cpu, "percent"))).append("\n");
      JSONArray cores = cpu == null ? null : cpu.optJSONArray("cores");
      if (cores != null)
        for (int i = 0; i < cores.length(); i++)
          body.append(L10n.text("코어 "))
              .append(i + 1)
              .append("  ")
              .append(metricPercent(cores.optDouble(i, Double.NaN)))
              .append(i % 2 == 0 ? "     " : "\n");
      body.append("\n");
    }
    if (kind.equals("memory") || kind.equals("overview")) {
      body.append(L10n.text("메모리  "))
          .append(metricGiB(metric(memory, "usedBytes")))
          .append(" / ")
          .append(metricGiB(metric(memory, "totalBytes")))
          .append(" · ")
          .append(
              metricPercent(
                  metric(memory, "totalBytes") > 0
                      ? 100 * metric(memory, "usedBytes") / metric(memory, "totalBytes")
                      : Double.NaN))
          .append(L10n.text("\n압력  "))
          .append(pressureText(memory == null ? "" : memory.optString("pressure")))
          .append(L10n.text("\n앱  "))
          .append(metricBytes(metric(memory, "appBytes")))
          .append(L10n.text("\n시스템 고정  "))
          .append(metricBytes(metric(memory, "wiredBytes")))
          .append(L10n.text("\n압축  "))
          .append(metricBytes(metric(memory, "compressedBytes")))
          .append(L10n.text("\n스왑  "))
          .append(metricBytes(metric(memory, "swapBytes")))
          .append("\n\n");
    }
    if (kind.equals("disk") || kind.equals("overview")) {
      body.append(L10n.text("내장 저장 공간  "))
          .append(metricBytes(metric(disk, "totalBytes")))
          .append(L10n.text("\n사용 가능  "))
          .append(metricBytes(metric(disk, "availableBytes")))
          .append(L10n.text("\n읽기  "))
          .append(metricBytes(metric(io, "readBytesPerSecond")))
          .append(L10n.text("/s\n쓰기  "))
          .append(metricBytes(metric(io, "writeBytesPerSecond")))
          .append(L10n.text("/s\nAPFS 공유 공간 기준 · I/O는 전체 저장 장치 합계\n\n"));
    }
    if (kind.equals("network") || kind.equals("overview")) {
      body.append(L10n.text("네트워크 수신  "))
          .append(metricBytes(metric(network, "rxBytesPerSecond")))
          .append(L10n.text("/s\n송신  "))
          .append(metricBytes(metric(network, "txBytesPerSecond")))
          .append(L10n.text("/s\n활성 유선·Wi-Fi 인터페이스 합계 (VPN 중복 제외)\n\n"));
    }
    if (kind.equals("power") || kind.equals("overview")) {
      body.append(L10n.text("배터리  "))
          .append(metricPercent(metric(power, "batteryPercent")))
          .append(L10n.text("\n전원  "))
          .append(
              power != null && power.optBoolean("pluggedIn")
                  ? L10n.text("전원 연결됨")
                  : L10n.text("배터리 사용 중"))
          .append(L10n.text("\n발열 부담  "))
          .append(thermalText(power == null ? "" : power.optString("thermal")))
          .append("\n");
    }
    return body.toString();
  }

  private void systemDetails(JSONObject widget) {
    JSONObject data = macSystem();
    if (data == null) {
      osDialog()
          .setTitle(L10n.text("맥 상태 연결 대기"))
          .setMessage(L10n.text("맥의 최신 상태를 기다리고 있어요."))
          .setPositiveButton(L10n.text("닫기"), null)
          .show();
      return;
    }
    String kind = widget.optString("metric", "overview");
    if (kind.equals("processes")) {
      systemProcesses(data, false);
      return;
    }
    if (kind.equals("overview")) {
      systemTabs(widget);
      return;
    }
    TextView text = new TextView(this);
    text.setText(systemDetailText(data, kind));
    text.setTextSize(16);
    text.setPadding((int) dp(24), (int) dp(8), (int) dp(24), (int) dp(8));
    ScrollView scroll = new ScrollView(this);
    scroll.addView(text);
    osDialog()
        .setTitle(widget.optString("label", L10n.text("맥 상태")))
        .setView(scroll)
        .setPositiveButton(L10n.text("닫기"), null)
        .show();
  }

  private void systemTabs(JSONObject widget) {
    String[] names = {
      "CPU", L10n.text("메모리"), L10n.text("저장 공간"), L10n.text("전원·발열"), L10n.text("네트워크")
    };
    String[] kinds = {"cpu", "memory", "disk", "power", "network"};
    int[] selected = {0};
    LinearLayout layout = new LinearLayout(this);
    layout.setOrientation(LinearLayout.VERTICAL);
    layout.setPadding((int) dp(16), (int) dp(8), (int) dp(16), 0);
    HorizontalScrollView tabsScroll = new HorizontalScrollView(this);
    tabsScroll.setHorizontalScrollBarEnabled(false);
    LinearLayout tabs = new LinearLayout(this);
    tabs.setOrientation(LinearLayout.HORIZONTAL);
    tabsScroll.addView(tabs);
    layout.addView(tabsScroll);
    Button[] buttons = new Button[names.length];
    TextView text = new TextView(this);
    text.setTextSize(16);
    text.setTypeface(font);
    text.setPadding((int) dp(8), (int) dp(18), (int) dp(8), (int) dp(12));
    ScrollView content = new ScrollView(this);
    content.addView(text);
    LinearLayout detailRow = new LinearLayout(this);
    detailRow.setOrientation(LinearLayout.HORIZONTAL);
    android.graphics.drawable.GradientDrawable statsBackground =
        new android.graphics.drawable.GradientDrawable();
    statsBackground.setColor(Color.parseColor("#172631"));
    statsBackground.setCornerRadius(dp(12));
    content.setBackground(statsBackground);
    LinearLayout.LayoutParams statsParams = new LinearLayout.LayoutParams(0, -1, 1f);
    statsParams.setMargins(0, (int) dp(12), (int) dp(8), 0);
    detailRow.addView(content, statsParams);
    MacHistoryView graph = new MacHistoryView(selected, kinds);
    LinearLayout.LayoutParams graphParams = new LinearLayout.LayoutParams(0, -1, 1.3f);
    graphParams.setMargins((int) dp(4), (int) dp(12), 0, 0);
    detailRow.addView(graph, graphParams);
    layout.addView(detailRow, new LinearLayout.LayoutParams(-1, (int) dp(320)));
    Runnable render =
        () -> {
          JSONObject latest = macSystem();
          text.setText(
              latest == null
                  ? L10n.text("맥 연결과 최신 상태를 기다리고 있어요.")
                  : systemDetailText(latest, kinds[selected[0]]));
          graph.invalidate();
          for (int i = 0; i < buttons.length; i++) {
            Button b = buttons[i];
            if (b == null) continue;
            boolean active = i == selected[0];
            if (Boolean.valueOf(active).equals(b.getTag())) continue;
            b.setTag(active);
            b.setSelected(i == selected[0]);
            b.setTextColor(Color.parseColor(i == selected[0] ? "#d9f4fa" : "#9bafbd"));
            android.graphics.drawable.GradientDrawable bg =
                new android.graphics.drawable.GradientDrawable();
            bg.setColor(Color.parseColor(i == selected[0] ? "#36505e" : "#1f2b36"));
            bg.setCornerRadius(dp(9));
            b.setBackground(bg);
          }
        };
    for (int i = 0; i < names.length; i++) {
      final int index = i;
      Button b = new Button(this);
      buttons[i] = b;
      b.setText(names[i]);
      b.setAllCaps(false);
      b.setTextSize(12);
      b.setMinWidth(0);
      b.setMinimumWidth(0);
      b.setContentDescription(names[i] + L10n.text(" 상세 탭"));
      LinearLayout.LayoutParams params = new LinearLayout.LayoutParams((int) dp(99), (int) dp(43));
      params.setMargins((int) dp(2), 0, (int) dp(2), 0);
      tabs.addView(b, params);
      b.setOnClickListener(
          v -> {
            selected[0] = index;
            content.scrollTo(0, 0);
            render.run();
          });
    }
    AlertDialog dialog =
        osDialog()
            .setTitle(widget.optString("label", L10n.text("내 Mac")) + L10n.text(" · 상세"))
            .setView(layout)
            .setPositiveButton(L10n.text("닫기"), null)
            .setNeutralButton(
                L10n.text("앱별 사용량"),
                (d, x) -> {
                  JSONObject latest = macSystem();
                  if (latest != null) systemProcesses(latest, false);
                })
            .show();
    Runnable refresh =
        new Runnable() {
          public void run() {
            if (!dialog.isShowing()) return;
            render.run();
            ui.postDelayed(this, 2000);
          }
        };
    dialog.setOnDismissListener(d -> ui.removeCallbacks(refresh));
    render.run();
    ui.postDelayed(refresh, 2000);
  }

  private class MacHistoryView extends View {
    final int[] selected;
    final String[] kinds;
    final Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
    final Path line = new Path();
    final RectF plot = new RectF();

    MacHistoryView(int[] selected, String[] kinds) {
      super(MainActivity.this);
      this.selected = selected;
      this.kinds = kinds;
      setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_YES);
      setContentDescription(L10n.text("맥 상태 실시간 추이 그래프"));
    }

    void text(Canvas c, String value, float x, float y, float size, int color, Paint.Align align) {
      p.setStyle(Paint.Style.FILL);
      p.setColor(color);
      p.setTypeface(font);
      p.setTextLocale(L10n.locale());
      p.setTextSize(dp(size));
      p.setTextAlign(align);
      c.drawText(value, x, y, p);
    }

    void curve(Canvas c, JSONArray values, double max, int color) {
      if (values == null || values.length() < 2) return;
      line.rewind();
      boolean started = false;
      for (int i = 0; i < values.length(); i++) {
        double v = values.optDouble(i, Double.NaN);
        if (values.isNull(i) || !Double.isFinite(v)) {
          started = false;
          continue;
        }
        float x = plot.left + plot.width() * i / Math.max(1, values.length() - 1),
            y = plot.bottom - (float) Math.max(0, Math.min(1, v / max)) * plot.height();
        if (started) line.lineTo(x, y);
        else line.moveTo(x, y);
        started = true;
      }
      p.setStyle(Paint.Style.STROKE);
      p.setStrokeWidth(dp(2));
      p.setColor(color);
      c.drawPath(line, p);
      p.setStyle(Paint.Style.FILL);
    }

    @Override
    protected void onDraw(Canvas c) {
      String kind = kinds[selected[0]],
          first = "cpu",
          second = null,
          title = L10n.text("CPU 추이"),
          legend = L10n.text("전체 CPU");
      boolean percent = true;
      int accent = Color.parseColor("#86b6ef"),
          other = Color.parseColor("#83cbb9"),
          muted = Color.parseColor("#9bafbd");
      if (kind.equals("memory")) {
        first = "memory";
        title = L10n.text("메모리 사용률");
        legend = L10n.text("물리 메모리 대비");
        accent = Color.parseColor("#b6a6ec");
      } else if (kind.equals("disk")) {
        first = "read";
        second = "write";
        title = L10n.text("디스크 I/O 추이");
        legend = L10n.text("읽기");
        percent = false;
        other = Color.parseColor("#efbd73");
      } else if (kind.equals("network")) {
        first = "rx";
        second = "tx";
        title = L10n.text("네트워크 추이");
        legend = L10n.text("수신");
        percent = false;
      } else if (kind.equals("power")) {
        first = "battery";
        title = L10n.text("배터리 추이");
        legend = L10n.text("배터리 잔량");
        accent = Color.parseColor("#83cbb9");
      }
      p.setStyle(Paint.Style.FILL);
      p.setColor(Color.parseColor("#172631"));
      c.drawRoundRect(0, 0, getWidth(), getHeight(), dp(12), dp(12), p);
      text(c, title, dp(16), dp(28), 14, Color.parseColor("#d9f4fa"), Paint.Align.LEFT);
      text(c, legend, dp(16), dp(49), 10, accent, Paint.Align.LEFT);
      if (second != null) {
        text(
            c,
            kind.equals("disk") ? L10n.text("쓰기") : L10n.text("송신"),
            getWidth() - dp(16),
            dp(49),
            10,
            other,
            Paint.Align.RIGHT);
      }
      JSONObject data = macSystem(), history = data == null ? null : data.optJSONObject("history");
      JSONArray a = history == null ? null : history.optJSONArray(first),
          b = history == null || second == null ? null : history.optJSONArray(second);
      plot.set(dp(58), dp(77), getWidth() - dp(16), getHeight() - dp(39));
      double max = percent ? 100 : 1;
      if (!percent) {
        for (JSONArray rows : new JSONArray[] {a, b})
          if (rows != null)
            for (int i = 0; i < rows.length(); i++)
              if (!rows.isNull(i)) max = Math.max(max, rows.optDouble(i));
      }
      for (int i = 0; i < 3; i++) {
        float y = plot.top + plot.height() * i / 2;
        p.setColor(Color.parseColor("#2b414f"));
        p.setStrokeWidth(dp(1));
        c.drawLine(plot.left, y, plot.right, y, p);
        double value = max * (2 - i) / 2;
        text(
            c,
            percent ? String.format(L10n.locale(), "%.0f%%", value) : metricBytes(value) + "/s",
            plot.left - dp(8),
            y + dp(3),
            8,
            muted,
            Paint.Align.RIGHT);
      }
      if (a == null || a.length() < 2)
        text(
            c, L10n.text("추이 수집 중"), plot.centerX(), plot.centerY(), 12, muted, Paint.Align.CENTER);
      else {
        curve(c, a, max, accent);
        curve(c, b, max, other);
      }
      text(c, L10n.text("이전"), plot.left, getHeight() - dp(17), 9, muted, Paint.Align.LEFT);
      text(
          c,
          L10n.text("지금 · 2초 갱신"),
          plot.right,
          getHeight() - dp(17),
          9,
          muted,
          Paint.Align.RIGHT);
    }
  }

  private class GrafanaHistoryView extends MacHistoryView {
    final JSONObject widget;
    String chartMetric;

    GrafanaHistoryView(JSONObject widget) {
      super(new int[] {0}, new String[] {"cpu"});
      this.widget = widget;
      chartMetric = widget.optString("metric").equals("system") ? "system" : "cpu";
      setContentDescription(L10n.text("Grafana 최근 1시간 추이 그래프"));
    }

    @Override
    protected void onDraw(Canvas c) {
      boolean percent =
          chartMetric.equals("system") || chartMetric.equals("cpu") || chartMetric.equals("memory");
      boolean system = chartMetric.equals("system");
      int accent = monitorColor(widget, system ? "cpu" : chartMetric),
          muted = Color.parseColor("#9bafbd");
      p.setStyle(Paint.Style.FILL);
      p.setColor(Color.parseColor("#172631"));
      c.drawRoundRect(0, 0, getWidth(), getHeight(), dp(12), dp(12), p);
      text(
          c,
          system
              ? L10n.text("시스템 CPU 추이")
              : chartMetric.equals("cpu")
                  ? L10n.text("DB CPU 추이")
                  : chartMetric.equals("memory")
                      ? L10n.text("DB 메모리 추이")
                      : chartMetric.equals("qps")
                          ? L10n.text("QPS · 쿼리/초")
                          : L10n.text("TPS · 커밋/초"),
          dp(16),
          dp(29),
          14,
          Color.parseColor("#d9f4fa"),
          Paint.Align.LEFT);
      text(c, L10n.text("최근 1시간"), dp(16), dp(50), 10, muted, Paint.Align.LEFT);
      JSONObject data = grafanaData(widget),
          metric = data == null ? null : data.optJSONObject(chartMetric);
      JSONArray points = metric == null ? null : metric.optJSONArray("points");
      plot.set(dp(45), dp(76), getWidth() - dp(16), getHeight() - dp(39));
      double max = percent ? 100 : 1;
      if (!percent && points != null)
        for (int i = 0; i < points.length(); i++)
          max = Math.max(max, points.optJSONArray(i).optDouble(1));
      for (int i = 0; i < 3; i++) {
        float y = plot.top + plot.height() * i / 2;
        p.setColor(Color.parseColor("#2b414f"));
        p.setStrokeWidth(dp(1));
        c.drawLine(plot.left, y, plot.right, y, p);
        text(
            c,
            String.format(L10n.locale(), percent ? "%.0f%%" : "%.1f", max * (2 - i) / 2),
            plot.left - dp(6),
            y + dp(3),
            9,
            muted,
            Paint.Align.RIGHT);
      }
      if (points == null || points.length() < 2)
        text(
            c,
            L10n.text("수집 데이터 없음"),
            plot.centerX(),
            plot.centerY(),
            12,
            muted,
            Paint.Align.CENTER);
      else if (deck != null) deck.grafanaTrend(c, points, plot, accent, percent);
      text(c, L10n.text("이전"), plot.left, getHeight() - dp(16), 9, muted, Paint.Align.LEFT);
      text(c, L10n.text("최근"), plot.right, getHeight() - dp(16), 9, muted, Paint.Align.RIGHT);
    }
  }

  private void systemProcesses(JSONObject data, boolean memoryOrder) {
    JSONObject processes = data.optJSONObject("processes");
    JSONArray rows =
        processes == null ? null : processes.optJSONArray(memoryOrder ? "memory" : "cpu");
    StringBuilder body =
        new StringBuilder(
            L10n.text("CPU 100%는 1코어 사용량이에요. 약 6초 간격으로 비교하며 메모리는 앱의 물리적 사용량을 보여줘요.\n\n"));
    if (rows != null)
      for (int i = 0; i < rows.length(); i++) {
        JSONObject row = rows.optJSONObject(i);
        if (row == null) continue;
        body.append(row.optString("name"))
            .append("  (PID ")
            .append(row.optInt("pid"))
            .append(")\nCPU ")
            .append(metricPercent(metric(row, "cpuPercent")))
            .append(L10n.text(" · 메모리 "))
            .append(metricBytes(metric(row, "memoryBytes")))
            .append("\n\n");
      }
    if (rows == null || rows.length() == 0)
      body.append(L10n.text("사용량을 비교하고 있어요. 잠시 후 다시 확인해 주세요."));
    osDialog()
        .setTitle(memoryOrder ? L10n.text("메모리를 많이 쓰는 앱") : L10n.text("CPU를 많이 쓰는 앱"))
        .setMessage(body.toString())
        .setPositiveButton(
            memoryOrder ? L10n.text("CPU 순으로") : L10n.text("메모리 순으로"),
            (d, x) -> {
              JSONObject latest = macSystem();
              if (latest != null) systemProcesses(latest, !memoryOrder);
            })
        .setNegativeButton(L10n.text("닫기"), null)
        .show();
  }

  private JSONObject grafanaProject(JSONObject widget) {
    JSONArray projects = widget.optJSONArray("projects");
    if (projects == null || projects.length() == 0) return new JSONObject();
    String selected =
        prefs.getString(
            "grafana-project-" + widget.optString("projectGroup", widget.optString("id")),
            widget.optString("defaultProject", projects.optJSONObject(0).optString("value")));
    for (int i = 0; i < projects.length(); i++)
      if (projects.optJSONObject(i).optString("value").equals(selected))
        return projects.optJSONObject(i);
    return projects.optJSONObject(0);
  }

  private void grafanaChoose(JSONObject widget) {
    JSONArray projects = widget.optJSONArray("projects");
    if (projects == null) return;
    String[] labels = new String[projects.length()];
    int selected = 0;
    for (int i = 0; i < labels.length; i++) {
      labels[i] = projects.optJSONObject(i).optString("label");
      if (projects
          .optJSONObject(i)
          .optString("value")
          .equals(grafanaProject(widget).optString("value"))) selected = i;
    }
    osDialog()
        .setTitle(L10n.text("Grafana 프로젝트"))
        .setSingleChoiceItems(
            labels,
            selected,
            (d, index) -> {
              prefs
                  .edit()
                  .putString(
                      "grafana-project-" + widget.optString("projectGroup", widget.optString("id")),
                      projects.optJSONObject(index).optString("value"))
                  .apply();
              deck.refresh(widget.optString("id"));
              deck.updateState();
              d.dismiss();
            })
        .setNegativeButton(L10n.text("닫기"), null)
        .show();
  }

  private JSONObject grafanaData(JSONObject widget) {
    JSONObject all = state.optJSONObject("grafana");
    JSONObject widgets = all == null ? null : all.optJSONObject("widgets");
    JSONObject entry = widgets == null ? null : widgets.optJSONObject(widget.optString("id"));
    JSONObject projects = entry == null ? null : entry.optJSONObject("projects");
    JSONObject data =
        projects == null ? null : projects.optJSONObject(grafanaProject(widget).optString("value"));
    return data;
  }

  private boolean streamFresh() {
    return DataFreshness.streamFresh(connected, SystemClock.elapsedRealtime(), lastEventAt);
  }

  private JSONObject sourceMeta(JSONObject data, String key) {
    JSONObject freshness = data == null ? null : data.optJSONObject("freshness");
    return freshness == null ? null : freshness.optJSONObject(key);
  }

  private String sourceKey(JSONObject widget, String key) {
    return key.equals("cpu") && widget.optString("metric").equals("system") ? "system" : key;
  }

  private int sourceState(JSONObject data, String key) {
    JSONObject meta = sourceMeta(data, key);
    return meta == null
        ? DataFreshness.MISSING
        : DataFreshness.classify(
            hostNow(),
            meta.optLong("sampleAt") > 0 ? meta.optLong("sampleAt") : meta.optLong("lastSampleAt"),
            meta.optLong("warnAfterMs", 180000),
            meta.optLong("staleAfterMs", 300000));
  }

  private boolean queryFresh(JSONObject data) {
    return streamFresh()
        && data != null
        && data.optString("status").equals("ready")
        && hostNow() - data.optLong("capturedAt") < 90000;
  }

  private double visibleGrafanaValue(JSONObject widget, String key, double value) {
    JSONObject data = grafanaData(widget);
    int status = sourceState(data, sourceKey(widget, key));
    return queryFresh(data) && status != DataFreshness.STALE && status != DataFreshness.MISSING
        ? value
        : Double.NaN;
  }

  private int grafanaReadingColor(JSONObject widget, String key, double value) {
    JSONObject data = grafanaData(widget);
    int status = sourceState(data, sourceKey(widget, key));
    if (!queryFresh(data) || status == DataFreshness.STALE || status == DataFreshness.MISSING)
      return monitorColor("unknown");
    int severity = monitorValueColor(widget, key, value);
    return status == DataFreshness.DELAYED && severity != monitorColor("critical")
        ? monitorColor("warning")
        : severity;
  }

  private String sourceAge(long at) {
    if (at <= 0) return L10n.text("시각 없음");
    long seconds = Math.max(0, (hostNow() - at) / 1000);
    return seconds < 60
        ? seconds + L10n.text("초 전")
        : seconds < 3600 ? seconds / 60 + L10n.text("분 전") : seconds / 3600 + L10n.text("시간 전");
  }

  private String sourceStamp(JSONObject data, String key) {
    JSONObject meta = sourceMeta(data, key);
    long at = meta == null ? 0 : meta.optLong("sampleAt");
    if (at <= 0) {
      long last = meta == null ? 0 : meta.optLong("lastSampleAt");
      return last > 0
          ? L10n.text("마지막 수집 ") + osDate(last, "HH:mm:ss") + " · " + sourceAge(last)
          : L10n.text("수집 시각 없음");
    }
    return L10n.text("수집 ") + osDate(at, "HH:mm:ss") + " · " + sourceAge(at);
  }

  private String freshnessNotice(JSONObject widget, JSONObject data) {
    if (!streamFresh()) return L10n.text("연결 끊김");
    if (!queryFresh(data)) return L10n.text("조회 중단");
    String[] keys =
        widget.optString("metric").equals("system")
            ? new String[] {"system", "collection"}
            : new String[] {"cpu", "memory", "tps", "qps", "connections", "ready"};
    boolean delayed = false, missing = false, any = false;
    for (String key : keys) {
      int status = sourceState(data, key);
      if (status == DataFreshness.STALE) return L10n.text("오래된 데이터");
      if (status == DataFreshness.DELAYED) delayed = true;
      JSONObject meta = sourceMeta(data, key);
      if (meta != null && meta.optInt("missingSeries") > 0) missing = true;
      if (status == DataFreshness.MISSING) missing = true;
      else any = true;
    }
    return delayed
        ? L10n.text("수집 지연")
        : missing ? (any ? L10n.text("일부 수집 없음") : L10n.text("수집 없음")) : null;
  }

  private String metricGiB(double value) {
    return Double.isFinite(value) && value >= 0
        ? String.format(L10n.locale(), "%.1f GiB", value / 1073741824d)
        : "—";
  }

  private JSONObject monitorHealth(JSONObject widget) {
    JSONObject monitoring = state.optJSONObject("monitoring"),
        widgets = monitoring == null ? null : monitoring.optJSONObject("widgets"),
        entry = widgets == null ? null : widgets.optJSONObject(widget.optString("id")),
        projects = entry == null ? null : entry.optJSONObject("projects");
    return projects == null
        ? null
        : projects.optJSONObject(
            widget.optString("type").equals("system")
                ? "mac"
                : grafanaProject(widget).optString("value"));
  }

  private String monitorLevel(JSONObject widget, String key) {
    JSONObject health = monitorHealth(widget),
        metrics = health == null ? null : health.optJSONObject("metrics"),
        metric = metrics == null ? null : metrics.optJSONObject(key);
    return metric == null ? "unknown" : metric.optString("level", "unknown");
  }

  private int monitorColor(String level) {
    return color(
        level.equals("critical")
            ? "#ff7d8b"
            : level.equals("warning") ? "#efbd73" : level.equals("normal") ? "#e2e8f0" : "#8291a3");
  }

  private int monitorColor(JSONObject widget, String key) {
    return monitorColor(monitorLevel(widget, key));
  }

  private int monitorValueColor(JSONObject widget, String key, double value) {
    if (!Double.isFinite(value)) return monitorColor("unknown");
    JSONObject health = monitorHealth(widget),
        metrics = health == null ? null : health.optJSONObject("metrics"),
        rule = metrics == null ? null : metrics.optJSONObject(key);
    if (rule == null || !rule.optBoolean("enabled")) return monitorColor("normal");
    boolean below = rule.optString("direction").equals("below");
    return monitorColor(
        (below ? value <= rule.optDouble("critical") : value >= rule.optDouble("critical"))
            ? "critical"
            : (below ? value <= rule.optDouble("warning") : value >= rule.optDouble("warning"))
                ? "warning"
                : "normal");
  }

  private String grafanaNodeDescription(JSONObject data) {
    JSONObject database = data == null ? null : data.optJSONObject("database");
    JSONArray nodes = database == null ? null : database.optJSONArray("nodes");
    StringBuilder description = new StringBuilder();
    if (nodes != null)
      for (int i = 0; i < Math.min(nodes.length(), 5); i++) {
        JSONObject node = nodes.optJSONObject(i);
        if (node == null) continue;
        description
            .append(", ")
            .append(node.optString("name"))
            .append(" CPU ")
            .append(metricPercent(metric(node, "cpuPercent")))
            .append(" MEM ")
            .append(metricPercent(metric(node, "memoryPercent")))
            .append(" · ")
            .append(metricGiB(metric(node, "memoryUsedBytes")));
      }
    return description.toString();
  }

  private String grafanaNumber(JSONObject data, String key, boolean percent) {
    double value = metric(data == null ? null : data.optJSONObject(key), "value");
    if (!queryFresh(data)
        || sourceState(data, key) == DataFreshness.STALE
        || sourceState(data, key) == DataFreshness.MISSING) value = Double.NaN;
    return percent
        ? metricPercent(value)
        : Double.isFinite(value) ? String.format(L10n.locale(), "%,.2f", value) : "—";
  }

  private TextView grafanaStat(LinearLayout row, String label, String hint) {
    LinearLayout tile = new LinearLayout(this);
    tile.setOrientation(LinearLayout.VERTICAL);
    tile.setPadding((int) dp(12), (int) dp(8), (int) dp(12), (int) dp(8));
    android.graphics.drawable.GradientDrawable bg =
        new android.graphics.drawable.GradientDrawable();
    bg.setColor(Color.parseColor("#172631"));
    bg.setCornerRadius(dp(10));
    tile.setBackground(bg);
    LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, (int) dp(94), 1f);
    params.setMargins((int) dp(3), (int) dp(3), (int) dp(3), (int) dp(3));
    row.addView(tile, params);
    TextView heading = new TextView(this);
    heading.setText(label);
    heading.setTextSize(12);
    heading.setIncludeFontPadding(false);
    tile.addView(heading, new LinearLayout.LayoutParams(-1, (int) dp(18)));
    TextView value = new TextView(this);
    value.setTextSize(30);
    value.setTypeface(font, android.graphics.Typeface.BOLD);
    value.setSingleLine(true);
    value.setIncludeFontPadding(false);
    value.setGravity(android.view.Gravity.CENTER_VERTICAL);
    value.setAutoSizeTextTypeUniformWithConfiguration(
        18, 30, 1, android.util.TypedValue.COMPLEX_UNIT_SP);
    tile.addView(value, new LinearLayout.LayoutParams(-1, (int) dp(42)));
    TextView subtitle = new TextView(this);
    subtitle.setText(hint);
    subtitle.setTextSize(10);
    subtitle.setIncludeFontPadding(false);
    subtitle.setSingleLine(true);
    tile.addView(subtitle, new LinearLayout.LayoutParams(-1, (int) dp(18)));
    value.setTag(subtitle);
    return value;
  }

  private void grafanaDetails(JSONObject widget) {
    boolean system = widget.optString("metric").equals("system");
    LinearLayout layout = new LinearLayout(this);
    layout.setOrientation(LinearLayout.VERTICAL);
    layout.setPadding((int) dp(13), 0, (int) dp(13), 0);
    LinearLayout firstRow = new LinearLayout(this);
    layout.addView(firstRow);
    TextView[] values = new TextView[system ? 3 : 6];
    values[0] =
        grafanaStat(
            firstRow,
            system ? L10n.text("시스템 CPU") : "DB CPU",
            system ? L10n.text("서비스 보고값 중 최대") : L10n.text("노드 최대 · 할당 한도 대비"));
    values[1] =
        grafanaStat(
            firstRow,
            system ? L10n.text("수집 정상") : "TPS",
            system ? L10n.text("정상 대상 / 전체 대상") : L10n.text("커밋/초 · 5분 평균"));
    values[2] =
        grafanaStat(
            firstRow,
            system ? L10n.text("보고 서비스") : "QPS",
            system ? L10n.text("CPU 보고 job 수") : L10n.text("쿼리/초 · 전체 노드 합계"));
    if (!system) {
      LinearLayout secondRow = new LinearLayout(this);
      layout.addView(secondRow);
      values[3] = grafanaStat(secondRow, L10n.text("연결 수"), L10n.text("전체 노드의 현재 연결 합계"));
      values[4] = grafanaStat(secondRow, L10n.text("DB 메모리"), L10n.text("노드 최대 · 할당 한도 대비"));
      values[5] = grafanaStat(secondRow, L10n.text("DB 상태"), L10n.text("준비 상태 · 수집 대상 확인"));
    }
    LinearLayout lower = new LinearLayout(this);
    LinearLayout.LayoutParams lowerParams =
        new LinearLayout.LayoutParams(-1, (int) dp(system ? 280 : 230));
    lowerParams.setMargins((int) dp(3), (int) dp(9), (int) dp(3), 0);
    layout.addView(lower, lowerParams);
    ScrollView nodesScroll = new ScrollView(this);
    LinearLayout nodes = new LinearLayout(this);
    nodes.setOrientation(LinearLayout.VERTICAL);
    nodes.setPadding((int) dp(10), (int) dp(8), (int) dp(10), (int) dp(8));
    nodesScroll.addView(nodes);
    lower.addView(nodesScroll, new LinearLayout.LayoutParams(0, -1, .85f));
    LinearLayout charts = new LinearLayout(this);
    charts.setOrientation(LinearLayout.VERTICAL);
    LinearLayout.LayoutParams chartsParams = new LinearLayout.LayoutParams(0, -1, 1.4f);
    chartsParams.setMargins((int) dp(9), 0, 0, 0);
    lower.addView(charts, chartsParams);
    GrafanaHistoryView graph = new GrafanaHistoryView(widget);
    if (!system) {
      LinearLayout chartTabs = new LinearLayout(this);
      String[] keys = {"tps", "qps", "cpu", "memory"};
      String[] labels = {"TPS", "QPS", "CPU", L10n.text("메모리")};
      Button[] buttons = new Button[keys.length];
      for (int i = 0; i < keys.length; i++) {
        final int index = i;
        Button button = new Button(this);
        buttons[i] = button;
        button.setText(labels[i]);
        button.setTextSize(11);
        button.setAllCaps(false);
        button.setMinWidth(0);
        button.setMinimumWidth(0);
        button.setPadding(0, 0, 0, 0);
        android.graphics.drawable.GradientDrawable tabBackground =
            new android.graphics.drawable.GradientDrawable();
        tabBackground.setColor(Color.parseColor("#36505e"));
        tabBackground.setCornerRadius(dp(8));
        button.setBackground(tabBackground);
        button.setContentDescription("Grafana " + labels[i] + L10n.text(" 그래프"));
        LinearLayout.LayoutParams tabParams = new LinearLayout.LayoutParams(0, (int) dp(32), 1f);
        tabParams.setMargins((int) dp(2), 0, (int) dp(2), (int) dp(5));
        chartTabs.addView(button, tabParams);
        button.setOnClickListener(
            v -> {
              graph.chartMetric = keys[index];
              graph.invalidate();
              for (int j = 0; j < buttons.length; j++)
                if (buttons[j] != null) buttons[j].setAlpha(j == index ? 1f : .5f);
            });
        button.setAlpha(keys[i].equals(graph.chartMetric) ? 1f : .5f);
      }
      charts.addView(chartTabs);
    }
    charts.addView(graph, new LinearLayout.LayoutParams(-1, 0, 1f));
    TextView updated = new TextView(this);
    updated.setTextSize(10);
    updated.setPadding((int) dp(5), (int) dp(8), 0, 0);
    layout.addView(updated);
    String[] last = {""};
    Runnable render =
        () -> {
          JSONObject data = grafanaData(widget);
          String signature = String.valueOf(data) + ":" + hostNow() / 5000 + ":" + streamFresh();
          if (signature.equals(last[0])) return;
          last[0] = signature;
          nodes.removeAllViews();
          boolean ready = queryFresh(data);
          for (TextView value : values) value.setText("—");
          if (!ready) {
            updated.setText(
                data == null
                    ? L10n.text("맥에서 Grafana 연결을 확인해 주세요.")
                    : data.optString("message", L10n.text("지표를 조회하고 있어요.")));
            graph.invalidate();
            return;
          }
          JSONObject cpu = data.optJSONObject(system ? "system" : "cpu"),
              collection = data.optJSONObject("collection"),
              database = data.optJSONObject("database");
          values[0].setText(grafanaNumber(data, system ? "system" : "cpu", true));
          values[0].setTextColor(monitorColor(widget, "cpu"));
          if (system) {
            values[1].setText(
                collection == null || collection.optInt("total") == 0
                    ? "—"
                    : collection.optInt("healthy") + " / " + collection.optInt("total"));
            JSONArray services = cpu == null ? null : cpu.optJSONArray("nodes");
            values[2].setText(
                services == null || services.length() == 0
                    ? "—"
                    : services.length() + L10n.text("개"));
          } else {
            values[1].setText(grafanaNumber(data, "tps", false));
            values[2].setText(grafanaNumber(data, "qps", false));
            values[1].setTextColor(monitorColor(widget, "tps"));
            values[2].setTextColor(monitorColor(widget, "qps"));
            values[3].setTextColor(monitorColor(widget, "connections"));
            values[4].setTextColor(monitorColor(widget, "memory"));
            values[5].setTextColor(monitorColor(widget, "ready"));
            double connections = metric(database, "connections");
            values[3].setText(
                Double.isFinite(connections)
                    ? String.format(L10n.locale(), "%,.0f", connections)
                    : "—");
            values[4].setText(grafanaNumber(data, "memory", true));
            ((TextView) values[4].getTag())
                .setText(
                    metricGiB(metric(data.optJSONObject("memory"), "usedBytes"))
                        + L10n.text(" 사용 · 노드 최대"));
            values[5].setText(
                database == null || database.isNull("ready")
                    ? L10n.text("확인 불가")
                    : database.optBoolean("ready") ? L10n.text("정상") : L10n.text("확인 필요"));
          }
          TextView nodeTitle = new TextView(this);
          nodeTitle.setText(system ? L10n.text("서비스별 시스템 CPU") : L10n.text("노드별 DB CPU · MEM"));
          nodeTitle.setTextSize(12);
          nodeTitle.setIncludeFontPadding(false);
          nodes.addView(nodeTitle);
          JSONArray rows =
              system
                  ? (cpu == null ? null : cpu.optJSONArray("nodes"))
                  : (database == null ? null : database.optJSONArray("nodes"));
          if (rows != null)
            for (int i = 0; i < rows.length(); i++) {
              JSONObject row = rows.optJSONObject(i);
              if (row == null) continue;
              TextView name = new TextView(this);
              name.setText(row.optString("name"));
              name.setTextSize(11);
              name.setIncludeFontPadding(false);
              name.setPadding(0, (int) dp(9), 0, 0);
              nodes.addView(name);
              TextView value = new TextView(this);
              value.setText(
                  metricPercent(
                      visibleGrafanaValue(
                          widget, "cpu", metric(row, system ? "value" : "cpuPercent"))));
              value.setTextSize(22);
              value.setIncludeFontPadding(false);
              value.setTypeface(font, android.graphics.Typeface.BOLD);
              nodes.addView(value);
              styleOSText(name);
              styleOSText(value);
              value.setTextColor(
                  grafanaReadingColor(widget, "cpu", metric(row, system ? "value" : "cpuPercent")));
              if (!system) {
                TextView memory = new TextView(this);
                memory.setText(
                    "MEM "
                        + metricPercent(
                            visibleGrafanaValue(widget, "memory", metric(row, "memoryPercent")))
                        + " · "
                        + metricGiB(
                            visibleGrafanaValue(widget, "memory", metric(row, "memoryUsedBytes")))
                        + L10n.text(" 사용"));
                memory.setTextSize(14);
                memory.setIncludeFontPadding(false);
                nodes.addView(memory);
                styleOSText(memory);
                memory.setTextColor(
                    grafanaReadingColor(widget, "memory", metric(row, "memoryPercent")));
              }
            }
          styleOSText(nodeTitle);
          updated.setText(
              sourceStamp(data, system ? "system" : "cpu")
                  + " · "
                  + (freshnessNotice(widget, data) == null
                      ? L10n.text("정상 수집")
                      : freshnessNotice(widget, data))
                  + L10n.text("\n조회 ")
                  + osDate(data.optLong("capturedAt"), "HH:mm:ss")
                  + L10n.text(" · 30초 갱신 · 최근 1시간 추이")
                  + (system
                      ? L10n.text(" · 수집 성공 기준")
                      : L10n.text(" · TPS는 Galera 로컬 커밋, QPS는 Questions 기준")));
          graph.invalidate();
        };
    AlertDialog dialog =
        osDialog()
            .setTitle(
                grafanaProject(widget).optString("label", L10n.text("프로젝트"))
                    + " · "
                    + widget.optString("label", system ? L10n.text("시스템 상태") : L10n.text("DB 상태")))
            .setView(layout)
            .setPositiveButton(L10n.text("프로젝트 변경"), (d, x) -> grafanaChoose(widget))
            .setNegativeButton(L10n.text("닫기"), null)
            .show();
    Runnable refresh =
        new Runnable() {
          public void run() {
            if (!dialog.isShowing()) return;
            render.run();
            ui.postDelayed(this, 2000);
          }
        };
    dialog.setOnDismissListener(d -> ui.removeCallbacks(refresh));
    render.run();
    ui.postDelayed(refresh, 2000);
  }

  private void osAction(JSONObject widget, String operation, String itemId) {
    try {
      JSONObject body =
          new JSONObject()
              .put("kind", "extension")
              .put("id", widget.getString("id"))
              .put("operation", operation);
      if (itemId != null) body.put("itemId", itemId);
      action(body);
    } catch (JSONException ignored) {
    }
  }

  private void styleOSText(View view) {
    if (view instanceof TextView) {
      TextView text = (TextView) view;
      text.setTypeface(
          font,
          text.getTypeface() == null
              ? android.graphics.Typeface.NORMAL
              : text.getTypeface().getStyle());
      text.setTextColor(Color.parseColor(view instanceof Button ? "#8fcfc1" : "#e0e9fa"));
      text.setLetterSpacing(0);
    }
    if (view instanceof ViewGroup) {
      ViewGroup group = (ViewGroup) view;
      for (int i = 0; i < group.getChildCount(); i++) styleOSText(group.getChildAt(i));
    }
  }

  private AlertDialog.Builder osDialog() {
    return new AlertDialog.Builder(L10n.context(this)) {
      @Override
      public AlertDialog show() {
        AlertDialog dialog = super.show();
        android.graphics.drawable.GradientDrawable background =
            new android.graphics.drawable.GradientDrawable();
        background.setColor(Color.parseColor("#1f2b36"));
        background.setCornerRadius(dp(16));
        if (dialog.getWindow() != null) {
          dialog.getWindow().setBackgroundDrawable(background);
          dialog.getWindow().setDimAmount(.55f);
          styleOSText(dialog.getWindow().getDecorView());
        }
        ListView list = dialog.getListView();
        if (list != null)
          list.setOnHierarchyChangeListener(
              new ViewGroup.OnHierarchyChangeListener() {
                public void onChildViewAdded(View parent, View child) {
                  styleOSText(child);
                }

                public void onChildViewRemoved(View parent, View child) {}
              });
        return dialog;
      }
    };
  }

  private JSONArray osNotificationFeed() {
    JSONArray source = state.optJSONArray("notifications"), result = new JSONArray();
    if (source != null)
      for (int i = 0; i < source.length(); i++) {
        JSONObject row = source.optJSONObject(i);
        if (row != null && !row.optString("kind").equals("monitor")) result.put(row);
      }
    return result;
  }

  private void osList(JSONObject widget, String day) {
    String type = widget.optString("type");
    if (type.equals("inbox")) {
      osAction(widget, "navigate", null);
      return;
    }
    if (type.equals("notification-feed")) {
      JSONArray feed = osNotificationFeed();
      StringBuilder text = new StringBuilder();
      if (feed != null)
        for (int i = feed.length() - 1; i >= 0; i--) {
          JSONObject n = feed.optJSONObject(i);
          text.append(osDate(n.optLong("createdAt"), "M/d HH:mm"))
              .append("  ")
              .append(n.optString("title"))
              .append("\n")
              .append(n.optString("body"))
              .append("\n\n");
        }
      osDialog()
          .setTitle(L10n.text("Jimin OS 알림"))
          .setMessage(text.length() == 0 ? L10n.text("새 알림이 없어요.") : text.toString())
          .setPositiveButton(L10n.text("닫기"), null)
          .show();
      return;
    }
    if (osData() == null) {
      osDialog()
          .setTitle(L10n.text("Jimin OS 연결 대기"))
          .setMessage(L10n.text("맥에서 Jimin OS 앱을 열고 로그인 상태를 확인해 주세요."))
          .setPositiveButton(L10n.text("확인"), null)
          .show();
      return;
    }
    List<JSONObject> items = new ArrayList<>();
    List<String> labels = new ArrayList<>();
    boolean tasksOnly = widget.optString("osView").equals("tasks");
    JSONArray events = tasksOnly ? new JSONArray() : osRows("events");
    for (int i = 0; i < events.length(); i++) {
      JSONObject event = events.optJSONObject(i);
      long start = instant(event.optString("startsAt")), end = instant(event.optString("endsAt"));
      if (day != null
          ? (day.compareTo(osDate(start, "yyyy-MM-dd")) < 0
              || day.compareTo(osDate(Math.max(start, end - 1), "yyyy-MM-dd")) > 0)
          : end < hostNow()) continue;
      items.add(event);
      labels.add(
          osDate(start, day == null ? "M/d HH:mm" : "HH:mm")
              + " – "
              + osDate(end, "HH:mm")
              + "  "
              + event.optString("title"));
    }
    JSONArray tasks = osRows("tasks");
    for (int i = 0; i < tasks.length(); i++) {
      JSONObject task = tasks.optJSONObject(i);
      long due = instant(task.optString("dueAt"));
      if ((!tasksOnly && due == 0) || (day != null && !day.equals(osDate(due, "yyyy-MM-dd"))))
        continue;
      items.add(task);
      labels.add(
          L10n.text("할 일 · ")
              + (due == 0 ? L10n.text("마감 없음") : osDate(due, "M/d HH:mm"))
              + "  "
              + task.optString("title"));
    }
    AlertDialog.Builder dialog =
        osDialog()
            .setTitle(
                (tasksOnly
                        ? L10n.text("할 일")
                        : day == null ? L10n.text("다가오는 일정") : day + L10n.text(" 일정"))
                    + (osFresh() ? "" : L10n.text(" · 이전 데이터")))
            .setNegativeButton(L10n.text("닫기"), null);
    if (!tasksOnly && osCan("scheduleCreate"))
      dialog.setPositiveButton(L10n.text("일정 추가"), (a, b) -> osCreateSchedule(widget, day));
    if (items.isEmpty()) dialog.setMessage(L10n.text("등록된 일정이 없어요."));
    else
      dialog.setItems(
          labels.toArray(new String[0]),
          (d, index) -> {
            JSONObject e = items.get(index);
            AlertDialog.Builder detail =
                osDialog()
                    .setTitle(e.optString("title"))
                    .setMessage(
                        osSyncNotice()
                            + "\n\n"
                            + (e.has("startsAt")
                                ? osDate(instant(e.optString("startsAt")), "M월 d일 EEEE HH:mm")
                                    + " – "
                                    + osDate(instant(e.optString("endsAt")), "M/d HH:mm")
                                : L10n.text("마감 · ")
                                    + (instant(e.optString("dueAt")) == 0
                                        ? L10n.text("없음")
                                        : osDate(
                                            instant(e.optString("dueAt")), "M월 d일 EEEE HH:mm"))))
                    .setNeutralButton(
                        L10n.text("맥에서 열기"),
                        (a, b) ->
                            osAction(
                                widget,
                                e.has("startsAt") ? "open-schedule" : "open-task",
                                e.optString("id")))
                    .setNegativeButton(L10n.text("닫기"), null);
            if (!e.has("startsAt") && osCan("taskComplete") && e.optInt("version") > 0)
              detail.setPositiveButton(L10n.text("완료하기"), (a, b) -> osCompleteTask(widget, e));
            detail.show();
          });
    dialog.show();
  }

  private boolean osCan(String capability) {
    JSONObject data = osData();
    JSONObject caps = data == null ? null : data.optJSONObject("capabilities");
    return osFresh() && caps != null && caps.optBoolean(capability);
  }

  private boolean osNativeButton(JSONObject widget) {
    if (!widget.optString("provider").equals("jimin-os")) return false;
    String view = widget.optString("osView");
    if (view.equals("new-schedule")) {
      osCreateSchedule(widget, null);
      return true;
    }
    if (view.equals("tasks")) {
      osList(widget, null);
      return true;
    }
    return false;
  }

  private LinearLayout osForm() {
    LinearLayout form = new LinearLayout(this);
    form.setOrientation(LinearLayout.VERTICAL);
    form.setPadding((int) dp(24), (int) dp(8), (int) dp(24), (int) dp(8));
    return form;
  }

  private TextView osText(LinearLayout form, String label) {
    TextView text = new TextView(this);
    text.setText(label);
    text.setTextSize(15);
    text.setPadding(0, (int) dp(8), 0, (int) dp(8));
    form.addView(text);
    return text;
  }

  private EditText osField(LinearLayout form, String hint, int limit, boolean multiline) {
    EditText field = new EditText(this);
    field.setHint(hint);
    field.setHintTextColor(Color.parseColor("#9aaabb"));
    field.setTextSize(17);
    field.setSingleLine(!multiline);
    field.setInputType(
        InputType.TYPE_CLASS_TEXT
            | (multiline
                ? InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
                : InputType.TYPE_TEXT_FLAG_CAP_SENTENCES));
    field.setFilters(
        new android.text.InputFilter[] {new android.text.InputFilter.LengthFilter(limit)});
    form.addView(field);
    return field;
  }

  private ScrollView osScroll(LinearLayout form) {
    ScrollView scroll = new ScrollView(this);
    scroll.setFillViewport(true);
    scroll.addView(form);
    return scroll;
  }

  private void osPickTime(Calendar date, Button button) {
    new DatePickerDialog(
            L10n.context(this),
            (picker, year, month, day) -> {
              new TimePickerDialog(
                      L10n.context(this),
                      (clock, hour, minute) -> {
                        date.set(year, month, day, hour, minute, 0);
                        date.set(Calendar.MILLISECOND, 0);
                        button.setText(osDate(date.getTimeInMillis(), "M월 d일 EEEE HH:mm"));
                      },
                      date.get(Calendar.HOUR_OF_DAY),
                      date.get(Calendar.MINUTE),
                      true)
                  .show();
            },
            date.get(Calendar.YEAR),
            date.get(Calendar.MONTH),
            date.get(Calendar.DAY_OF_MONTH))
        .show();
  }

  private boolean osResumePending() {
    String saved = prefs.getString("pendingOSMutation", "");
    if (saved.isEmpty()) return false;
    try {
      JSONObject input = new JSONObject(saved);
      LinearLayout form = osForm();
      osText(
          form,
          input.optString("operation").equals("create-schedule")
              ? input.optString("title")
              : L10n.text("할 일 완료 요청"));
      TextView status =
          osText(form, L10n.text("이전 요청의 처리 결과를 확인해 주세요. 다시 시도해도 같은 요청으로 확인해 중복 저장을 막아요."));
      AlertDialog dialog =
          osDialog()
              .setTitle(L10n.text("처리 결과 확인"))
              .setView(osScroll(form))
              .setPositiveButton(L10n.text("상태 확인"), null)
              .setNeutralButton(L10n.text("같은 요청 재시도"), null)
              .setNegativeButton(L10n.text("닫기"), null)
              .show();
      OSWrite write = new OSWrite(dialog, status, input);
      dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> write.check());
      dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener(v -> write.send(true));
      write.check();
      return true;
    } catch (JSONException ignored) {
      prefs.edit().remove("pendingOSMutation").apply();
      return false;
    }
  }

  private void osCreateSchedule(JSONObject widget, String day) {
    if (osResumePending()) return;
    if (!osCan("scheduleCreate")) {
      osDialog()
          .setTitle(L10n.text("일정 추가 연결 대기"))
          .setMessage(
              osData() != null
                  ? L10n.text("이전 데이터를 보여주고 있어요. 자동으로 다시 연결한 뒤 일정을 추가할 수 있어요.\n\n") + osSyncNotice()
                  : L10n.text("Jimin OS에 다시 연결하고 있어요. 맥에서 앱과 로그인을 확인해 주세요."))
          .setPositiveButton(L10n.text("확인"), null)
          .show();
      return;
    }
    Calendar start = Calendar.getInstance(TimeZone.getTimeZone("Asia/Seoul"));
    start.add(Calendar.HOUR_OF_DAY, 1);
    start.set(Calendar.MINUTE, 0);
    start.set(Calendar.SECOND, 0);
    start.set(Calendar.MILLISECOND, 0);
    if (day != null) {
      String[] parts = day.split("-");
      if (parts.length == 3)
        start.set(
            Integer.parseInt(parts[0]), Integer.parseInt(parts[1]) - 1, Integer.parseInt(parts[2]));
    }
    Calendar end = (Calendar) start.clone();
    end.add(Calendar.HOUR_OF_DAY, 1);
    LinearLayout form = osForm();
    osText(form, L10n.text("Jimin OS 캘린더에 저장해요. 시간은 한국 표준시예요."));
    EditText title = osField(form, L10n.text("일정 제목"), 160, false);
    osText(form, L10n.text("시작"));
    Button from = new Button(this);
    from.setText(osDate(start.getTimeInMillis(), "M월 d일 EEEE HH:mm"));
    form.addView(from);
    from.setOnClickListener(v -> osPickTime(start, from));
    osText(form, L10n.text("종료"));
    Button to = new Button(this);
    to.setText(osDate(end.getTimeInMillis(), "M월 d일 EEEE HH:mm"));
    form.addView(to);
    to.setOnClickListener(v -> osPickTime(end, to));
    EditText notes = osField(form, L10n.text("메모 (선택)"), 2000, true);
    TextView status = osText(form, "");
    AlertDialog dialog =
        osDialog()
            .setTitle(L10n.text("일정 추가"))
            .setView(osScroll(form))
            .setPositiveButton(L10n.text("저장"), null)
            .setNeutralButton(L10n.text("같은 요청 재시도"), null)
            .setNegativeButton(L10n.text("닫기"), null)
            .show();
    dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setVisibility(View.GONE);
    dialog
        .getButton(AlertDialog.BUTTON_POSITIVE)
        .setOnClickListener(
            v -> {
              if (title.getText().toString().trim().isEmpty()) {
                title.setError(L10n.text("제목을 입력해 주세요."));
                return;
              }
              if (end.getTimeInMillis() <= start.getTimeInMillis()) {
                status.setText(L10n.text("종료 시간을 시작 시간 뒤로 설정해 주세요."));
                return;
              }
              try {
                JSONObject input =
                    new JSONObject()
                        .put("widgetId", widget.getString("id"))
                        .put("mutationId", osMutationId())
                        .put("operation", "create-schedule")
                        .put("title", title.getText().toString().trim())
                        .put("notes", notes.getText().toString().trim())
                        .put(
                            "startsAt",
                            java.time.Instant.ofEpochMilli(start.getTimeInMillis()).toString())
                        .put(
                            "endsAt",
                            java.time.Instant.ofEpochMilli(end.getTimeInMillis()).toString());
                title.setEnabled(false);
                notes.setEnabled(false);
                from.setEnabled(false);
                to.setEnabled(false);
                new OSWrite(dialog, status, input).send(false);
              } catch (JSONException ignored) {
              }
            });
  }

  private void osCompleteTask(JSONObject widget, JSONObject task) {
    if (osResumePending()) return;
    if (!osCan("taskComplete") || task.optInt("version") < 1) return;
    LinearLayout form = osForm();
    osText(form, task.optString("title"));
    osText(
        form,
        L10n.text(
            "완료하면 Jimin OS와 연결된 업무에도 반영돼요. 답글을 쓰면 일감에 저장하고, Google Chat에서 받은 일감은 원래 대화에도 전달해요."));
    EditText note = osField(form, L10n.text("완료 답글 (선택)"), 2000, true);
    TextView status = osText(form, "");
    AlertDialog dialog =
        osDialog()
            .setTitle(L10n.text("할 일 완료"))
            .setView(osScroll(form))
            .setPositiveButton(L10n.text("완료하기"), null)
            .setNeutralButton(L10n.text("같은 요청 재시도"), null)
            .setNegativeButton(L10n.text("닫기"), null)
            .show();
    dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setVisibility(View.GONE);
    dialog
        .getButton(AlertDialog.BUTTON_POSITIVE)
        .setOnClickListener(
            v -> {
              try {
                JSONObject input =
                    new JSONObject()
                        .put("widgetId", widget.getString("id"))
                        .put("mutationId", osMutationId())
                        .put("operation", "complete-task")
                        .put("itemId", task.getString("id"))
                        .put("expectedVersion", task.getInt("version"))
                        .put("completionNote", note.getText().toString().trim());
                note.setEnabled(false);
                new OSWrite(dialog, status, input).send(false);
              } catch (JSONException ignored) {
              }
            });
  }

  private String osMutationId() {
    long timestamp = System.currentTimeMillis();
    UUID random = UUID.randomUUID();
    return new UUID(
            (timestamp << 16) | 0x7000L | (random.getMostSignificantBits() & 0xfffL),
            random.getLeastSignificantBits())
        .toString();
  }

  private class OSWrite {
    final AlertDialog dialog;
    final TextView status;
    final JSONObject input;
    boolean busy;
    int polls;

    OSWrite(AlertDialog dialog, TextView status, JSONObject input) {
      this.dialog = dialog;
      this.status = status;
      this.input = input;
    }

    void controls(boolean enabled, String label, boolean retry) {
      Button main = dialog.getButton(AlertDialog.BUTTON_POSITIVE);
      main.setText(label);
      main.setEnabled(enabled);
      main.setOnClickListener(v -> check());
      Button again = dialog.getButton(AlertDialog.BUTTON_NEUTRAL);
      if (again != null) {
        again.setVisibility(retry ? View.VISIBLE : View.GONE);
        again.setEnabled(enabled);
        again.setOnClickListener(v -> send(true));
      }
    }

    void send(boolean retry) {
      if (busy) return;
      try {
        input.put("retry", retry);
      } catch (JSONException ignored) {
      }
      prefs.edit().putString("pendingOSMutation", input.toString()).commit();
      run(true);
    }

    void check() {
      if (!busy) run(false);
    }

    void run(boolean post) {
      if (busy || stopped) return;
      busy = true;
      controls(false, L10n.text("처리 확인 중…"), false);
      status.setText(post ? L10n.text("Jimin OS에 저장하고 있어요…") : L10n.text("저장 결과를 확인하고 있어요…"));
      try {
        commands.execute(
            () -> {
              try {
                JSONObject receipt =
                    request(
                        "/api/extensions/jimin-os/mutations"
                            + (post ? "" : "/" + input.optString("mutationId")),
                        post ? "POST" : "GET",
                        post ? input : null,
                        true);
                ui.post(
                    () -> {
                      busy = false;
                      result(receipt);
                    });
              } catch (Exception e) {
                ui.post(
                    () -> {
                      busy = false;
                      status.setText(L10n.text("결과를 아직 확인하지 못했어요. 상태를 확인하거나 같은 요청을 다시 시도해 주세요."));
                      controls(true, L10n.text("상태 확인"), true);
                    });
              }
            });
      } catch (RejectedExecutionException e) {
        busy = false;
        status.setText(L10n.text("다른 요청이 진행 중이에요. 잠시 후 상태를 확인해 주세요."));
        controls(true, L10n.text("상태 확인"), true);
      }
    }

    void result(JSONObject receipt) {
      String value = receipt.optString("status");
      if (value.equals("succeeded")) {
        prefs.edit().remove("pendingOSMutation").apply();
        dialog.dismiss();
        Toast.makeText(
                MainActivity.this,
                input.optString("operation").equals("create-schedule")
                    ? L10n.text("일정을 저장했어요.")
                    : receipt.optBoolean("alreadyCompleted")
                        ? L10n.text("이미 완료된 할 일이에요.")
                        : L10n.text("할 일을 완료했어요."),
                Toast.LENGTH_SHORT)
            .show();
      } else if (value.equals("failed")) {
        prefs.edit().remove("pendingOSMutation").apply();
        String code = receipt.optString("error");
        status.setText(
            code.equals("CONFLICT")
                ? L10n.text("다른 곳에서 변경된 할 일이에요. 닫고 최신 목록에서 다시 확인해 주세요.")
                : code.equals("AUTH_REQUIRED")
                    ? L10n.text("맥의 Jimin OS에서 로그인을 확인해 주세요.")
                    : L10n.text("저장하지 못했어요. 닫고 내용을 확인한 뒤 다시 시도해 주세요."));
        controls(true, L10n.text("닫기"), false);
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> dialog.dismiss());
      } else if (value.equals("running")) {
        status.setText(L10n.text("Jimin OS에서 처리 중이에요. 이 창을 닫아도 다음 요청 때 결과를 확인할 수 있어요."));
        controls(true, L10n.text("상태 확인"), false);
        if (++polls < 30 && dialog.isShowing())
          ui.postDelayed(
              () -> {
                if (dialog.isShowing()) check();
              },
              1000);
      } else {
        status.setText(L10n.text("저장 여부를 확인해야 해요. 같은 요청을 다시 시도하면 중복 여부를 먼저 확인해요."));
        controls(true, L10n.text("상태 확인"), true);
      }
    }
  }

  private void disconnectEvents() {
    HttpURLConnection previous = eventConnection;
    if (previous != null) new Thread(previous::disconnect, "open-deck-disconnect").start();
  }

  @Override
  public void onWindowFocusChanged(boolean focus) {
    super.onWindowFocusChanged(focus);
    if (focus) immersive();
  }

  @Override
  public void onDestroy() {
    pairingGeneration++;
    stopped = true;
    connected = false;
    disconnectEvents();
    if (events != null) events.interrupt();
    commands.shutdownNow();
    stopHostDiscovery();
    images.shutdownNow();
    settingRequests.shutdownNow();
    ui.removeCallbacks(cornerSettings);
    ui.removeCallbacks(tick);
    super.onDestroy();
  }

  @Override
  public void onConfigurationChanged(android.content.res.Configuration c) {
    super.onConfigurationChanged(c);
    if (deck != null) deck.requestLayout();
  }

  private void immersive() {
    if (!settingBool("fullscreen")) {
      getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
      return;
    }
    getWindow()
        .getDecorView()
        .setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    getWindow().setNavigationBarColor(Color.rgb(11, 17, 27));
    getWindow().setStatusBarColor(Color.rgb(11, 17, 27));
  }

  private float dp(float v) {
    return v * getResources().getDisplayMetrics().density;
  }

  private int color(String s) {
    try {
      Integer cached = colors.get(s);
      if (cached != null) return cached;
      int parsed = Color.parseColor(s);
      colors.put(s, parsed);
      return parsed;
    } catch (Exception e) {
      return Color.rgb(136, 182, 255);
    }
  }

  private TextView text(String value, int size, int color) {
    TextView v = new TextView(this);
    v.setText(value);
    v.setTextSize(size);
    v.setTextColor(color);
    v.setTypeface(font);
    return v;
  }

  private void pairScreen() {
    deck = null;
    base = ("http://127.0.0.1:" + BuildConfig.USB_PORT);
    LinearLayout wrap = new LinearLayout(this);
    wrap.setOrientation(LinearLayout.VERTICAL);
    wrap.setPadding((int) dp(40), (int) dp(35), (int) dp(40), (int) dp(30));
    wrap.setGravity(Gravity.CENTER);
    wrap.setBackgroundColor(color("#0b111b"));
    LinearLayout card = new LinearLayout(this);
    card.setOrientation(LinearLayout.VERTICAL);
    card.setPadding((int) dp(30), (int) dp(28), (int) dp(30), (int) dp(28));
    android.graphics.drawable.GradientDrawable bg =
        new android.graphics.drawable.GradientDrawable();
    bg.setColor(color("#152136"));
    bg.setCornerRadius(dp(18));
    card.setBackground(bg);
    TextView mark = text("◈  OPEN DECK", 15, color("#a5b5ff"));
    card.addView(mark);
    TextView title = text(L10n.text("내 책상과 연결하기"), 28, Color.WHITE);
    title.setPadding(0, (int) dp(25), 0, (int) dp(12));
    card.addView(title);
    TextView help =
        text(
            L10n.text(
                "최초 등록은 USB로 맥에 연결하고 Open Deck 앱을 실행하세요.\n"
                    + "6자리 코드로 등록하면 같은 Wi-Fi에서 무선으로 사용할 수 있습니다."),
            14,
            color("#9caec9"));
    help.setLineSpacing(dp(5), 1);
    card.addView(help);
    EditText code = new EditText(this);
    code.setHint(L10n.text("6자리 페어링 코드"));
    code.setTextColor(Color.WHITE);
    code.setHintTextColor(color("#7689a8"));
    code.setTextSize(24);
    code.setInputType(InputType.TYPE_CLASS_NUMBER);
    code.setFilters(new android.text.InputFilter[] {new android.text.InputFilter.LengthFilter(6)});
    LinearLayout.LayoutParams field = new LinearLayout.LayoutParams(-1, (int) dp(65));
    field.topMargin = (int) dp(20);
    card.addView(code, field);
    TextView error = text("", 13, color("#ffa5a5"));
    card.addView(error);
    Button connect = new Button(this);
    connect.setText(L10n.text("연결하기"));
    card.addView(connect, new LinearLayout.LayoutParams(-1, (int) dp(52)));
    connect.setOnClickListener(
        v -> {
          String pin = code.getText().toString().trim();
          if (!pin.matches("[0-9]{6}")) {
            error.setText(L10n.text("6자리 코드를 입력하세요."));
            return;
          }
          connect.setEnabled(false);
          error.setText(L10n.text("연결 중…"));
          commands.execute(
              () -> {
                try {
                  JSONObject request = new JSONObject().put("pin", pin).put("name", deviceName);
                  JSONObject r = request("/api/pair", "POST", request, false);
                  ui.post(this::resetDeviceIdentity);
                  token = r.getString("token");
                  saveToken(token);
                  prefs.edit().putString("host", base).apply();
                  ui.post(
                      () -> {
                        ((InputMethodManager) getSystemService(INPUT_METHOD_SERVICE))
                            .hideSoftInputFromWindow(code.getWindowToken(), 0);
                        showDeck();
                      });
                } catch (Exception e) {
                  ui.post(
                      () -> {
                        connect.setEnabled(true);
                        error.setText(
                            L10n.text("연결하지 못했습니다. USB와 맥 앱, 페어링 코드를 확인하세요.\n") + e.getMessage());
                      });
                }
              });
        });
    TextView note = text(L10n.text("계정 없이 · 구독 없이 · 내 기기에서만"), 12, color("#7185a7"));
    note.setPadding(0, (int) dp(22), 0, 0);
    card.addView(note);
    Button settingsEntry = new Button(this);
    settingsEntry.setText(L10n.text("앱 설정"));
    settingsEntry.setOnClickListener(v -> settings());
    card.addView(settingsEntry);
    wrap.addView(
        card,
        new LinearLayout.LayoutParams(
            (int) Math.min(dp(520), getResources().getDisplayMetrics().widthPixels - dp(80)), -2));
    setContentView(wrap);
  }

  private void showDeck() {
    deck = new DeckView();
    deck.rebuild();
    setContentView(deck);
    connected = false;
    if (events == null || !events.isAlive()) {
      stopped = false;
      events = new Thread(this::listen, "open-deck-events");
      events.start();
    }
  }

  private JSONObject request(String route, String method, JSONObject body, boolean auth)
      throws Exception {
    return requestWithToken(route, method, body, auth ? token : null);
  }

  private JSONObject requestWithToken(
      String route, String method, JSONObject body, String pairedToken) throws Exception {
    HttpURLConnection c =
        PinnedConnection.open(base + route, wifiPin, settingBool("allowInsecureWifi"));
    c.setConnectTimeout(2200);
    c.setReadTimeout(12000);
    c.setRequestMethod(method);
    if (pairedToken != null) c.setRequestProperty("Authorization", "Bearer " + pairedToken);
    if (body != null) {
      c.setDoOutput(true);
      c.setRequestProperty("Content-Type", "application/json");
      try (OutputStream o = c.getOutputStream()) {
        o.write(body.toString().getBytes(StandardCharsets.UTF_8));
      }
    }
    try {
      int status = c.getResponseCode();
      InputStream in = status < 400 ? c.getInputStream() : c.getErrorStream();
      String response = in == null ? "{}" : readBody(in);
      JSONObject data = new JSONObject(response);
      if (status >= 400)
        throw new IOException(L10n.error(data.optString("error", "HTTP " + status)));
      return data;
    } finally {
      c.disconnect();
    }
  }

  private String readBody(InputStream in) throws IOException {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    byte[] buffer = new byte[4096];
    int n;
    while ((n = in.read(buffer)) != -1) {
      if (out.size() + n > 524288) throw new IOException(L10n.text("응답이 너무 큽니다."));
      out.write(buffer, 0, n);
    }
    return out.toString("UTF-8");
  }

  private void listen() {
    int delay = 1000, endpoint = 0, revision = connectionRevision;
    while (!stopped && !token.isEmpty()) {
      if (revision != connectionRevision) {
        endpoint = 0;
        revision = connectionRevision;
        delay = 1000;
      }
      List<String> candidates = endpoints();
      base = candidates.get(endpoint % candidates.size());
      long connectionGeneration = pairingGeneration;
      String streamToken = token;
      boolean switchToWifi = false;
      HttpURLConnection c = null;
      try {
        c = PinnedConnection.open(base + "/api/events", wifiPin, settingBool("allowInsecureWifi"));
        eventConnection = c;
        c.setConnectTimeout(2500);
        c.setReadTimeout(6000);
        c.setRequestProperty("Authorization", "Bearer " + streamToken);
        int responseStatus = c.getResponseCode();
        if (connectionGeneration != pairingGeneration) continue;
        if (responseStatus == 401) {
          token = "";
          prefs.edit().remove("token").apply();
          ui.post(
              () -> {
                if (connectionGeneration != pairingGeneration) return;
                resetDeviceIdentity();
                pairScreen();
              });
          return;
        }
        if (responseStatus != 200) throw new IOException("Host unavailable");
        streamOpenedAt = SystemClock.elapsedRealtime();
        connected = true;
        connectionError = "";
        recordConnection("connected", base.startsWith("https:") ? "Wi-Fi" : "USB");
        delay = 1000;
        ui.post(
            () -> {
              if (deck != null) deck.invalidate();
            });
        try (BufferedReader reader =
            new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8))) {
          String line;
          while (!stopped && (line = reader.readLine()) != null) {
            if (connectionGeneration != pairingGeneration) break;
            if (line.startsWith("data: ")) {
              JSONObject snapshot = new JSONObject(line.substring(6));
              lastEventAt = SystemClock.elapsedRealtime();
              boolean learned = learnNetwork(snapshot.optJSONObject("network"));
              if ("auto".equals(transport)
                  && base.startsWith("http:")
                  && (learned || wifiAvailable())) {
                switchToWifi = true;
              }
              JSONObject cfg = snapshot.optJSONObject("config"),
                  st = snapshot.getJSONObject("state");
              String configJson = cfg == null ? null : cfg.toString();
              ui.post(
                  () -> {
                    if (connectionGeneration != pairingGeneration) return;
                    boolean changed = cfg != null && !renderedConfig.equals(configJson);
                    if (cfg != null) {
                      config = cfg;
                      cacheNavigationCatalog(cfg);
                    }
                    receiveDeviceSettings(snapshot.optJSONObject("device"));
                    if (cfg != null && firstConfig) {
                      firstConfig = false;
                      if (!getIntent().getBooleanExtra("openOS", false)
                          && !getIntent().hasExtra("openPage")) {
                        List<String> visible = new ArrayList<>();
                        JSONArray pages = cfg.optJSONArray("pages");
                        if (pages != null)
                          for (int i = 0; i < pages.length(); i++)
                            visible.add(pages.optJSONObject(i).optString("id"));
                        pageId =
                            ProfileNavigation.startupPage(
                                settingBool("rememberPage"),
                                prefs.getString("page", ""),
                                settingString("startPageId"),
                                profileDefaultPage(),
                                visible);
                        prefs.edit().putString("page", pageId).apply();
                      }
                    }
                    resolveRequestedNavigation();
                    state = st;
                    serverTime = st.optLong("at", System.currentTimeMillis());
                    receivedAt = SystemClock.elapsedRealtime();
                    runningIds.clear();
                    JSONArray running = st.optJSONArray("running");
                    if (running != null)
                      for (int i = 0; i < running.length(); i++)
                        runningIds.add(running.optString(i));
                    showErrors();
                    indexOSCalendar();
                    showOSNotifications();
                    if (deck != null && foreground) {
                      if (changed) {
                        renderedConfig = configJson;
                        deck.rebuild();
                      }
                      deck.updateState();
                    }
                  });
              if (switchToWifi) break;
            }
          }
        }
      } catch (Exception e) {
        connectionError =
            e.getMessage() == null ? L10n.text("연결할 수 없습니다.") : L10n.error(e.getMessage());
        recordConnection("retry", e.getClass().getSimpleName());
        if (!stopped) {
          connected = false;
          ui.post(
              () -> {
                if (deck != null) {
                  deck.updateState();
                  deck.invalidate();
                }
              });
        }
      } finally {
        if (c != null) c.disconnect();
        eventConnection = null;
        connected = false;
      }
      if (switchToWifi) {
        endpoint = 0;
        continue;
      }
      endpoint++;
      if (!stopped && revision == connectionRevision)
        try {
          Thread.sleep(delay);
        } catch (InterruptedException e) {
          return;
        }
      delay = Math.min(5000, delay * 2);
    }
  }

  // Probe on the event thread, never on the render or command threads. A working USB stream
  // stays active if Wi-Fi is unavailable; healthy Wi-Fi becomes preferred again after recovery.
  private boolean wifiAvailable() {
    long now = SystemClock.elapsedRealtime();
    if (wifiPin.isEmpty() || wifiUrls.isEmpty() || now - lastWifiProbe < 15000) return false;
    lastWifiProbe = now;
    for (int i = 0; i < Math.min(2, wifiUrls.size()); i++) {
      HttpURLConnection probe = null;
      try {
        probe =
            PinnedConnection.open(
                wifiUrls.get(i) + "/health", wifiPin, settingBool("allowInsecureWifi"));
        probe.setConnectTimeout(700);
        probe.setReadTimeout(700);
        if (probe.getResponseCode() == 200) return true;
      } catch (Exception ignored) {
      } finally {
        if (probe != null) probe.disconnect();
      }
    }
    return false;
  }

  private List<String> endpoints() {
    List<String> urls = new ArrayList<>();
    if (!"usb".equals(transport) && !wifiPin.isEmpty()) {
      for (String url : wifiUrls) if (validWifiUrl(url)) urls.add(url);
      urls.sort((a, b) -> Boolean.compare(!a.startsWith("https:"), !b.startsWith("https:")));
    }
    if (!"wifi".equals(transport) || urls.isEmpty())
      urls.add(("http://127.0.0.1:" + BuildConfig.USB_PORT));
    return urls;
  }

  private boolean learnNetwork(JSONObject network) {
    if (network == null) return false;
    String pin = network.optString("fingerprint");
    JSONArray urls = network.optJSONArray("urls");
    if (!pin.matches("[0-9a-f]{64}") || urls == null || urls.length() == 0) return false;
    // A changed identity may be learned only through the authenticated USB tunnel.
    if (!base.startsWith("http://127.0.0.1:") && !pin.equals(wifiPin)) return false;
    List<String> valid = new ArrayList<>();
    for (int i = 0; i < urls.length(); i++) {
      String value = urls.optString(i);
      if (validWifiUrl(value)) valid.add(value);
    }
    if (valid.isEmpty()) return false;
    boolean changed = !pin.equals(wifiPin) || !valid.equals(wifiUrls);
    wifiPin = pin;
    wifiUrls = valid;
    prefs
        .edit()
        .putString("wifiPin", wifiPin)
        .putString("wifiUrls", new JSONArray(valid).toString())
        .apply();
    return changed;
  }

  private boolean validWifiUrl(String value) {
    return ClientSettingsPolicy.validWifiUrl(value, settingBool("allowInsecureWifi"));
  }

  private void reconnect(String mode) {
    transport = mode;
    prefs.edit().putString("transport", mode).apply();
    connectionRevision++;
    connected = false;
    disconnectEvents();
    if (deck != null) deck.invalidate();
  }

  private void connectionSettings() {
    String mode =
        "wifi".equals(transport)
            ? "Wi-Fi"
            : "usb".equals(transport) ? "USB" : L10n.text("자동 (Wi-Fi 우선)");
    new AlertDialog.Builder(L10n.context(this))
        .setTitle(L10n.text("연결: ") + mode)
        .setItems(
            new String[] {
              L10n.text("자동: Wi-Fi 우선 · USB 대체"),
              L10n.text("Wi-Fi로만 연결"),
              L10n.text("USB로만 연결"),
              L10n.text("맥 Wi-Fi 주소 관리"),
              L10n.text("현재 연결 정보")
            },
            (d, index) -> {
              if (index < 3) {
                if (index == 1 && wifiPin.isEmpty()) {
                  Toast.makeText(
                          this, L10n.text("USB로 한 번 연결해 Wi-Fi 인증서를 등록하세요."), Toast.LENGTH_LONG)
                      .show();
                  return;
                }
                reconnect(new String[] {"auto", "wifi", "usb"}[index]);
              } else if (index == 3) {
                wifiAddressSettings();
              } else {
                new AlertDialog.Builder(L10n.context(this))
                    .setTitle(L10n.text("연결 정보"))
                    .setMessage(
                        (connected ? L10n.text("연결됨: ") : L10n.text("재연결 중: "))
                            + base
                            + L10n.text("\n\n인증서: ")
                            + (wifiPin.isEmpty() ? L10n.text("미등록 · USB로 먼저 연결하세요") : wifiPin)
                            + (connectionError.isEmpty() ? "" : "\n\n" + connectionError))
                    .setPositiveButton(L10n.text("확인"), null)
                    .show();
              }
            })
        .setNegativeButton(L10n.text("닫기"), null)
        .show();
  }

  private void stopHostDiscovery() {
    if (discoveryManager != null && discoveryListener != null) {
      try {
        discoveryManager.stopServiceDiscovery(discoveryListener);
      } catch (Exception ignored) {
      }
    }
    discoveryListener = null;
  }

  private void discoverHosts() {
    if (wifiPin.isEmpty()) {
      new AlertDialog.Builder(L10n.context(this))
          .setTitle(L10n.text("최초 등록이 필요합니다"))
          .setMessage(L10n.text("USB로 한 번 등록한 뒤 같은 맥의 Wi-Fi 주소를 자동으로 찾을 수 있습니다."))
          .setPositiveButton(L10n.text("확인"), null)
          .show();
      return;
    }
    stopHostDiscovery();
    LinearLayout rows = new LinearLayout(this);
    rows.setOrientation(LinearLayout.VERTICAL);
    rows.setPadding((int) dp(20), (int) dp(12), (int) dp(20), (int) dp(12));
    TextView status = new TextView(this);
    status.setText(L10n.text("같은 Wi-Fi에서 등록한 맥을 찾고 있습니다…"));
    rows.addView(status);
    AlertDialog dialog =
        new AlertDialog.Builder(L10n.context(this))
            .setTitle(L10n.text("Wi-Fi 호스트 검색"))
            .setView(rows)
            .setNegativeButton(L10n.text("닫기"), null)
            .create();
    Set<String> found = ConcurrentHashMap.newKeySet();
    discoveryManager = getSystemService(android.net.nsd.NsdManager.class);
    if (discoveryManager == null) {
      Toast.makeText(this, L10n.text("이 기기에서 호스트 검색을 사용할 수 없습니다."), Toast.LENGTH_LONG).show();
      return;
    }
    android.net.nsd.NsdManager.DiscoveryListener listener =
        new android.net.nsd.NsdManager.DiscoveryListener() {
          public void onDiscoveryStarted(String type) {}

          public void onDiscoveryStopped(String type) {}

          public void onStartDiscoveryFailed(String type, int error) {
            ui.post(() -> status.setText(L10n.text("검색을 시작하지 못했습니다. 주소를 직접 추가할 수 있습니다.")));
          }

          public void onStopDiscoveryFailed(String type, int error) {}

          public void onServiceLost(android.net.nsd.NsdServiceInfo service) {}

          public void onServiceFound(android.net.nsd.NsdServiceInfo service) {
            if (!service.getServiceType().startsWith("_opendeck._tcp")) return;
            discoveryManager.resolveService(
                service,
                new android.net.nsd.NsdManager.ResolveListener() {
                  public void onResolveFailed(android.net.nsd.NsdServiceInfo info, int error) {}

                  public void onServiceResolved(android.net.nsd.NsdServiceInfo info) {
                    if (info.getHost() == null) return;
                    byte[] tlsAttribute = info.getAttributes().get("tls");
                    boolean plaintext =
                        tlsAttribute != null
                            && new String(tlsAttribute, StandardCharsets.UTF_8).equals("0");
                    if (plaintext && !settingBool("allowInsecureWifi")) return;
                    String address =
                        (plaintext ? "http://" : "https://")
                            + info.getHost().getHostAddress()
                            + ":"
                            + info.getPort();
                    if (!validWifiUrl(address)
                        || !found.add(address)
                        || settingRequests.isShutdown()) return;
                    settingRequests.execute(
                        () -> {
                          HttpURLConnection connection = null;
                          try {
                            connection =
                                PinnedConnection.open(
                                    address + "/health", wifiPin, settingBool("allowInsecureWifi"));
                            connection.setConnectTimeout(1500);
                            connection.setReadTimeout(1500);
                            if (connection.getResponseCode() != 200) return;
                            ui.post(
                                () -> {
                                  if (!dialog.isShowing()) return;
                                  status.setText(
                                      plaintext
                                          ? L10n.text("암호화하지 않는 LAN 호스트를 찾았습니다. 연결 전에 주소를 확인하세요.")
                                          : L10n.text("저장된 인증서가 일치하는 맥을 찾았습니다."));
                                  Button item = new Button(MainActivity.this);
                                  item.setAllCaps(false);
                                  item.setText(info.getServiceName() + "\n" + address);
                                  rows.addView(item);
                                  item.setOnClickListener(
                                      v -> {
                                        List<String> next = new ArrayList<>(wifiUrls);
                                        next.remove(address);
                                        next.add(0, address);
                                        if (next.size() > 8)
                                          next = new ArrayList<>(next.subList(0, 8));
                                        saveWifiAddresses(next);
                                        dialog.dismiss();
                                        Toast.makeText(
                                                MainActivity.this,
                                                L10n.text("맥 주소를 저장했습니다."),
                                                Toast.LENGTH_SHORT)
                                            .show();
                                      });
                                });
                          } catch (Exception ignored) {
                          } finally {
                            if (connection != null) connection.disconnect();
                          }
                        });
                  }
                });
          }
        };
    discoveryListener = listener;
    dialog.setOnDismissListener(
        d -> {
          if (discoveryListener == listener) stopHostDiscovery();
        });
    dialog.show();
    try {
      discoveryManager.discoverServices(
          "_opendeck._tcp.", android.net.nsd.NsdManager.PROTOCOL_DNS_SD, listener);
    } catch (Exception e) {
      status.setText(L10n.text("검색을 시작하지 못했습니다. 주소를 직접 추가할 수 있습니다."));
    }
    ui.postDelayed(
        () -> {
          if (dialog.isShowing() && discoveryListener == listener) {
            stopHostDiscovery();
            if (rows.getChildCount() == 1)
              status.setText(L10n.text("등록한 맥을 찾지 못했습니다. 같은 Wi-Fi인지 확인하거나 주소를 직접 추가하세요."));
          }
        },
        10000);
  }

  private void wifiAddressSettings() {
    ClientSettingsPanel p =
        panel(L10n.text("맥 Wi-Fi 주소"), L10n.text("등록한 주소를 순서대로 시도합니다. 기존 인증서가 일치하는 맥에만 연결합니다."));
    List<String> addresses = new ArrayList<>(wifiUrls);
    for (String address : addresses)
      p.action(
          address,
          L10n.text("탭하여 수정하거나 제거"),
          () -> {
            new AlertDialog.Builder(L10n.context(this))
                .setTitle(address)
                .setItems(
                    new String[] {L10n.text("주소 수정"), L10n.text("주소 제거")},
                    (d, index) -> {
                      if (index == 0) editWifiAddress(address);
                      else if (wifiUrls.size() <= 1)
                        Toast.makeText(
                                this, L10n.text("Wi-Fi 주소는 하나 이상 유지해야 합니다."), Toast.LENGTH_LONG)
                            .show();
                      else {
                        List<String> next = new ArrayList<>(wifiUrls);
                        next.remove(address);
                        saveWifiAddresses(next);
                        wifiAddressSettings();
                      }
                    })
                .setNegativeButton(L10n.text("취소"), null)
                .show();
          });
    p.action(
        L10n.text("주소 추가"), L10n.text("맥 편집기에 표시된 HTTPS 주소를 입력합니다."), () -> editWifiAddress(null));
    p.show();
  }

  private void editWifiAddress(String previous) {
    ClientSettingsPanel p = panel(L10n.text("Wi-Fi 주소"), "");
    p.input(
        L10n.text("맥 Wi-Fi 주소"),
        previous == null ? "https://192.168.0.1:8841" : previous,
        settingBool("allowInsecureWifi")
            ? L10n.text("사설 IP와 포트를 입력하세요. HTTPS를 우선 사용하며 HTTP 연결은 암호화되지 않습니다.")
            : L10n.text("사설 IP의 HTTPS 주소와 포트를 입력하세요. 최초 인증서 등록에는 USB가 필요합니다."),
        value -> {
          if (!validWifiUrl(value))
            throw new IllegalArgumentException(L10n.text("예: https://192.168.0.10:8841"));
          List<String> next = new ArrayList<>(wifiUrls);
          if (previous != null) next.remove(previous);
          if (!next.contains(value)) next.add(value);
          if (next.size() > 8) throw new IllegalArgumentException(L10n.text("주소는 최대 8개입니다."));
          saveWifiAddresses(next);
        });
  }

  private void saveWifiAddresses(List<String> values) {
    wifiUrls = new ArrayList<>(values);
    prefs.edit().putString("wifiUrls", new JSONArray(values).toString()).apply();
    reconnect(transport);
  }

  private void showErrors() {
    JSONObject r = state.optJSONObject("results");
    if (r == null) return;
    Iterator<String> keys = r.keys();
    while (keys.hasNext()) {
      String k = keys.next();
      JSONObject result = r.optJSONObject(k);
      if (result != null
          && "error".equals(result.optString("status"))
          && result.optLong("at") > lastErrors.getOrDefault(k, 0L)) {
        lastErrors.put(k, result.optLong("at"));
        Toast.makeText(this, result.optString("message"), Toast.LENGTH_LONG).show();
      }
    }
  }

  private JSONObject activePage() {
    JSONArray pages = config.optJSONArray("pages");
    if (pages == null || pages.length() == 0) return new JSONObject();
    for (int i = 0; i < pages.length(); i++)
      if (pages.optJSONObject(i).optString("id").equals(pageId)) return pages.optJSONObject(i);
    return pages.optJSONObject(0);
  }

  private Object variable(String key) {
    JSONObject vars = state.optJSONObject("variables");
    return vars != null && vars.has(key) ? vars.opt(key) : state.opt(key);
  }

  private String template(String text) {
    Matcher m = TEMPLATE.matcher(text);
    StringBuffer result = new StringBuffer();
    while (m.find()) {
      Object v = variable(m.group(1));
      m.appendReplacement(result, Matcher.quoteReplacement(v == null ? "—" : String.valueOf(v)));
    }
    m.appendTail(result);
    return result.toString();
  }

  private void navigate(String id) {
    JSONArray pages = config.optJSONArray("pages");
    if (pages == null) return;
    if (!pageVisible(id)) {
      requestedNavigationPage = id;
      navigationProfileRequested = false;
      resolveRequestedNavigation();
      return;
    }
    requestedNavigationPage = "";
    navigationProfileRequested = false;
    if (id.equals(pageId)) return;
    int current = 0;
    for (int i = 0; i < pages.length(); i++)
      if (pages.optJSONObject(i).optString("id").equals(pageId)) current = i;
    for (int i = 0; i < pages.length(); i++)
      if (pages.optJSONObject(i).optString("id").equals(id)) {
        deck.finishPageTransition();
        List<DeckView.Tile> previous = new ArrayList<>(deck.tiles);
        pageId = id;
        prefs.edit().putString("page", id).apply();
        deck.scroll = 0;
        deck.rebuild();
        deck.updateState();
        deck.animatePage(previous, i > current ? 1 : -1);
        return;
      }
  }

  private boolean pageVisible(String id) {
    JSONArray pages = config.optJSONArray("pages");
    if (pages != null)
      for (int i = 0; i < pages.length(); i++)
        if (pages.optJSONObject(i).optString("id").equals(id)) return true;
    return false;
  }

  private JSONObject navigationCatalog() {
    return config.optJSONArray("pages") != null ? config : savedNavigationCatalog;
  }

  private void loadNavigationCatalog() {
    if (token.isEmpty()) return;
    try {
      savedNavigationCatalog = new JSONObject(prefs.getString("navigationCatalog", "{}"));
    } catch (Exception ignored) {
      savedNavigationCatalog = new JSONObject();
    }
  }

  private void cacheNavigationCatalog(JSONObject source) {
    try {
      JSONObject catalog = new JSONObject();
      catalog.put("defaultProfileId", source.optString("defaultProfileId"));
      for (String kind : new String[] {"profiles", "pages"}) {
        JSONArray items = source.optJSONArray(kind), entries = new JSONArray();
        if (items != null)
          for (int i = 0; i < items.length(); i++) {
            JSONObject item = items.optJSONObject(i);
            if (item == null) continue;
            Map<String, Object> values = new LinkedHashMap<>();
            Iterator<String> keys = item.keys();
            while (keys.hasNext()) {
              String key = keys.next();
              Object value = item.opt(key);
              if (key.equals("pageIds") && value instanceof JSONArray ids) {
                List<String> list = new ArrayList<>();
                for (int j = 0; j < ids.length(); j++)
                  if (ids.opt(j) instanceof String id) list.add(id);
                value = list;
              }
              values.put(key, value);
            }
            entries.put(
                new JSONObject(ProfileNavigation.catalogEntry(values, kind.equals("profiles"))));
          }
        catalog.put(kind, entries);
      }
      String encoded = catalog.toString();
      if (!encoded.equals(savedNavigationCatalog.toString())) {
        savedNavigationCatalog = catalog;
        prefs.edit().putString("navigationCatalog", encoded).apply();
      }
    } catch (Exception ignored) {
      // A malformed catalog cannot replace the last usable names or prevent connection.
    }
  }

  private Map<String, List<String>> profilePageCatalog() {
    Map<String, List<String>> catalog = new LinkedHashMap<>();
    JSONArray profiles = navigationCatalog().optJSONArray("profiles");
    if (profiles != null)
      for (int i = 0; i < profiles.length(); i++) {
        JSONObject profile = profiles.optJSONObject(i);
        if (profile == null) continue;
        List<String> pages = new ArrayList<>();
        JSONArray ids = profile.optJSONArray("pageIds");
        if (ids != null) for (int j = 0; j < ids.length(); j++) pages.add(ids.optString(j));
        catalog.put(profile.optString("id"), pages);
      }
    return catalog;
  }

  private String profileDefaultPage() {
    JSONObject catalog = navigationCatalog();
    String active = settingString("profileId");
    if (active.isEmpty()) active = catalog.optString("defaultProfileId");
    JSONArray profiles = catalog.optJSONArray("profiles");
    if (profiles != null)
      for (int i = 0; i < profiles.length(); i++) {
        JSONObject profile = profiles.optJSONObject(i);
        if (profile != null && profile.optString("id").equals(active)) {
          String first = profile.optString("defaultPageId");
          JSONArray ids = profile.optJSONArray("pageIds");
          return !first.isEmpty() ? first : ids != null && ids.length() > 0 ? ids.optString(0) : "";
        }
      }
    return "";
  }

  private void resolveRequestedNavigation() {
    if (requestedNavigationPage.isEmpty()) return;
    if (pageVisible(requestedNavigationPage)) {
      pageId = requestedNavigationPage;
      prefs.edit().putString("page", pageId).apply();
      requestedNavigationPage = "";
      navigationProfileRequested = false;
      return;
    }
    if (navigationProfileRequested || config.optJSONArray("profiles") == null) return;
    String target =
        ProfileNavigation.targetProfile(
            requestedNavigationPage,
            settingString("profileId"),
            config.optString("defaultProfileId"),
            profilePageCatalog());
    if (target == null) {
      requestedNavigationPage = "";
      return;
    }
    // One settings request changes both values. There is no intermediate profile with a stale page.
    settingsSync.queue("profileId", target);
    settingsSync.queue("startPageId", requestedNavigationPage);
    navigationProfileRequested = true;
    persistClientSettings();
    flushDeviceSettings();
  }

  private Bitmap bitmap(String id, int target) {
    if (!id.matches("[a-f0-9]{64}")) return null;
    String key = id + "@" + target;
    Bitmap cached = bitmapCache.get(key);
    if (cached != null) return cached;
    if (loadingImages.add(key) && !images.isShutdown())
      images.execute(
          () -> {
            HttpURLConnection c = null;
            try {
              c =
                  PinnedConnection.open(
                      base + "/api/assets/" + id, wifiPin, settingBool("allowInsecureWifi"));
              c.setConnectTimeout(2500);
              c.setReadTimeout(5000);
              c.setRequestProperty("Authorization", "Bearer " + token);
              if (c.getResponseCode() != 200) return;
              ByteArrayOutputStream out = new ByteArrayOutputStream();
              byte[] buf = new byte[8192];
              int read;
              try (InputStream in = c.getInputStream()) {
                while ((read = in.read(buf)) != -1) {
                  if (out.size() + read > 2097152) throw new IOException("Image too large");
                  out.write(buf, 0, read);
                }
              }
              byte[] data = out.toByteArray();
              BitmapFactory.Options o = new BitmapFactory.Options();
              o.inJustDecodeBounds = true;
              BitmapFactory.decodeByteArray(data, 0, data.length, o);
              if (o.outWidth <= 0 || o.outHeight <= 0 || o.outWidth > 8192 || o.outHeight > 8192)
                return;
              int sample = 1;
              while (o.outWidth / sample > target * 2 || o.outHeight / sample > target * 2)
                sample *= 2;
              o.inJustDecodeBounds = false;
              o.inSampleSize = sample;
              Bitmap b = BitmapFactory.decodeByteArray(data, 0, data.length, o);
              if (b != null) bitmapCache.put(key, b);
              ui.post(
                  () -> {
                    if (deck != null) {
                      deck.invalidate();
                      for (DeckView.Tile tile : deck.tiles)
                        if (id.equals(tile.widget.optString("image"))) tile.invalidate();
                    }
                  });
            } catch (Exception ignored) {
            } finally {
              if (c != null) c.disconnect();
              loadingImages.remove(key);
            }
          });
    return null;
  }

  private void todoDialog(JSONObject w) {
    JSONArray all =
        state.optJSONObject("todos") == null
            ? new JSONArray()
            : state.optJSONObject("todos").optJSONArray(w.optString("id"));
    if (all == null) all = new JSONArray();
    final JSONArray items = all;
    String[] labels = new String[items.length() + 1];
    labels[0] = L10n.text("＋ 할 일 추가");
    for (int i = 0; i < items.length(); i++) {
      JSONObject item = items.optJSONObject(i);
      labels[i + 1] = (item.optBoolean("done") ? "✓ " : "○ ") + item.optString("text");
    }
    new AlertDialog.Builder(L10n.context(this))
        .setTitle(w.optString("label", L10n.text("할 일")))
        .setItems(
            labels,
            (d, index) -> {
              if (index == 0) {
                EditText input = new EditText(this);
                input.setSingleLine(true);
                input.setFilters(
                    new android.text.InputFilter[] {
                      new android.text.InputFilter.LengthFilter(160)
                    });
                new AlertDialog.Builder(L10n.context(this))
                    .setTitle(L10n.text("새 할 일"))
                    .setView(input)
                    .setNegativeButton(L10n.text("취소"), null)
                    .setPositiveButton(
                        L10n.text("추가"),
                        (x, y) -> {
                          try {
                            action(
                                new JSONObject()
                                    .put("kind", "todo")
                                    .put("id", w.getString("id"))
                                    .put("gesture", "add")
                                    .put("value", input.getText().toString()));
                          } catch (JSONException ignored) {
                          }
                        })
                    .show();
              } else {
                JSONObject item = items.optJSONObject(index - 1);
                new AlertDialog.Builder(L10n.context(this))
                    .setTitle(item.optString("text"))
                    .setItems(
                        new String[] {
                          item.optBoolean("done") ? L10n.text("다시 진행") : L10n.text("완료로 표시"),
                          L10n.text("삭제")
                        },
                        (x, y) -> {
                          try {
                            action(
                                new JSONObject()
                                    .put("kind", "todo")
                                    .put("id", w.getString("id"))
                                    .put("gesture", y == 0 ? "toggle" : "delete")
                                    .put("value", item.getString("id")));
                          } catch (JSONException ignored) {
                          }
                        })
                    .show();
              }
            })
        .setNegativeButton(L10n.text("닫기"), null)
        .show();
  }

  private String lastButtonId = "";
  private long lastButtonAt = 0;
  private Runnable singleTap;

  private void dispatchButton(JSONObject w, String gesture) throws JSONException {
    if (gesture.equals("tap") && osNativeButton(w)) return;
    JSONObject gestures = w.optJSONObject("gestures");
    boolean hasDouble = gestures != null && gestures.optBoolean("double"),
        hasLong = gestures != null && gestures.optBoolean("long");
    String id = w.getString("id");
    if (gesture.equals("long") && hasLong) {
      action(new JSONObject().put("id", id).put("gesture", "long"));
      return;
    }
    if (!hasDouble) {
      action(new JSONObject().put("id", id));
      return;
    }
    long now = SystemClock.elapsedRealtime();
    if (id.equals(lastButtonId) && now - lastButtonAt < 260) {
      if (singleTap != null) ui.removeCallbacks(singleTap);
      lastButtonId = "";
      action(new JSONObject().put("id", id).put("gesture", "double"));
    } else {
      lastButtonId = id;
      lastButtonAt = now;
      singleTap =
          () -> {
            try {
              action(new JSONObject().put("id", id));
            } catch (JSONException ignored) {
            }
          };
      ui.postDelayed(singleTap, 260);
    }
  }

  private long hostNow() {
    return serverTime == 0
        ? System.currentTimeMillis()
        : serverTime + SystemClock.elapsedRealtime() - receivedAt;
  }

  private void action(JSONObject body) {
    if (!connected) {
      Toast.makeText(this, L10n.text("맥 연결을 기다리는 중입니다."), Toast.LENGTH_SHORT).show();
      return;
    }
    String id = body.optString("id", "volume");
    if (pending.containsKey(id) || runningIds.contains(id)) return;
    pending.put(id, SystemClock.elapsedRealtime());
    touchFeedback(HapticFeedbackConstants.KEYBOARD_TAP);
    try {
      commands.execute(
          () -> {
            try {
              request("/api/action", "POST", body, true);
            } catch (Exception e) {
              ui.post(() -> Toast.makeText(this, e.getMessage(), Toast.LENGTH_SHORT).show());
            } finally {
              ui.post(() -> pending.remove(id));
            }
          });
    } catch (RejectedExecutionException e) {
      pending.remove(id);
      Toast.makeText(this, L10n.text("다른 동작이 진행 중입니다. 잠시 후 다시 눌러 주세요."), Toast.LENGTH_SHORT).show();
    }
  }

  private javax.crypto.SecretKey key() throws Exception {
    KeyStore store = KeyStore.getInstance("AndroidKeyStore");
    store.load(null);
    if (store.containsAlias("opendeck-token"))
      return (javax.crypto.SecretKey) store.getKey("opendeck-token", null);
    KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
    gen.init(
        new KeyGenParameterSpec.Builder(
                "opendeck-token", KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .build());
    return gen.generateKey();
  }

  private void saveToken(String value) throws Exception {
    Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
    c.init(Cipher.ENCRYPT_MODE, key());
    String data =
        Base64.encodeToString(c.getIV(), Base64.NO_WRAP)
            + ":"
            + Base64.encodeToString(
                c.doFinal(value.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
    prefs.edit().putString("token", data).apply();
  }

  private String readToken() {
    try {
      String stored = prefs.getString("token", "");
      if (stored.isEmpty()) return "";
      String[] parts = stored.split(":");
      Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
      c.init(
          Cipher.DECRYPT_MODE,
          key(),
          new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
      return new String(c.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8);
    } catch (Exception e) {
      return "";
    }
  }

  private Object setting(String key) {
    return clientSettings.get(key);
  }

  private boolean settingBool(String key) {
    return Boolean.TRUE.equals(setting(key));
  }

  private int settingInt(String key) {
    return ((Number) setting(key)).intValue();
  }

  private String settingString(String key) {
    return String.valueOf(setting(key));
  }

  private boolean reducedMotion() {
    return settingBool("reducedMotion") || settingString("renderMode").equals("simple");
  }

  private float contentTop() {
    return dp(settingBool("showHeader") ? 68 : 12);
  }

  private float contentBottom() {
    return dp(settingBool("showNavigation") ? 46 : 12);
  }

  private Map<String, Object> settingsMap(JSONObject object) {
    Map<String, Object> result = new LinkedHashMap<>();
    if (object != null)
      for (String key : clientSettings.keySet())
        if (object.has(key)) result.put(key, object.opt(key));
    return result;
  }

  private void loadClientSettings() {
    deviceName = prefs.getString("deviceName", deviceName);
    lastScreenSaverAt = prefs.getLong("lastScreenSaverAt", 0);
    Map<String, Object> saved = new LinkedHashMap<>(), pending = new LinkedHashMap<>();
    saved.put("awake", prefs.getBoolean("awake", true));
    try {
      saved.putAll(settingsMap(new JSONObject(prefs.getString("clientSettings", "{}"))));
    } catch (Exception ignored) {
    }
    try {
      pending.putAll(settingsMap(new JSONObject(prefs.getString("pendingClientSettings", "{}"))));
    } catch (Exception ignored) {
    }
    settingsSync.restore(saved, pending);
  }

  private void resetDeviceIdentity() {
    pairingGeneration++;
    settingsSyncRunning = false;
    settingsSyncRetryAt = 0;
    settingsSync.resetRemote();
    deviceMetadataSent = false;
    requestedNavigationPage = "";
    navigationProfileRequested = false;
    lastScreenSaverAt = 0;
    settingsSync.clearProfile();
    savedNavigationCatalog = new JSONObject();
    prefs.edit().remove("lastScreenSaverAt").remove("navigationCatalog").apply();
    persistClientSettings();
  }

  private void persistClientSettings() {
    prefs
        .edit()
        .putString("clientSettings", new JSONObject(clientSettings).toString())
        .putString("pendingClientSettings", new JSONObject(pendingSettings).toString())
        .putString("deviceName", deviceName)
        .putBoolean("awake", settingBool("awake"))
        .apply();
  }

  private void saveClientSetting(String key, Object value) {
    if (!settingsSync.edit(key, value)) return;
    if (key.equals("allowInsecureWifi")) reconnect(transport);
    if (key.equals("profileId")) {
      settingsSync.queue("startPageId", "");
      requestedNavigationPage = profileDefaultPage();
      navigationProfileRequested = true;
    } else if (key.equals("startPageId")) {
      requestedNavigationPage =
          settingString("startPageId").isEmpty()
              ? profileDefaultPage()
              : settingString("startPageId");
      navigationProfileRequested = true;
    }
    resolveRequestedNavigation();
    persistClientSettings();
    wakeDisplay();
    applyClientSettings();
    flushDeviceSettings();
  }

  private boolean settingsSyncRunning;
  private long settingsSyncRetryAt;

  private void flushDeviceSettings() {
    if ((pendingSettings.isEmpty() && deviceMetadataSent)
        || settingsSyncRunning
        || !connected
        || token.isEmpty()
        || SystemClock.elapsedRealtime() < settingsSyncRetryAt) return;
    ClientSettingsSync.Patch patch = settingsSync.snapshot();
    long generation = pairingGeneration;
    String pairedToken = token;
    settingsSyncRunning = true;
    settingRequests.execute(
        () -> {
          if (generation != pairingGeneration) return;
          try {
            JSONObject body =
                new JSONObject()
                    .put("settings", new JSONObject(patch.values))
                    .put("model", Build.MODEL)
                    .put("appVersion", appVersion());
            JSONObject response =
                requestWithToken("/api/device/settings", "PUT", body, pairedToken);
            ui.post(
                () -> {
                  if (generation != pairingGeneration) return;
                  deviceMetadataSent = true;
                  settingsSync.acknowledge(patch);
                  persistClientSettings();
                  settingsSyncRunning = false;
                  receiveDeviceSettings(response.optJSONObject("device"));
                  flushDeviceSettings();
                });
          } catch (Exception e) {
            ui.post(
                () -> {
                  if (generation != pairingGeneration) return;
                  settingsSyncRunning = false;
                  settingsSyncRetryAt = SystemClock.elapsedRealtime() + 15000;
                  recordConnection("settings-pending", e.getClass().getSimpleName());
                });
          }
        });
  }

  private void receiveDeviceSettings(JSONObject device) {
    if (device == null) return;
    long revision = device.optLong("settingsRevision", 0);
    String previousProfile = settingString("profileId"),
        previousStartPage = settingString("startPageId");
    boolean previousInsecureWifi = settingBool("allowInsecureWifi");
    int previousIdleMinutes = settingInt("screenSaverMinutes");
    boolean newer = ClientSettingsPolicy.acceptRevision(revision, settingsSync.revision());
    boolean changed = settingsSync.receive(settingsMap(device.optJSONObject("settings")), revision);
    if (config.optJSONArray("profiles") != null
        && settingsSync.reconcileNavigation(
            profilePageCatalog(), config.optString("defaultProfileId"))) {
      requestedNavigationPage = "";
      navigationProfileRequested = false;
      changed = true;
      recordConnection("settings-navigation-reset", "profile-or-page-removed");
    }
    if (newer && device.has("name")) deviceName = device.optString("name", deviceName);
    persistClientSettings();
    if (!previousProfile.equals(settingString("profileId"))
        || !previousStartPage.equals(settingString("startPageId"))) {
      if (requestedNavigationPage.isEmpty()) {
        requestedNavigationPage =
            settingString("startPageId").isEmpty()
                ? profileDefaultPage()
                : settingString("startPageId");
        navigationProfileRequested = true;
      }
      resolveRequestedNavigation();
    }
    if (ClientSettingsPolicy.shouldWakeAfterIdleChange(
        previousIdleMinutes, settingInt("screenSaverMinutes"), automaticIdle)) wakeDisplay();
    if (changed) applyClientSettings();
    if (previousInsecureWifi != settingBool("allowInsecureWifi")) reconnect(transport);
    ClientSettingsPanel.refreshOpenPanels();
    long screenSaverAt = device.optLong("screenSaverAt");
    if (screenSaverAt > lastScreenSaverAt) {
      lastScreenSaverAt = screenSaverAt;
      prefs.edit().putLong("lastScreenSaverAt", screenSaverAt).apply();
      if (Math.abs(System.currentTimeMillis() - screenSaverAt) < 30000 && foreground)
        setIdleDimmed(true);
    }
    flushDeviceSettings();
  }

  private void applyClientSettings() {
    if (prefs == null) return;
    boolean localeChanged = L10n.configure(this, settingString("language"));
    if (localeChanged) {
      if (ClientSettingsPanel.dismissForLocaleChange()) ui.post(this::displaySettings);
      osDateFormats.clear();
      if (deck != null) {
        deck.dateFormat.applyPattern(L10n.datePattern("M월 d일 EEEE"));
        deck.dateFormat.setDateFormatSymbols(new java.text.DateFormatSymbols(L10n.locale()));
        deck.timeFormat.setDateFormatSymbols(new java.text.DateFormatSymbols(L10n.locale()));
      }
    }
    if (settingBool("awake")) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    String orientation = settingString("orientation");
    int rotation =
        orientation.equals("landscape")
            ? android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
            : orientation.equals("portrait")
                ? android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
                : android.content.pm.ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR;
    if (getRequestedOrientation() != rotation) setRequestedOrientation(rotation);
    immersive();
    applyBrightness();
    ClientSettingsPanel.refreshOpenPanels();
    if (deck != null) {
      deck.rebuild();
      deck.updateState();
      for (DeckView.Tile tile : deck.cachedTiles.values()) tile.invalidate();
    }
  }

  private void applyBrightness() {
    WindowManager.LayoutParams params = getWindow().getAttributes();
    float brightness =
        ClientSettingsPolicy.brightness(
            settingInt("brightness"), idleDimmed, settingInt("dimPercent"));
    if (params.screenBrightness != brightness) {
      params.screenBrightness = brightness;
      getWindow().setAttributes(params);
    }
  }

  private void setIdleDimmed(boolean value) {
    setIdleDimmed(value, false);
  }

  private void setIdleDimmed(boolean value, boolean automatic) {
    automaticIdle = value && automatic;
    if (idleDimmed == value) return;
    idleDimmed = value;
    if (deck != null) {
      deck.finishPageTransition();
      deck.invalidate();
    }
    applyBrightness();
  }

  private void wakeDisplay() {
    lastInteraction = SystemClock.elapsedRealtime();
    setIdleDimmed(false);
  }

  @Override
  public boolean dispatchTouchEvent(MotionEvent event) {
    int action = event.getActionMasked();
    if (action == MotionEvent.ACTION_DOWN) {
      boolean wakeTouch =
          wakeGuard.beginTouch(
              idleDimmed,
              settingBool("firstTouchWakes"),
              settingString("screenSaverMode").equals("clock"));
      cornerConsumed = false;
      wakeDisplay();
      if (!wakeTouch
          && deck != null
          && event.getX() > deck.getWidth() - dp(55)
          && event.getY() < dp(55)) {
        cornerX = event.getX();
        cornerY = event.getY();
        ui.postDelayed(cornerSettings, 900);
      }
    } else if (action == MotionEvent.ACTION_MOVE) {
      lastInteraction = SystemClock.elapsedRealtime();
      if (Math.abs(event.getX() - cornerX) + Math.abs(event.getY() - cornerY) > dp(12))
        ui.removeCallbacks(cornerSettings);
    } else if (action == MotionEvent.ACTION_UP
        || action == MotionEvent.ACTION_CANCEL
        || action == MotionEvent.ACTION_POINTER_DOWN) {
      ui.removeCallbacks(cornerSettings);
    }
    if (wakeGuard.consumeTouch(
            action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL)
        || cornerConsumed) return true;
    return super.dispatchTouchEvent(event);
  }

  @Override
  public boolean dispatchKeyEvent(KeyEvent event) {
    boolean volume =
        event.getKeyCode() == KeyEvent.KEYCODE_VOLUME_UP
            || event.getKeyCode() == KeyEvent.KEYCODE_VOLUME_DOWN;
    boolean consumed =
        !volume
            && wakeGuard.consumeKey(
                event.getKeyCode(),
                event.getAction() == KeyEvent.ACTION_DOWN,
                idleDimmed,
                settingBool("firstTouchWakes"),
                settingString("screenSaverMode").equals("clock"));
    if (event.getAction() == KeyEvent.ACTION_DOWN) wakeDisplay();
    return consumed || super.dispatchKeyEvent(event);
  }

  private void touchFeedback(int feedback) {
    if (deck == null) return;
    if (settingBool("sound")) deck.playSoundEffect(SoundEffectConstants.CLICK);
    if (!settingBool("haptics")) return;
    if (settingBool("fixedVibration")) {
      if (android.provider.Settings.System.getInt(
              getContentResolver(), android.provider.Settings.System.HAPTIC_FEEDBACK_ENABLED, 1)
          == 0) return;
      Vibrator vibrator = getSystemService(Vibrator.class);
      if (vibrator != null && vibrator.hasVibrator())
        vibrator.vibrate(
            VibrationEffect.createOneShot(
                settingInt("vibrationMs"), VibrationEffect.DEFAULT_AMPLITUDE));
    } else deck.performHapticFeedback(feedback);
  }

  private synchronized void recordConnection(String event, String detail) {
    String line =
        new SimpleDateFormat("MM-dd HH:mm:ss", Locale.ROOT).format(new Date())
            + " · "
            + event
            + " · "
            + detail;
    if (connectionLog.size() >= 100) connectionLog.removeFirst();
    connectionLog.addLast(line);
  }

  private String appVersion() {
    try {
      return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
    } catch (Exception ignored) {
      return "—";
    }
  }

  private synchronized String diagnostics() {
    return "Open Deck "
        + appVersion()
        + " · Android "
        + Build.VERSION.RELEASE
        + "\n"
        + Build.MANUFACTURER
        + " "
        + Build.MODEL
        + L10n.text("\n연결: ")
        + (streamFresh() ? L10n.text("연결됨") : L10n.text("재연결 중"))
        + " · "
        + transport
        + L10n.text("\nWi-Fi 인증서: ")
        + (wifiPin.isEmpty() ? L10n.text("미등록") : L10n.text("등록됨"))
        + L10n.text("\n설정 동기화: ")
        + (pendingSettings.isEmpty() ? L10n.text("완료") : L10n.text("연결 후 재시도 예정"))
        + L10n.text("\n설정 버전: ")
        + settingsSync.revision()
        + "\n\n"
        + String.join("\n", connectionLog);
  }

  private ClientSettingsPanel panel(String title, String description) {
    return new ClientSettingsPanel(
        this,
        new ClientSettingsPanel.Host() {
          public Object value(String key) {
            return setting(key);
          }

          public void save(String key, Object value) {
            saveClientSetting(key, value);
          }
        },
        title,
        description);
  }

  private static Map<String, Object> choices(Object... pairs) {
    Map<String, Object> values = new LinkedHashMap<>();
    for (int i = 0; i < pairs.length; i += 2) values.put((String) pairs[i], pairs[i + 1]);
    return values;
  }

  private void settings() {
    wakeDisplay();
    ClientSettingsPanel p =
        panel(L10n.text("Open Deck · 설정"), L10n.text("이 태블릿의 설정은 자동 저장됩니다. 맥의 기기 설정과도 연결됩니다."))
            .onThemeChanged(this::settings);
    p.action(L10n.text("화면 · 밝기"), L10n.text("테마, 회전, 글자 크기와 렌더링"), this::displaySettings);
    p.action(L10n.text("터치 · 페이지 이동"), L10n.text("진동, 효과음, 제스처와 메뉴 표시"), this::inputSettings);
    p.action(L10n.text("화면 보호"), L10n.text("유휴 밝기, 시계와 첫 터치 동작"), this::idleSettings);
    p.action(
        L10n.text("프로필 · 시작 페이지"), L10n.text("사용할 프로필과 앱을 열 때 표시할 페이지"), this::startupSettings);
    p.action(L10n.text("연결 · 기기 이름"), L10n.text("Wi-Fi / USB, 재연결과 기기 이름"), this::deviceSettings);
    p.action(L10n.text("알림"), L10n.text("OS 일정, 시스템·DB 경고와 배너"), this::notificationSettings);
    p.action(
        L10n.text("정보 · 진단 · 초기화"),
        L10n.text("버전 ") + appVersion() + L10n.text(" · 연결 기록"),
        this::diagnosticSettings);
    p.note(L10n.text("설정 버튼을 숨겨도 화면 오른쪽 위 모서리를 1초간 누르면 다시 열립니다."));
    p.show();
  }

  private void displaySettings() {
    ClientSettingsPanel p =
        panel(L10n.text("화면 · 밝기"), L10n.text("덱의 페이지 색상과 배치는 맥 편집기에서 설정합니다."))
            .onThemeChanged(this::displaySettings);
    Map<String, Object> languageChoices = new LinkedHashMap<>();
    for (Map.Entry<String, String> language : LocalePolicy.languages().entrySet())
      languageChoices.put(
          language.getKey().equals("system") ? L10n.text("기기 설정 따르기") : language.getValue(),
          language.getKey());
    p.choices("language", L10n.text("언어"), languageChoices);
    p.choices(
        "theme",
        L10n.text("설정 화면 테마"),
        choices(
            L10n.text("기기 설정 따르기"), "system", L10n.text("밝게"), "light", L10n.text("어둡게"), "dark"));
    p.choices(
        "orientation",
        L10n.text("화면 회전"),
        choices(
            L10n.text("자동"),
            "auto",
            L10n.text("가로 고정"),
            "landscape",
            L10n.text("세로 고정"),
            "portrait"));
    p.toggle("fullscreen", L10n.text("전체 화면"), L10n.text("Android 상태 표시줄과 탐색 막대를 숨깁니다."));
    p.toggle("awake", L10n.text("화면 켜짐 유지"), L10n.text("Open Deck이 열려 있는 동안 자동 꺼짐을 막습니다."));
    p.numericChoices(
        "brightness",
        L10n.text("앱 밝기"),
        choices(
            L10n.text("기기 설정 따르기"), -1, "10%", 10, "25%", 25, "50%", 50, "75%", 75, "100%", 100),
        -1,
        100,
        "%");
    p.slider("textScale", L10n.text("덱 글자 크기"), 80, 160, 1, "%");
    p.choices(
        "timeFormat",
        L10n.text("시계 표시"),
        choices(L10n.text("24시간"), "24h", L10n.text("12시간"), "12h"));
    p.choices(
        "iconResolution",
        L10n.text("아이콘 해상도"),
        choices(L10n.text("자동"), 0, "128 px", 128, "256 px", 256, "512 px", 512));
    p.choices(
        "renderMode",
        L10n.text("렌더링"),
        choices(L10n.text("표준 · 디자인 유지"), "standard", L10n.text("간단 · 그라데이션과 효과 줄임"), "simple"));
    p.show();
  }

  private void inputSettings() {
    ClientSettingsPanel p =
        panel(L10n.text("터치 · 페이지 이동"), L10n.text("버튼을 숨겨도 오른쪽 위 모서리 길게 누르기로 설정에 접근할 수 있습니다."))
            .onThemeChanged(this::inputSettings);
    p.toggle("haptics", L10n.text("터치 진동"), L10n.text("Android 터치 진동 설정을 따릅니다."));
    p.toggle("fixedVibration", L10n.text("고정 길이 진동"), L10n.text("짧은 진동이 잘 느껴지지 않는 기기에 사용합니다."));
    p.slider("vibrationMs", L10n.text("진동 길이"), 20, 200, 1, " ms");
    p.toggle("sound", L10n.text("터치 효과음"), L10n.text("버튼 실행 시 기기의 클릭 효과음을 냅니다."));
    p.toggle("swipeEnabled", L10n.text("좌우 제스처"), L10n.text("손가락으로 페이지를 이동합니다."));
    p.toggle("reducedMotion", L10n.text("동작 효과 줄이기"), L10n.text("페이지 전환과 버튼 누름 애니메이션을 줄입니다."));
    p.toggle("showHeader", L10n.text("상단 연결 정보"), L10n.text("앱 제목과 연결 상태를 표시합니다."));
    p.toggle("showNavigation", L10n.text("하단 페이지 버튼"), L10n.text("각 페이지로 이동하는 버튼을 표시합니다."));
    p.toggle(
        "settingsButtonHidden", L10n.text("설정 버튼 숨기기"), L10n.text("오른쪽 위 모서리를 1초간 누르면 설정을 엽니다."));
    p.show();
  }

  private void idleSettings() {
    ClientSettingsPanel p =
        panel(L10n.text("화면 보호"), L10n.text("설정한 시간 동안 사용하지 않으면 앱 밝기를 낮춥니다. 앱을 벗어나면 기기 밝기로 돌아갑니다."))
            .onThemeChanged(this::idleSettings);
    p.numericChoices(
        "screenSaverMinutes",
        L10n.text("사용하지 않을 때"),
        choices(
            L10n.text("끄기"),
            0,
            L10n.text("1분 후"),
            1,
            L10n.text("2분 후"),
            2,
            L10n.text("5분 후"),
            5,
            L10n.text("10분 후"),
            10,
            L10n.text("15분 후"),
            15,
            L10n.text("30분 후"),
            30,
            L10n.text("1시간 후"),
            60),
        0,
        120,
        L10n.text("분"));
    p.choices(
        "screenSaverMode",
        L10n.text("화면 보호 방식"),
        choices(L10n.text("덱 밝기 낮추기"), "dim", L10n.text("시계 화면"), "clock"));
    p.slider("dimPercent", L10n.text("화면 보호 밝기"), 5, 50, 1, "%");
    p.toggle(
        "firstTouchWakes",
        L10n.text("첫 터치는 화면만 깨우기"),
        L10n.text("화면을 깨울 때 버튼이 잘못 실행되지 않게 합니다. 시계 화면은 항상 적용됩니다."));
    p.action(L10n.text("지금 미리보기"), L10n.text("아무 곳이나 터치하면 돌아갑니다."), () -> setIdleDimmed(true));
    p.show();
  }

  private void startupSettings() {
    ClientSettingsPanel p =
        panel(L10n.text("프로필 · 시작 페이지"), L10n.text("프로필은 맥에서 만들고 이 태블릿에서 선택할 수 있습니다."))
            .onThemeChanged(this::startupSettings);
    p.choices("profileId", L10n.text("사용할 프로필"), this::currentProfileChoices);
    p.toggle("rememberPage", L10n.text("마지막 페이지 기억"), L10n.text("앱을 다시 열 때 마지막으로 사용한 페이지를 보여줍니다."));
    p.choices("startPageId", L10n.text("시작 페이지"), this::currentStartPageChoices);
    p.action(L10n.text("페이지 이동"), L10n.text("숨긴 하단 버튼 대신 여기서 이동할 수 있습니다."), this::choosePage);
    if (!connected) p.note(L10n.text("현재 연결이 끊겨 있어 프로필 변경은 다시 연결되면 적용됩니다."));
    p.show();
  }

  private Map<String, ?> currentProfileChoices() {
    Map<String, String> namesById = new LinkedHashMap<>();
    JSONArray profiles = navigationCatalog().optJSONArray("profiles");
    if (profiles != null)
      for (int i = 0; i < profiles.length(); i++) {
        JSONObject profile = profiles.optJSONObject(i);
        if (profile != null) namesById.put(profile.optString("id"), profile.optString("name"));
      }
    return ProfileNavigation.choices(L10n.text("맥 기본 프로필 따르기"), namesById);
  }

  private Map<String, ?> currentStartPageChoices() {
    JSONObject catalog = navigationCatalog();
    Map<String, String> namesById = new LinkedHashMap<>();
    String profile = settingString("profileId");
    if (profile.isEmpty()) profile = catalog.optString("defaultProfileId");
    List<String> allowed = profilePageCatalog().getOrDefault(profile, Collections.emptyList());
    JSONArray pages = catalog.optJSONArray("pages");
    if (pages != null)
      for (int i = 0; i < pages.length(); i++) {
        JSONObject page = pages.optJSONObject(i);
        if (page != null && allowed.contains(page.optString("id")))
          namesById.put(page.optString("id"), page.optString("name"));
      }
    return ProfileNavigation.choices(L10n.text("프로필 첫 페이지"), namesById);
  }

  private void choosePage() {
    JSONArray pages = config.optJSONArray("pages");
    if (pages == null) return;
    String[] names = new String[pages.length()];
    for (int i = 0; i < pages.length(); i++) names[i] = pages.optJSONObject(i).optString("name");
    new AlertDialog.Builder(L10n.context(this))
        .setTitle(L10n.text("페이지 이동"))
        .setItems(names, (d, index) -> navigate(pages.optJSONObject(index).optString("id")))
        .setNegativeButton(L10n.text("닫기"), null)
        .show();
  }

  private void deviceSettings() {
    ClientSettingsPanel p =
        panel(L10n.text("연결 · 기기 이름"), L10n.text("Wi-Fi는 최초 USB 등록 때 확인한 인증서로 암호화 연결합니다."))
            .onThemeChanged(this::deviceSettings);
    p.action(
        L10n.text("연결 방식 · 주소"),
        L10n.text("현재 ")
            + (transport.equals("wifi")
                ? L10n.text("Wi-Fi만 사용")
                : transport.equals("usb") ? L10n.text("USB만 사용") : L10n.text("자동 선택")),
        this::connectionSettings);
    p.toggle(
        "allowInsecureWifi",
        L10n.text("암호화하지 않는 Wi-Fi 허용"),
        L10n.text(
            "기본값은 꺼짐입니다. 이 옵션을 켜면 사설 LAN의 HTTP 주소에 연결할 수 있으며 페어링 토큰과 데이터가 암호화되지 않습니다. 신뢰하는 네트워크에서만"
                + " 사용하세요."));
    p.action(
        L10n.text("지금 다시 연결"), L10n.text("설정과 마지막 데이터는 그대로 유지합니다."), () -> reconnect(transport));
    p.action(
        L10n.text("기기 이름"),
        () -> deviceName,
        () -> {
          ClientSettingsPanel input = panel(L10n.text("기기 이름"), "");
          input.input(
              L10n.text("기기 이름"),
              deviceName,
              L10n.text("맥의 기기 목록에 표시할 이름입니다."),
              name -> {
                if (name.isEmpty() || name.length() > 80)
                  throw new IllegalArgumentException(L10n.text("1~80자로 입력하세요."));
                if (!connected)
                  throw new IllegalArgumentException(L10n.text("맥에 연결된 후 이름을 변경하세요."));
                long generation = pairingGeneration;
                String pairedToken = token;
                settingRequests.execute(
                    () -> {
                      if (generation != pairingGeneration) return;
                      try {
                        JSONObject response =
                            requestWithToken(
                                "/api/device/settings",
                                "PUT",
                                new JSONObject().put("name", name),
                                pairedToken);
                        ui.post(
                            () -> {
                              if (generation != pairingGeneration) return;
                              receiveDeviceSettings(response.optJSONObject("device"));
                            });
                      } catch (Exception e) {
                        ui.post(
                            () ->
                                Toast.makeText(
                                        this, L10n.text("기기 이름을 저장하지 못했습니다."), Toast.LENGTH_LONG)
                                    .show());
                      }
                    });
              });
        });
    p.action(
        L10n.text("페어링 해제"),
        L10n.text("이 맥의 저장된 인증을 제거하고 다시 등록합니다."),
        () ->
            new AlertDialog.Builder(L10n.context(this))
                .setTitle(L10n.text("페어링을 해제할까요?"))
                .setMessage(L10n.text("이 태블릿에서 맥 인증을 제거합니다. 맥의 덱과 버튼은 삭제되지 않습니다."))
                .setNegativeButton(L10n.text("취소"), null)
                .setPositiveButton(
                    L10n.text("해제"),
                    (d, which) -> {
                      token = "";
                      wifiPin = "";
                      wifiUrls = new ArrayList<>();
                      prefs.edit().remove("token").remove("wifiPin").remove("wifiUrls").apply();
                      resetDeviceIdentity();
                      disconnectEvents();
                      pairScreen();
                    })
                .show());
    p.show();
  }

  private void notificationSettings() {
    ClientSettingsPanel p =
        panel(L10n.text("알림"), L10n.text("이 태블릿에서 받을 알림을 선택합니다. 맥의 수집과 임계치 설정은 유지됩니다."))
            .onThemeChanged(this::notificationSettings);
    p.toggle("osNotifications", L10n.text("Jimin OS 알림"), L10n.text("일정 시작, 할 일 마감과 업무 요청"));
    p.toggle("monitorNotifications", L10n.text("시스템 · DB 경고"), L10n.text("Grafana 임계치 초과와 정상 복구"));
    p.toggle("notificationBanner", L10n.text("앱 안에서 경고 배너"), L10n.text("덱 위에 모니터 경고를 잠시 표시합니다."));
    p.action(
        L10n.text("Android 알림 권한"),
        L10n.text("기기 설정에서 알림과 소리를 관리합니다."),
        () ->
            startActivity(
                new Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, getPackageName())));
    p.show();
  }

  private void diagnosticSettings() {
    ClientSettingsPanel p =
        panel(
                L10n.text("정보 · 진단 · 초기화"),
                "Open Deck "
                    + appVersion()
                    + L10n.text(" · MIT · 무료\nAndroid ")
                    + Build.VERSION.RELEASE
                    + " · "
                    + Build.MODEL)
            .onThemeChanged(this::diagnosticSettings);
    p.action(
        L10n.text("연결 진단 보기"),
        pendingSettings.isEmpty() ? L10n.text("기기 설정 동기화 완료") : L10n.text("일부 설정은 연결 후 다시 저장합니다."),
        () ->
            new AlertDialog.Builder(L10n.context(this))
                .setTitle(L10n.text("연결 진단"))
                .setMessage(diagnostics())
                .setPositiveButton(L10n.text("닫기"), null)
                .setNeutralButton(
                    L10n.text("공유"),
                    (d, which) ->
                        startActivity(
                            Intent.createChooser(
                                new Intent(Intent.ACTION_SEND)
                                    .setType("text/plain")
                                    .putExtra(Intent.EXTRA_TEXT, diagnostics()),
                                L10n.text("진단 공유"))))
                .show());
    p.action(
        L10n.text("최신 버전 · 설치 파일"),
        L10n.text("GitHub Releases에서 업데이트를 확인합니다."),
        () ->
            startActivity(
                new Intent(
                    Intent.ACTION_VIEW,
                    android.net.Uri.parse(
                        "https://github.com/Yaklede/open-deck/releases/latest"))));
    p.action(
        L10n.text("설정 초기화"),
        L10n.text("화면·입력·알림 설정을 기본값으로 되돌립니다. 페어링과 프로필은 유지합니다."),
        () ->
            new AlertDialog.Builder(L10n.context(this))
                .setTitle(L10n.text("태블릿 설정을 초기화할까요?"))
                .setMessage(L10n.text("연결 인증, 현재 프로필과 맥의 덱은 유지됩니다."))
                .setNegativeButton(L10n.text("취소"), null)
                .setPositiveButton(
                    L10n.text("초기화"),
                    (d, which) -> {
                      Map<String, Object> defaults = ClientSettingsPolicy.defaults();
                      defaults.remove("profileId");
                      defaults.remove("startPageId");
                      for (Map.Entry<String, Object> item : defaults.entrySet())
                        settingsSync.queue(item.getKey(), item.getValue());
                      persistClientSettings();
                      wakeDisplay();
                      applyClientSettings();
                      flushDeviceSettings();
                    })
                .show());
    p.note(
        L10n.text(
            "진단에는 비밀번호·인증 토큰·할 일과 일정 내용이 포함되지 않습니다.\n소스와 라이선스: github.com/Yaklede/open-deck"));
    p.show();
  }

  private class DeckView extends ViewGroup {
    final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    final Path iconPath = new Path();
    final RectF arcBounds = new RectF();
    final SimpleDateFormat timeFormat = new SimpleDateFormat("HH:mm", L10n.locale());
    final Date screenSaverDate = new Date();
    final SimpleDateFormat dateFormat =
        new SimpleDateFormat(L10n.datePattern("M월 d일 EEEE"), L10n.locale());
    final ArrayList<Tile> tiles = new ArrayList<>();
    final Map<String, Tile> cachedTiles = new HashMap<>();
    final Map<String, JSONObject> activeWidgets = new HashMap<>();
    String cachedConfig = "";
    JSONObject drawingPage;
    final Map<String, PageBackdrop> backdrops = new HashMap<>();
    final Map<String, List<RectF>> emptyCells = new HashMap<>();
    String headerStatus = "";
    ArrayList<RectF> rects = new ArrayList<>();
    ArrayList<JSONObject> widgets = new ArrayList<>();
    ArrayList<RectF> pageRects = new ArrayList<>();
    float scroll = 0, maxScroll = 0, downX, downY, lastY, dragVolume = -1;
    long downAt;
    int downIndex = -1;
    boolean moved = false;
    int touchAxis = 0;

    DeckView() {
      super(MainActivity.this);
      setWillNotDraw(false);
      setClipChildren(true);
      setBackgroundColor(color("#0c1320"));
      setContentDescription(L10n.text("Open Deck 태블릿 컨트롤 패널 · 길게 눌러 설정"));
      setOnLongClickListener(
          view -> {
            settings();
            return true;
          });
    }

    void label(Canvas c, String value, float x, float y, float size, int col, Paint.Align align) {
      paint.setColor(col);
      paint.setStyle(Paint.Style.FILL);
      paint.setTypeface(font);
      paint.setTextLocale(L10n.locale());
      paint.setTextSize(dp(size) * settingInt("textScale") / 100f);
      paint.setTextAlign(align);
      c.drawText(value, x, y, paint);
    }

    void line(Canvas c, float x1, float y1, float x2, float y2, int col, float width) {
      paint.setColor(col);
      paint.setStrokeWidth(dp(width));
      paint.setStrokeCap(Paint.Cap.ROUND);
      c.drawLine(x1, y1, x2, y2, paint);
    }

    void arc(Canvas c, RectF r, float value, int col) {
      paint.setStyle(Paint.Style.STROKE);
      paint.setStrokeWidth(dp(7));
      paint.setStrokeCap(Paint.Cap.ROUND);
      paint.setColor(color("#29334a"));
      c.drawArc(r, 135, 270, false, paint);
      paint.setColor(col);
      c.drawArc(r, 135, 270 * Math.max(0, Math.min(1, value)), false, paint);
      paint.setStyle(Paint.Style.FILL);
    }

    String themeValue(String key) {
      return themeValue(key, drawingPage == null ? activePage() : drawingPage);
    }

    String themeValue(String key, JSONObject page) {
      String theme = page.optString("theme", "midnight");
      if (theme.equals("paper"))
        return key.equals("background")
            ? "#e9edf2"
            : key.equals("surface") ? "#ffffff" : key.equals("text") ? "#233348" : "#4b6dba";
      if (theme.equals("ocean"))
        return key.equals("background")
            ? "#091c28"
            : key.equals("surface") ? "#123344" : key.equals("text") ? "#d9f4fa" : "#68c8d8";
      if (theme.equals("graphite"))
        return key.equals("background")
            ? "#141517"
            : key.equals("surface") ? "#232528" : key.equals("text") ? "#eef0f2" : "#b8c6da";
      return key.equals("background")
          ? "#0c1320"
          : key.equals("surface") ? "#172436" : key.equals("text") ? "#e0e9fa" : "#a6acff";
    }

    private class PagePreview {
      final JSONObject page;
      final List<Tile> tiles = new ArrayList<>();
      final List<JSONObject> widgets = new ArrayList<>();
      final List<RectF> rects = new ArrayList<>();

      PagePreview(JSONObject page) {
        this.page = page;
      }
    }

    PagePreview swipePreview;
    int swipeDirection;
    float swipeOffset, dragStartOffset;
    boolean swiping, gestureBlocked;
    VelocityTracker swipeVelocity;
    android.animation.ValueAnimator swipeSettle;

    void clearVelocity() {
      if (swipeVelocity != null) {
        swipeVelocity.recycle();
        swipeVelocity = null;
      }
    }

    JSONObject adjacentPage(int direction) {
      JSONArray pages = config.optJSONArray("pages");
      if (pages == null) return null;
      for (int i = 0; i < pages.length(); i++)
        if (pages.optJSONObject(i).optString("id").equals(pageId)) {
          int index = i + direction;
          return index >= 0 && index < pages.length() ? pages.optJSONObject(index) : null;
        }
      return null;
    }

    void hidePreview() {
      if (swipePreview == null) return;
      for (Tile tile : swipePreview.tiles) {
        tile.setTranslationX(0);
        tile.setVisibility(View.GONE);
      }
      PageBackdrop background = backdrops.get(swipePreview.page.optString("id"));
      if (background != null) {
        background.setTranslationX(0);
        background.setVisibility(View.GONE);
      }
      swipePreview = null;
    }

    void preparePreview(int direction) {
      hidePreview();
      swipeDirection = direction;
      JSONObject page = adjacentPage(direction);
      if (page == null) return;
      PagePreview preview = new PagePreview(page);
      JSONArray items = page.optJSONArray("widgets");
      if (items != null)
        for (int i = 0; i < items.length(); i++) {
          JSONObject w = items.optJSONObject(i);
          if (w == null) continue;
          Tile tile = cachedTiles.get(w.optString("id"));
          if (tile == null) {
            tile = new Tile(w, page);
            cachedTiles.put(w.optString("id"), tile);
            addView(tile);
          }
          tile.animate().cancel();
          tile.setScaleX(1);
          tile.setScaleY(1);
          tile.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
          tile.invalidate();
          preview.tiles.add(tile);
          preview.widgets.add(w);
          preview.rects.add(new RectF());
        }
      measurePage(page, preview.tiles, preview.widgets, preview.rects, 0, getWidth(), getHeight());
      placePage(preview.tiles, preview.rects, getHeight());
      PageBackdrop background = backdrop(page);
      background.measure(
          MeasureSpec.makeMeasureSpec(getWidth(), MeasureSpec.EXACTLY),
          MeasureSpec.makeMeasureSpec(getHeight(), MeasureSpec.EXACTLY));
      background.layout(0, 0, getWidth(), getHeight());
      background.setVisibility(View.VISIBLE);
      swipePreview = preview;
      updateState();
    }

    void applySwipe(float offset) {
      swipeOffset = offset;
      for (Tile tile : tiles) tile.setTranslationX(offset);
      PageBackdrop current = backdrops.get(pageId);
      if (current != null) current.setTranslationX(offset);
      if (swipePreview != null) {
        float adjacent = offset + swipeDirection * getWidth();
        for (Tile tile : swipePreview.tiles) tile.setTranslationX(adjacent);
        backdrop(swipePreview.page).setTranslationX(adjacent);
      }
    }

    void dragPage(float distance) {
      int direction = distance < 0 ? 1 : -1;
      if (!swiping) {
        finishPageTransition();
        swiping = true;
        swipeDirection = 0;
        // A horizontal drag cannot later release a pending double-tap action.
        if (singleTap != null) ui.removeCallbacks(singleTap);
        lastButtonId = "";
      }
      if (direction != swipeDirection) preparePreview(direction);
      applySwipe(SwipePhysics.offset(distance, getWidth(), swipePreview != null));
    }

    void cancelSwipeImmediately() {
      if (swipeSettle != null) {
        android.animation.ValueAnimator animator = swipeSettle;
        swipeSettle = null;
        animator.removeAllListeners();
        animator.cancel();
      }
      if (!swiping && swipePreview == null) return;
      applySwipe(0);
      hidePreview();
      swiping = false;
      swipeDirection = 0;
      swipeOffset = 0;
    }

    void settleSwipe(boolean allowCommit, float velocity) {
      if (!swiping) return;
      boolean commit =
          allowCommit
              && SwipePhysics.commit(
                  swipeOffset, velocity, getWidth(), dp(24), dp(650), swipePreview != null);
      float target = commit ? -swipeDirection * getWidth() : 0;
      Runnable finish =
          () -> {
            String destination =
                commit && swipePreview != null ? swipePreview.page.optString("id") : null;
            applySwipe(0);
            hidePreview();
            swiping = false;
            swipeOffset = 0;
            swipeDirection = 0;
            swipeSettle = null;
            if (destination != null) {
              pageId = destination;
              prefs.edit().putString("page", destination).apply();
              scroll = 0;
              rebuild();
              updateState();
              touchFeedback(HapticFeedbackConstants.CLOCK_TICK);
            }
          };
      if (reducedMotion()
          || !android.animation.ValueAnimator.areAnimatorsEnabled()
          || Math.abs(target - swipeOffset) < 1) {
        finish.run();
        return;
      }
      swipeSettle = android.animation.ValueAnimator.ofFloat(swipeOffset, target);
      swipeSettle.setDuration(SwipePhysics.duration(swipeOffset, target, velocity, getWidth()));
      swipeSettle.setInterpolator(new android.view.animation.DecelerateInterpolator(1.5f));
      swipeSettle.addUpdateListener(animator -> applySwipe((float) animator.getAnimatedValue()));
      swipeSettle.addListener(
          new android.animation.AnimatorListenerAdapter() {
            @Override
            public void onAnimationEnd(android.animation.Animator animator) {
              finish.run();
            }
          });
      swipeSettle.start();
    }

    final List<Tile> outgoingPage = new ArrayList<>();
    long transitionUntil;

    void finishPageTransition() {
      cancelSwipeImmediately();
      for (Tile tile : new ArrayList<>(outgoingPage)) {
        tile.animate().cancel();
        tile.setTranslationX(0);
        if (!tiles.contains(tile)) tile.setVisibility(View.GONE);
      }
      outgoingPage.clear();
      for (Tile tile : tiles) {
        tile.animate().cancel();
        tile.setTranslationX(0);
        tile.setScaleX(1);
        tile.setScaleY(1);
      }
      transitionUntil = 0;
    }

    void animatePage(List<Tile> previous, int direction) {
      if (getWidth() == 0
          || reducedMotion()
          || !android.animation.ValueAnimator.areAnimatorsEnabled()) return;
      transitionUntil = SystemClock.elapsedRealtime() + 240;
      float distance = direction * getWidth();
      android.view.animation.Interpolator easing =
          new android.view.animation.DecelerateInterpolator(1.35f);
      for (Tile tile : previous) {
        // Existing cached native views slide together; no full-screen bitmap or re-render loop.
        if (tile.getParent() != this || tiles.contains(tile)) continue;
        outgoingPage.add(tile);
        tile.setVisibility(View.VISIBLE);
        tile.setTranslationX(0);
        tile.animate()
            .translationX(-distance)
            .setDuration(240)
            .setInterpolator(easing)
            .withEndAction(
                () -> {
                  if (!tiles.contains(tile)) tile.setVisibility(View.GONE);
                  tile.setTranslationX(0);
                  outgoingPage.remove(tile);
                })
            .start();
      }
      for (Tile tile : tiles) {
        tile.setTranslationX(distance);
        tile.animate().translationX(0).setDuration(240).setInterpolator(easing).start();
      }
    }

    void rebuild() {
      timeFormat.applyPattern(settingString("timeFormat").equals("12h") ? "h:mm a" : "HH:mm");
      boolean interrupted = swiping || swipeSettle != null;
      finishPageTransition();
      if (interrupted) gestureBlocked = true;
      String nextConfig = config.toString();
      int count =
          activePage().optJSONArray("widgets") == null
              ? 0
              : activePage().optJSONArray("widgets").length();
      if (!nextConfig.equals(cachedConfig) || cachedTiles.size() + count > 256) {
        removeAllViews();
        cachedTiles.clear();
        activeWidgets.clear();
        backdrops.clear();
        emptyCells.clear();
        cachedConfig = nextConfig;
      }
      for (Tile tile : cachedTiles.values()) tile.setVisibility(View.GONE);
      for (PageBackdrop backdrop : backdrops.values()) backdrop.setVisibility(View.GONE);
      tiles.clear();
      widgets.clear();
      rects.clear();
      pageRects.clear();
      JSONArray pages = config.optJSONArray("pages");
      if (pages != null && pages.length() > 0) {
        JSONObject page = pages.optJSONObject(0);
        for (int i = 0; i < pages.length(); i++)
          if (pages.optJSONObject(i).optString("id").equals(pageId)) page = pages.optJSONObject(i);
        pageId = page.optString("id");
        backdrop(page).setVisibility(View.VISIBLE);
        JSONArray items = page.optJSONArray("widgets");
        if (items != null)
          for (int i = 0; i < items.length(); i++) {
            JSONObject w = items.optJSONObject(i);
            if (w == null) continue;
            widgets.add(w);
            rects.add(new RectF());
            String id = w.optString("id");
            Tile tile = cachedTiles.get(id);
            if (tile == null) {
              tile = new Tile(w, page);
              cachedTiles.put(id, tile);
              addView(tile);
            }
            tile.setElevation(
                page.optBoolean("shadow", true)
                        && !settingString("renderMode").equals("simple")
                        && !tile.type.equals("spacer")
                    ? dp(3)
                    : 0);
            tile.setVisibility(View.VISIBLE);
            tile.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_YES);
            tiles.add(tile);
          }
      }
      setBackgroundColor(color(activePage().optString("background", themeValue("background"))));
      requestLayout();
      invalidate();
    }

    float measurePage(
        JSONObject p,
        List<Tile> tiles,
        List<JSONObject> widgets,
        List<RectF> rects,
        float scroll,
        int width,
        int height) {
      boolean portrait = width < height;
      JSONObject portraitConfig = p.optJSONObject("portrait");
      int cols =
          portrait
              ? (portraitConfig == null
                  ? Math.min(2, p.optInt("columns", 4))
                  : portraitConfig.optInt("columns", 2))
              : p.optInt("columns", config.optInt("columns", 4));
      cols = Math.max(2, Math.min(12, cols));
      int rows = Math.max(1, p.optInt("rows", (tiles.size() + cols - 1) / cols));
      int[][] boxes = new int[tiles.size()][4];
      boolean[][] occupied = new boolean[1024][12];
      int extent = 1;
      for (int i = 0; i < tiles.size(); i++) {
        JSONObject w = widgets.get(i);
        int cw = Math.min(cols, Math.max(1, w.optInt("w", 1))), ch = Math.max(1, w.optInt("h", 1));
        int x = w.optInt("x", i % cols), y = w.optInt("y", i / cols);
        if (portrait) {
          x = 0;
          y = 0;
          boolean found = false;
          for (int yy = 0; yy < 1000 && !found; yy++)
            for (int xx = 0; xx <= cols - cw; xx++) {
              boolean free = true;
              for (int gy = yy; gy < yy + ch; gy++)
                for (int gx = xx; gx < xx + cw; gx++) if (occupied[gy][gx]) free = false;
              if (free) {
                x = xx;
                y = yy;
                found = true;
                break;
              }
            }
        }
        for (int gy = y; gy < Math.min(1024, y + ch); gy++)
          for (int gx = x; gx < Math.min(cols, x + cw); gx++) occupied[gy][gx] = true;
        boxes[i] = new int[] {x, y, cw, ch};
        extent = Math.max(extent, y + ch);
      }
      if (portrait)
        rows = Math.max(extent, portraitConfig == null ? 1 : portraitConfig.optInt("rows", 1));
      else rows = Math.max(rows, extent);
      float margin = dp(18),
          gap = dp(p.optInt("gap", 12)),
          available = height - contentTop() - contentBottom() - dp(18);
      float cellW = (width - margin * 2 - gap * (cols - 1)) / cols;
      float cellH = Math.max(dp(48), (available - gap * (rows - 1)) / rows);
      float maxScroll = Math.max(0, rows * (cellH + gap) - gap - available);
      scroll = Math.min(scroll, maxScroll);
      for (int i = 0; i < tiles.size(); i++) {
        int[] box = boxes[i];
        float left = margin + box[0] * (cellW + gap),
            top = contentTop() + box[1] * (cellH + gap) - scroll;
        int tw = Math.round(box[2] * cellW + (box[2] - 1) * gap),
            th = Math.round(box[3] * cellH + (box[3] - 1) * gap);
        rects.get(i).set(left, top, left + tw, top + th);
        tiles
            .get(i)
            .measure(
                MeasureSpec.makeMeasureSpec(tw, MeasureSpec.EXACTLY),
                MeasureSpec.makeMeasureSpec(th, MeasureSpec.EXACTLY));
      }
      List<RectF> empty = new ArrayList<>();
      if (p.optBoolean("showEmptyCells", false))
        for (int yy = 0; yy < Math.min(rows, 1024); yy++)
          for (int xx = 0; xx < cols; xx++)
            if (!occupied[yy][xx]) {
              float left = margin + xx * (cellW + gap),
                  top = contentTop() + yy * (cellH + gap) - scroll;
              empty.add(new RectF(left, top, left + cellW, top + cellH));
            }
      emptyCells.put(p.optString("id"), empty);
      return maxScroll;
    }

    @Override
    protected void onSizeChanged(int width, int height, int oldWidth, int oldHeight) {
      super.onSizeChanged(width, height, oldWidth, oldHeight);
      if (oldWidth > 0 && (width != oldWidth || height != oldHeight)) {
        finishPageTransition();
        clearVelocity();
        gestureBlocked = true;
        dragVolume = -1;
      }
    }

    @Override
    protected void onMeasure(int widthSpec, int heightSpec) {
      int width = MeasureSpec.getSize(widthSpec), height = MeasureSpec.getSize(heightSpec);
      setMeasuredDimension(width, height);
      maxScroll = measurePage(activePage(), tiles, widgets, rects, scroll, width, height);
      scroll = Math.min(scroll, maxScroll);
      if (swipePreview != null)
        measurePage(
            swipePreview.page,
            swipePreview.tiles,
            swipePreview.widgets,
            swipePreview.rects,
            0,
            width,
            height);
      for (PageBackdrop backdrop : backdrops.values())
        if (backdrop.getVisibility() == View.VISIBLE) backdrop.measure(widthSpec, heightSpec);
      pageRects.clear();
      JSONArray pages = config.optJSONArray("pages");
      int n = pages == null ? 0 : pages.length();
      if (n > 6) n = 1;
      if (!settingBool("showNavigation")) n = 0;
      float pageWidth = Math.min(dp(140), width / (float) Math.max(1, n)),
          start = (width - n * pageWidth) / 2;
      for (int i = 0; i < n; i++)
        pageRects.add(
            new RectF(start + i * pageWidth, height - dp(46), start + (i + 1) * pageWidth, height));
    }

    @Override
    protected void onLayout(boolean changed, int l, int t, int r, int b) {
      placePage(tiles, rects, b - t);
      if (swipePreview != null) placePage(swipePreview.tiles, swipePreview.rects, b - t);
      for (PageBackdrop backdrop : backdrops.values())
        if (backdrop.getVisibility() == View.VISIBLE) backdrop.layout(0, 0, r - l, b - t);
    }

    void placePage(List<Tile> pageTiles, List<RectF> pageBounds, int height) {
      for (int i = 0; i < pageTiles.size(); i++) {
        RectF rect = pageBounds.get(i);
        Tile tile = pageTiles.get(i);
        tile.setVisibility(
            rect.bottom > contentTop() && rect.top < height - contentBottom()
                ? View.VISIBLE
                : View.INVISIBLE);
        tile.layout(
            Math.round(rect.left),
            Math.round(rect.top),
            Math.round(rect.right),
            Math.round(rect.bottom));
      }
    }

    @Override
    protected void dispatchDraw(Canvas c) {
      c.save();
      c.clipRect(0, contentTop(), getWidth(), getHeight() - contentBottom());
      super.dispatchDraw(c);
      c.restore();
      if (!settingBool("showHeader") && !settingBool("settingsButtonHidden"))
        label(c, "⚙", getWidth() - dp(18), dp(40), 24, color("#879dbd"), Paint.Align.RIGHT);
      if (idleDimmed && settingString("screenSaverMode").equals("clock")) {
        c.drawColor(Color.rgb(7, 12, 19));
        screenSaverDate.setTime(hostNow());
        label(
            c,
            timeFormat.format(screenSaverDate),
            getWidth() / 2f,
            getHeight() / 2f,
            66,
            Color.rgb(187, 201, 219),
            Paint.Align.CENTER);
        label(
            c,
            L10n.text("화면을 터치하면 돌아갑니다"),
            getWidth() / 2f,
            getHeight() / 2f + dp(45),
            14,
            Color.rgb(113, 132, 154),
            Paint.Align.CENTER);
      }
    }

    @Override
    public boolean onInterceptTouchEvent(MotionEvent e) {
      return true;
    }

    void refresh(String id) {
      Tile tile = cachedTiles.get(id);
      if (tile != null && tile.getVisibility() != View.GONE) tile.invalidate();
    }

    void updateState() {
      String status =
          connected
              + base
              + String.valueOf(osProvider() == null ? null : osProvider().optString("status"))
              + ":"
              + hostNow() / 5000;
      if (!status.equals(headerStatus)) {
        headerStatus = status;
        invalidate();
      }
      String osSignature =
          String.valueOf(osProvider()) + String.valueOf(state.optJSONArray("notifications"));
      String systemSignature = String.valueOf(state.optJSONObject("system"));
      String grafanaSignature =
          String.valueOf(state.optJSONObject("grafana"))
              + ":"
              + streamFresh()
              + ":"
              + hostNow() / 5000;
      for (Tile tile : cachedTiles.values()) {
        if (tile.getVisibility() != View.VISIBLE) continue;
        String next;
        if (tile.type.equals("system")) next = systemSignature;
        else if (tile.type.equals("grafana"))
          next = grafanaSignature + grafanaProject(tile.widget).optString("value");
        else if (tile.type.equals("gauges"))
          next = state.optInt("cpu") + ":" + state.optInt("memory");
        else if (tile.type.equals("volume"))
          next = state.optInt("volume") + ":" + state.optBoolean("muted");
        else if (tile.type.equals("timer")) next = String.valueOf(state.optJSONObject("timers"));
        else if (tile.type.equals("graph")) next = String.valueOf(state.optJSONObject("history"));
        else if (tile.type.equals("todo")) next = String.valueOf(state.optJSONObject("todos"));
        else if (tile.widget.optString("provider").equals("jimin-os")) next = osSignature;
        else next = "static";
        if (tile.widget.has("stateVariable")) next += ":active=" + widgetActive(tile.widget);
        if (tile.widget.has("binding")
            || tile.widget.optString("label").contains("{{")
            || tile.widget.optString("activeLabel").contains("{{"))
          next += String.valueOf(state.optJSONObject("variables"));
        if (!next.equals(tile.signature)) {
          tile.signature = next;
          tile.setContentDescription(template(effectiveWidget(tile.widget).optString("label")));
          if (tile.type.equals("grafana")) {
            JSONObject data = grafanaData(tile.widget),
                cpu =
                    data == null
                        ? null
                        : data.optJSONObject(
                            tile.widget.optString("metric").equals("system") ? "system" : "cpu"),
                tps = data == null ? null : data.optJSONObject("tps");
            boolean server = tile.widget.optString("metric").equals("system");
            double rate = metric(tps, "value");
            tile.setContentDescription(
                !queryFresh(data)
                    ? tile.widget.optString("label", "Grafana")
                        + ", "
                        + freshnessNotice(tile.widget, data)
                        + L10n.text(", 마지막 ")
                        + sourceStamp(data, server ? "system" : "cpu")
                    : tile.widget.optString("label", "Grafana")
                        + " · "
                        + grafanaProject(tile.widget).optString("label")
                        + (server ? ", CPU " : ", DB CPU ")
                        + metricPercent(metric(cpu, "value"))
                        + (server
                            ? ""
                            : ", MEM "
                                + grafanaNumber(data, "memory", true)
                                + " · "
                                + metricGiB(
                                    metric(
                                        data == null ? null : data.optJSONObject("memory"),
                                        "usedBytes"))
                                + ", TPS "
                                + grafanaNumber(data, "tps", false)
                                + ", QPS "
                                + grafanaNumber(data, "qps", false))
                        + (server ? "" : grafanaNodeDescription(data))
                        + ", "
                        + sourceStamp(data, server ? "system" : "cpu")
                        + ", "
                        + (freshnessNotice(tile.widget, data) == null
                            ? L10n.text("정상 수집")
                            : freshnessNotice(tile.widget, data))
                        + L10n.text(", 길게 눌러 프로젝트 변경"));
          }
          if (tile.widget.optString("provider").equals("jimin-os"))
            tile.setContentDescription(tile.widget.optString("label") + ", " + osSyncNotice());
          if (tile.getVisibility() == View.VISIBLE) tile.invalidate();
        }
        float alpha =
            (connected ? 1f : .55f)
                * (effectiveWidget(tile.widget).optJSONObject("style") == null
                    ? 1f
                    : effectiveWidget(tile.widget).optJSONObject("style").optInt("opacity", 100)
                        / 100f);
        if (tile.getAlpha() != alpha) tile.setAlpha(alpha);
      }
    }

    long osHeaderBucket = -1;

    void tick() {
      if (pageId.equals("jimin-os-page") && hostNow() / 5000 != osHeaderBucket) {
        osHeaderBucket = hostNow() / 5000;
        invalidate();
      }
      for (Tile tile : cachedTiles.values()) {
        if (tile.getVisibility() != View.VISIBLE) continue;
        if ((tile.type.equals("grafana")
                || tile.type.equals("system")
                || tile.widget.optString("provider").equals("jimin-os"))
            && tile.freshnessBucket != hostNow() / 5000) {
          tile.freshnessBucket = hostNow() / 5000;
          tile.invalidate();
        }
        if (tile.type.equals("clock") && hostNow() / 60000 != tile.clockMinute) tile.invalidate();
        if (tile.type.equals("timer")) {
          JSONObject all = state.optJSONObject("timers"),
              timer = all == null ? null : all.optJSONObject(tile.id);
          if (timer != null && timer.optBoolean("running")) tile.invalidate();
        }
      }
    }

    private class Tile extends View {
      final JSONObject widget, ownerPage;
      final String id, type;
      final RectF bounds = new RectF();
      String signature = "";
      long clockMinute = -1, freshnessBucket = -1;

      Tile(JSONObject w, JSONObject page) {
        super(MainActivity.this);
        widget = w;
        ownerPage = page;
        id = w.optString("id");
        type = w.optString("type");
        setContentDescription(w.optString("label"));
        setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_YES);
        setFocusable(true);
        setOutlineProvider(
            new ViewOutlineProvider() {
              @Override
              public void getOutline(View view, android.graphics.Outline outline) {
                outline.setRoundRect(
                    0, 0, view.getWidth(), view.getHeight(), dp(ownerPage.optInt("radius", 13)));
              }
            });
        setElevation(
            page.optBoolean("shadow", true)
                    && !settingString("renderMode").equals("simple")
                    && !type.equals("spacer")
                ? dp(3)
                : 0);
        if (type.equals("grafana"))
          setOnLongClickListener(
              v -> {
                grafanaChoose(w);
                return true;
              });
        if (type.equals("button")
            || type.equals("system")
            || type.equals("grafana")
            || type.equals("timer")
            || type.equals("page")
            || type.equals("todo")
            || type.equals("toggle")
            || type.equals("agenda")
            || type.equals("inbox")
            || type.equals("notification-feed")
            || (type.equals("calendar") && w.optString("provider").equals("jimin-os")))
          setOnClickListener(
              v -> {
                try {
                  if (type.equals("system")) {
                    systemDetails(w);
                    return;
                  }
                  if (type.equals("grafana")) {
                    grafanaDetails(w);
                    return;
                  }
                  if (type.equals("agenda")
                      || type.equals("inbox")
                      || type.equals("notification-feed")
                      || (type.equals("calendar") && w.optString("provider").equals("jimin-os"))) {
                    osList(w, null);
                    return;
                  }
                  if (type.equals("button")) {
                    dispatchButton(w, "tap");
                    return;
                  }
                  JSONObject b = new JSONObject().put("id", id);
                  if (type.equals("page")) {
                    navigate(w.optString("targetPage"));
                    return;
                  }
                  if (type.equals("todo")) {
                    todoDialog(w);
                    return;
                  }
                  if (type.equals("timer")) b.put("kind", "timer").put("gesture", "tap");
                  if (type.equals("toggle"))
                    b.put("kind", "control")
                        .put("value", !Boolean.TRUE.equals(variable(w.optString("binding"))));
                  action(b);
                } catch (JSONException ignored) {
                }
              });
      }

      @Override
      public CharSequence getAccessibilityClassName() {
        return type.equals("button") ? "android.widget.Button" : "android.view.View";
      }

      @Override
      protected void onSizeChanged(int w, int h, int oldW, int oldH) {
        bounds.set(0, 0, w, h);
        invalidateOutline();
      }

      @Override
      protected void onDraw(Canvas c) {
        drawingPage = ownerPage;
        try {
          drawWidget(c, widget, bounds);
        } finally {
          drawingPage = null;
        }
        clockMinute = hostNow() / 60000;
      }
    }

    @Override
    protected void onDraw(Canvas c) {
      super.onDraw(c);
      drawPageBackground(c, activePage());
      if (settingBool("showHeader")) {
        label(
            c,
            "◈  OPEN DECK" + (pageId.equals("jimin-os-page") ? "  /  Jimin OS" : ""),
            dp(18),
            dp(28),
            12,
            color(themeValue("text")),
            Paint.Align.LEFT);
        label(
            c,
            streamFresh()
                ? (base.startsWith("https:")
                        ? L10n.text("Wi-Fi · 암호화 연결됨")
                        : base.startsWith("http://127.0.0.1:")
                            ? L10n.text("USB · 연결됨")
                            : L10n.text("Wi-Fi · 암호화 안 됨"))
                    + (pageId.equals("jimin-os-page") ? "  · " + osSyncNotice() : "")
                : L10n.text("맥에 다시 연결하는 중…")
                    + (pageId.equals("jimin-os-page") && osData() != null
                        ? " · " + osSyncNotice()
                        : ""),
            dp(18),
            dp(49),
            10,
            color(
                !streamFresh()
                    ? "#ff7d8b"
                    : pageId.equals("jimin-os-page") && !osFresh() ? "#efbd73" : "#70c9a8"),
            Paint.Align.LEFT);
      }
      if (!settingBool("settingsButtonHidden"))
        label(c, "⚙", getWidth() - dp(18), dp(40), 24, color("#879dbd"), Paint.Align.RIGHT);
      if (tiles.isEmpty())
        label(
            c,
            L10n.text("맥에서 Open Deck을 실행하고 연결을 확인하세요."),
            getWidth() / 2f,
            getHeight() / 2f,
            16,
            color("#9bacc6"),
            Paint.Align.CENTER);
      JSONArray pages = config.optJSONArray("pages");
      if (pages != null)
        for (int i = 0; i < pageRects.size(); i++) {
          JSONObject p = pages.length() > 6 ? activePage() : pages.optJSONObject(i);
          RectF r = pageRects.get(i);
          label(
              c,
              p.optString("name") + (pages.length() > 6 ? " ▾" : ""),
              r.centerX(),
              getHeight() - dp(17),
              11,
              color(p.optString("id").equals(pageId) ? "#b5c4ff" : "#536c91"),
              Paint.Align.CENTER);
        }
    }

    void drawPageBackground(Canvas c, JSONObject themedPage) {
      c.drawColor(color(themedPage.optString("background", themeValue("background", themedPage))));
      if (themedPage.has("gradient") && !settingString("renderMode").equals("simple")) {
        paint.setShader(
            new LinearGradient(
                0,
                0,
                getWidth(),
                getHeight(),
                color(themedPage.optString("background", themeValue("background", themedPage))),
                color(themedPage.optString("gradient")),
                Shader.TileMode.CLAMP));
        c.drawRect(0, 0, getWidth(), getHeight(), paint);
        paint.setShader(null);
      }
      Bitmap background = bitmap(themedPage.optString("backgroundImage"), 2560);
      if (background != null) {
        paint.setColor(Color.WHITE);
        paint.setFilterBitmap(true);
        float scale =
            Math.max(
                getWidth() / (float) background.getWidth(),
                getHeight() / (float) background.getHeight());
        float bw = background.getWidth() * scale, bh = background.getHeight() * scale;
        c.drawBitmap(
            background,
            null,
            new RectF(
                (getWidth() - bw) / 2,
                (getHeight() - bh) / 2,
                (getWidth() + bw) / 2,
                (getHeight() + bh) / 2),
            paint);
      }
      List<RectF> empty = emptyCells.get(themedPage.optString("id"));
      if (themedPage.optBoolean("showEmptyCells", false) && empty != null) {
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(dp(1));
        paint.setColor(color(themeValue("text", themedPage)));
        paint.setAlpha(38);
        for (RectF rect : empty)
          c.drawRoundRect(
              rect,
              dp(themedPage.optInt("radius", 13)),
              dp(themedPage.optInt("radius", 13)),
              paint);
        paint.setAlpha(255);
        paint.setStyle(Paint.Style.FILL);
      }
    }

    private class PageBackdrop extends View {
      final JSONObject page;

      PageBackdrop(JSONObject page) {
        super(MainActivity.this);
        this.page = page;
        setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
      }

      @Override
      protected void onDraw(Canvas c) {
        drawPageBackground(c, page);
      }
    }

    PageBackdrop backdrop(JSONObject page) {
      String id = page.optString("id");
      PageBackdrop view = backdrops.get(id);
      if (view == null) {
        view = new PageBackdrop(page);
        backdrops.put(id, view);
        addView(view, 0);
      }
      return view;
    }

    void systemLabel(Canvas c, String text, RectF r, float y, float size, int col) {
      label(
          c,
          ellipsize(text, r.width() - dp(32), size),
          r.left + dp(16),
          y,
          size,
          col,
          Paint.Align.LEFT);
    }

    void systemSpark(Canvas c, JSONArray rows, RectF r, int col, boolean percent) {
      if (rows == null || rows.length() < 2 || r.height() < dp(8)) return;
      double max = percent ? 100 : 1;
      int start = Math.max(0, rows.length() - 60);
      if (!percent)
        for (int i = start; i < rows.length(); i++)
          if (!rows.isNull(i)) max = Math.max(max, rows.optDouble(i));
      iconPath.rewind();
      boolean pathStarted = false;
      for (int i = start; i < rows.length(); i++) {
        if (rows.isNull(i)) {
          pathStarted = false;
          continue;
        }
        float x = r.left + (r.width() * (i - start) / Math.max(1, rows.length() - start - 1));
        float y =
            r.bottom - (float) (Math.max(0, Math.min(1, rows.optDouble(i) / max)) * r.height());
        if (pathStarted) iconPath.lineTo(x, y);
        else {
          iconPath.moveTo(x, y);
          pathStarted = true;
        }
      }
      paint.setColor(col);
      paint.setStrokeWidth(dp(2));
      paint.setStyle(Paint.Style.STROKE);
      c.drawPath(iconPath, paint);
      paint.setStyle(Paint.Style.FILL);
    }

    void drawSystem(Canvas c, JSONObject widget, RectF r) {
      int accent = color(widget.optString("color", "#83cbb9")),
          text = color(themeValue("text")),
          muted = color("#9bafbd");
      float top = r.top;
      if (widget.optBoolean("compact")) {
        drawMacSummary(c, widget, r);
        return;
      }
      String kind = widget.optString("metric", "overview");
      systemLabel(
          c,
          template(widget.optString("label", L10n.text("맥 상태"))),
          r,
          top + dp(27),
          widget.optJSONObject("style") == null
              ? 18
              : widget.optJSONObject("style").optInt("textSize", 18),
          accent);
      JSONObject data = macSystem();
      if (data == null) {
        systemLabel(c, L10n.text("실시간 상태 대기"), r, top + dp(72), 20, text);
        systemLabel(c, L10n.text("맥 연결과 최신 앱을 확인해 주세요"), r, top + dp(100), 11, muted);
        return;
      }
      JSONObject cpu = data.optJSONObject("cpu"),
          mem = data.optJSONObject("memory"),
          disk = data.optJSONObject("disk"),
          power = data.optJSONObject("power"),
          net = data.optJSONObject("network"),
          history = data.optJSONObject("history"),
          io = data.optJSONObject("io");
      RectF chart =
          new RectF(
              r.left + dp(16),
              Math.max(top + dp(110), r.bottom - dp(52)),
              r.right - dp(16),
              r.bottom - dp(16));
      if (kind.equals("cpu")) {
        systemLabel(c, metricPercent(metric(cpu, "percent")), r, top + dp(67), 25, text);
        systemLabel(
            c, data.optInt("logicalCores") + L10n.text("코어 · 전체 사용률"), r, top + dp(91), 11, muted);
        systemSpark(c, history == null ? null : history.optJSONArray("cpu"), chart, accent, true);
      } else if (kind.equals("memory")) {
        double used = metric(mem, "usedBytes"), total = metric(mem, "totalBytes");
        systemLabel(c, metricBytes(used), r, top + dp(65), 22, text);
        String pressure = mem == null ? "unknown" : mem.optString("pressure");
        int stateColor =
            color(
                pressure.equals("normal")
                    ? "#83cbb9"
                    : pressure.equals("warning")
                        ? "#efbd73"
                        : pressure.equals("critical") ? "#ef9696" : "#9caec0");
        systemLabel(
            c,
            L10n.text("전체 ") + metricBytes(total) + L10n.text(" · 압력 ") + pressureText(pressure),
            r,
            top + dp(87),
            10,
            stateColor);
        systemLabel(
            c,
            L10n.text("압축 ")
                + metricBytes(metric(mem, "compressedBytes"))
                + L10n.text(" · 스왑 ")
                + metricBytes(metric(mem, "swapBytes")),
            r,
            top + dp(106),
            9,
            muted);
        systemSpark(
            c, history == null ? null : history.optJSONArray("memory"), chart, accent, true);
      } else if (kind.equals("disk")) {
        double free = metric(disk, "availableBytes"), total = metric(disk, "totalBytes");
        boolean low =
            Double.isFinite(free) && (free < 20d * 1024 * 1024 * 1024 || free / total < .05);
        systemLabel(
            c,
            metricBytes(free) + L10n.text(" 여유"),
            r,
            top + dp(65),
            22,
            color(low ? "#ef9696" : themeValue("text")));
        systemLabel(
            c,
            L10n.text("전체 ")
                + metricBytes(total)
                + " · "
                + (low ? L10n.text("저장 공간 확인 필요") : L10n.text("사용 가능")),
            r,
            top + dp(89),
            10,
            muted);
        systemLabel(
            c,
            L10n.text("읽기 ") + metricBytes(metric(io, "readBytesPerSecond")) + "/s",
            r,
            r.bottom - dp(43),
            10,
            muted);
        systemLabel(
            c,
            L10n.text("쓰기 ") + metricBytes(metric(io, "writeBytesPerSecond")) + "/s",
            r,
            r.bottom - dp(24),
            10,
            muted);
      } else if (kind.equals("power")) {
        double battery = metric(power, "batteryPercent");
        systemLabel(
            c,
            Double.isFinite(battery)
                ? String.format(L10n.locale(), "%.0f%%", battery)
                : L10n.text("배터리 없음"),
            r,
            top + dp(65),
            24,
            text);
        systemLabel(
            c,
            power != null && power.optBoolean("pluggedIn")
                ? L10n.text("전원 연결됨")
                : L10n.text("배터리 사용 중"),
            r,
            top + dp(90),
            11,
            muted);
        systemLabel(
            c,
            L10n.text("발열 부담 ") + thermalText(power == null ? "" : power.optString("thermal")),
            r,
            r.bottom - dp(42),
            12,
            accent);
        systemLabel(
            c,
            power != null && power.optBoolean("lowPower")
                ? L10n.text("저전력 모드 켜짐")
                : L10n.text("저전력 모드 꺼짐"),
            r,
            r.bottom - dp(22),
            10,
            muted);
      } else if (kind.equals("network")) {
        systemLabel(
            c,
            "↓ " + metricBytes(metric(net, "rxBytesPerSecond")) + "/s",
            r,
            top + dp(65),
            22,
            text);
        systemLabel(
            c,
            "↑ " + metricBytes(metric(net, "txBytesPerSecond")) + "/s",
            r,
            top + dp(94),
            17,
            muted);
        systemSpark(c, history == null ? null : history.optJSONArray("rx"), chart, accent, false);
      } else if (kind.equals("processes")) {
        JSONObject processes = data.optJSONObject("processes");
        JSONArray rows = processes == null ? null : processes.optJSONArray("cpu");
        if (rows == null || rows.length() == 0)
          systemLabel(c, L10n.text("앱 사용량 비교 중…"), r, top + dp(72), 17, muted);
        else
          for (int i = 0; i < Math.min(3, rows.length()); i++) {
            JSONObject row = rows.optJSONObject(i);
            float y = top + dp(57 + i * 35);
            systemLabel(
                c,
                row.optString("name"),
                new RectF(r.left, r.top, r.right - dp(65), r.bottom),
                y,
                12,
                text);
            label(
                c,
                metricPercent(metric(row, "cpuPercent")),
                r.right - dp(16),
                y,
                12,
                accent,
                Paint.Align.RIGHT);
            systemLabel(c, metricBytes(metric(row, "memoryBytes")), r, y + dp(17), 10, muted);
          }
        systemLabel(c, L10n.text("100% = 1코어 · 탭하여 메모리 순 보기"), r, r.bottom - dp(16), 9, muted);
      } else {
        List<String> alerts = systemWarnings(data);
        systemLabel(
            c,
            alerts.isEmpty()
                ? L10n.text("맥 상태 정상")
                : L10n.text("확인할 상태 ") + alerts.size() + L10n.text("개"),
            r,
            top + dp(63),
            22,
            color(alerts.isEmpty() ? "#83cbb9" : "#efbd73"));
        systemLabel(
            c,
            data.optString("model", L10n.text("내 Mac"))
                + " · "
                + data.optInt("logicalCores")
                + L10n.text("코어"),
            r,
            top + dp(90),
            11,
            muted);
        if (!alerts.isEmpty())
          systemLabel(c, String.join(" · ", alerts), r, top + dp(117), 12, color("#efbd73"));
        long uptime = data.optLong("uptimeSeconds");
        systemLabel(
            c,
            L10n.text("가동 ")
                + (uptime / 3600)
                + L10n.text("시간 ")
                + ((uptime % 3600) / 60)
                + L10n.text("분 · 2초 갱신"),
            r,
            r.bottom - dp(19),
            10,
            muted);
      }
    }

    void grafanaTrend(Canvas c, JSONArray points, RectF r, int accent, boolean percent) {
      if (points == null || points.length() < 2 || r.height() < dp(8)) return;
      long first = points.optJSONArray(0).optLong(0),
          last = points.optJSONArray(points.length() - 1).optLong(0);
      if (last <= first) return;
      double max = percent ? 100 : 1;
      if (!percent)
        for (int i = 0; i < points.length(); i++)
          max = Math.max(max, points.optJSONArray(i).optDouble(1));
      iconPath.rewind();
      boolean started = false;
      long previous = 0;
      for (int i = 0; i < points.length(); i++) {
        JSONArray point = points.optJSONArray(i);
        long at = point.optLong(0);
        double v = point.optDouble(1, Double.NaN);
        if (!Double.isFinite(v)) {
          started = false;
          continue;
        }
        float x = r.left + r.width() * (at - first) / (float) (last - first),
            y = r.bottom - (float) Math.max(0, Math.min(1, v / max)) * r.height();
        if (started && at - previous <= 120000) iconPath.lineTo(x, y);
        else iconPath.moveTo(x, y);
        started = true;
        previous = at;
      }
      paint.setColor(accent);
      paint.setStrokeWidth(dp(2));
      paint.setStyle(Paint.Style.STROKE);
      c.drawPath(iconPath, paint);
      paint.setStyle(Paint.Style.FILL);
    }

    void drawMacSummary(Canvas c, JSONObject widget, RectF r) {
      int muted = color("#8291a3"), ink = color("#dce4ee");
      float split = r.left + r.width() * .20f, middle = r.left + r.width() * .53f;
      RectF title = new RectF(r.left, r.top, split, r.bottom),
          readings = new RectF(split, r.top, middle, r.bottom),
          issues = new RectF(middle, r.top, r.right, r.bottom);
      systemLabel(
          c,
          template(widget.optString("label", L10n.text("내 Mac"))),
          title,
          r.top + dp(28),
          14,
          ink);
      systemLabel(c, L10n.text("상세 보기 ›"), title, r.top + dp(51), 11, muted);
      JSONObject data = macSystem();
      if (data == null) {
        systemLabel(c, L10n.text("맥 상태 연결 대기"), readings, r.top + dp(36), 16, muted);
        return;
      }
      JSONObject cpu = data.optJSONObject("cpu"), mem = data.optJSONObject("memory");
      double used = metric(mem, "usedBytes"), total = metric(mem, "totalBytes");
      systemLabel(
          c,
          "CPU " + metricPercent(metric(cpu, "percent")),
          readings,
          r.top + dp(30),
          18,
          monitorColor(widget, "cpu"));
      systemLabel(
          c,
          "MEM "
              + metricPercent(total > 0 ? 100 * used / total : Double.NaN)
              + " · "
              + metricGiB(used),
          readings,
          r.top + dp(53),
          13,
          monitorColor(widget, "memory"));
      List<String> warnings = new ArrayList<>();
      for (String key : new String[] {"cpu", "memory"}) {
        String level = monitorLevel(widget, key);
        if (level.equals("critical") || level.equals("warning"))
          warnings.add(
              (key.equals("cpu") ? "CPU" : "MEM")
                  + " "
                  + (level.equals("critical") ? L10n.text("위험") : L10n.text("주의")));
      }
      warnings.addAll(systemWarnings(data));
      String level =
          monitorHealth(widget) == null ? "unknown" : monitorHealth(widget).optString("level");
      int warningColor = level.equals("critical") ? monitorColor(level) : color("#efbd73");
      String summary =
          warnings.isEmpty()
              ? L10n.text("추가로 확인할 문제 없음")
              : String.join(" · ", warnings.subList(0, Math.min(2, warnings.size())));
      systemLabel(
          c, summary, issues, r.top + dp(30), 13, warnings.isEmpty() ? muted : warningColor);
      systemLabel(c, L10n.text("저장 공간 · 전원 · 네트워크는 상세에서"), issues, r.top + dp(53), 11, muted);
    }

    void monitorBadge(Canvas c, RectF r, String level, String normal) {
      monitorBadge(c, r, level, normal, null);
    }

    void monitorBadge(Canvas c, RectF r, String level, String normal, String override) {
      String text =
          override != null
              ? override
              : level.equals("critical")
                  ? L10n.text("위험")
                  : level.equals("warning")
                      ? L10n.text("주의")
                      : level.equals("normal") ? normal : L10n.text("확인 중");
      int ink = level.equals("normal") ? color("#93b7a7") : monitorColor(level);
      paint.setTypeface(font);
      paint.setTextLocale(L10n.locale());
      paint.setTextSize(dp(11));
      float width = paint.measureText(text) + dp(29),
          right = r.right - dp(20),
          top = r.top + dp(17);
      paint.setColor(
          color(
              level.equals("critical")
                  ? "#38272e"
                  : level.equals("warning")
                      ? "#352e23"
                      : level.equals("normal") ? "#23332f" : "#26303b"));
      c.drawRoundRect(new RectF(right - width, top, right, top + dp(25)), dp(12), dp(12), paint);
      paint.setColor(ink);
      c.drawCircle(right - width + dp(11), top + dp(12.5f), dp(2.5f), paint);
      label(c, text, right - dp(9), top + dp(17), 11, ink, Paint.Align.RIGHT);
    }

    void monitorCapacity(Canvas c, JSONObject widget, String key, double value, RectF rect) {
      paint.setColor(color("#2c3846"));
      c.drawRoundRect(rect, dp(3), dp(3), paint);
      if (!Double.isFinite(value)) return;
      int ink = monitorValueColor(widget, key, value);
      paint.setColor(ink == monitorColor("normal") ? color("#657b92") : ink);
      c.drawRoundRect(
          new RectF(
              rect.left,
              rect.top,
              rect.left + rect.width() * (float) Math.max(0, Math.min(1, value / 100)),
              rect.bottom),
          dp(3),
          dp(3),
          paint);
    }

    void monitorText(Canvas c, String value, RectF rect, float y, float size, int ink) {
      label(
          c,
          ellipsize(value, rect.width() - dp(40), size),
          rect.left + dp(20),
          y,
          size,
          ink,
          Paint.Align.LEFT);
    }

    void monitorNumber(Canvas c, String value, RectF rect, float y, float size, int ink) {
      paint.setTypeface(font);
      paint.setTextLocale(L10n.locale());
      paint.setTextSize(dp(size) * settingInt("textScale") / 100f);
      float width = paint.measureText(value), available = rect.width() - dp(40);
      float fitted = width > available ? size * available / width : size;
      label(c, value, rect.left + dp(20), y, fitted, ink, Paint.Align.LEFT);
    }

    int nodeSeriesColor(String name) {
      int[] palette = {color("#8fb5e7"), color("#b6a4d9"), color("#7fbcb0"), color("#96a7b5")};
      return palette[Math.floorMod(name.hashCode(), palette.length)];
    }

    void monitorGauge(
        Canvas c,
        JSONObject widget,
        String key,
        double value,
        float cx,
        float cy,
        float radius,
        float numberSize,
        int normalInk) {
      if (widget.optString("type").equals("grafana"))
        value = visibleGrafanaValue(widget, key, value);
      RectF dial = new RectF(cx - radius, cy - radius, cx + radius, cy + radius);
      paint.setStyle(Paint.Style.STROKE);
      paint.setStrokeCap(Paint.Cap.BUTT);
      paint.setStrokeWidth(dp(7));
      paint.setColor(color("#35414c"));
      c.drawArc(dial, 135, 270, false, paint);
      int statusInk = grafanaReadingColor(widget, key, value);
      if (Double.isFinite(value)) {
        paint.setColor(statusInk == monitorColor("normal") ? normalInk : statusInk);
        c.drawArc(dial, 135, (float) (270 * Math.max(0, Math.min(1, value / 100))), false, paint);
      }
      JSONObject health = monitorHealth(widget),
          metrics = health == null ? null : health.optJSONObject("metrics"),
          rule = metrics == null ? null : metrics.optJSONObject(key);
      if (rule != null && rule.optBoolean("enabled")) {
        for (String threshold : new String[] {"warning", "critical"}) {
          double limit = rule.optDouble(threshold, Double.NaN);
          if (!Double.isFinite(limit) || limit < 0 || limit > 100) continue;
          double angle = Math.toRadians(135 + 270 * limit / 100);
          float dx = (float) Math.cos(angle), dy = (float) Math.sin(angle);
          line(
              c,
              cx + dx * (radius - dp(5)),
              cy + dy * (radius - dp(5)),
              cx + dx * (radius + dp(5)),
              cy + dy * (radius + dp(5)),
              monitorColor(threshold),
              dp(1.5f));
        }
      }
      paint.setStyle(Paint.Style.FILL);
      String number = metricPercent(value);
      paint.setTypeface(font);
      paint.setTextLocale(L10n.locale());
      paint.setTextSize(dp(numberSize) * settingInt("textScale") / 100f);
      float fitted =
          Math.min(numberSize, numberSize * radius * 1.7f / Math.max(1, paint.measureText(number)));
      label(c, number, cx, cy + dp(8), fitted, statusInk, Paint.Align.CENTER);
      label(c, "CPU", cx, cy + radius * .67f, 11, color("#93a0ae"), Paint.Align.CENTER);
    }

    void monitorSeries(
        Canvas c, JSONArray points, RectF plot, long from, long to, double max, int ink) {
      if (points == null || to <= from || max <= 0 || plot.height() < dp(8)) return;
      iconPath.rewind();
      boolean started = false;
      long previous = 0;
      for (int i = 0; i < Math.min(points.length(), 60); i++) {
        JSONArray point = points.optJSONArray(i);
        if (point == null) {
          started = false;
          continue;
        }
        long at = point.optLong(0);
        double value = point.optDouble(1, Double.NaN);
        if (at < from || at > to || !Double.isFinite(value)) {
          started = false;
          continue;
        }
        float x = plot.left + plot.width() * (at - from) / (float) (to - from),
            y = plot.bottom - plot.height() * (float) Math.max(0, Math.min(1, value / max));
        if (started && at - previous <= 120000) iconPath.lineTo(x, y);
        else iconPath.moveTo(x, y);
        previous = at;
        started = true;
      }
      paint.setStyle(Paint.Style.STROKE);
      paint.setStrokeWidth(dp(1.8f));
      paint.setStrokeCap(Paint.Cap.ROUND);
      paint.setColor(ink);
      c.drawPath(iconPath, paint);
      paint.setStyle(Paint.Style.FILL);
    }

    void monitorPlotGrid(Canvas c, RectF plot, long to, double max) {
      int muted = color("#8291a3");
      for (int i = 0; i <= 2; i++) {
        float y = plot.top + plot.height() * i / 2;
        line(c, plot.left, y, plot.right, y, color("#33404b"), dp(.6f));
        label(
            c,
            String.format(L10n.locale(), "%.0f", max * (2 - i) / 2),
            plot.left - dp(7),
            y + dp(3),
            9,
            muted,
            Paint.Align.RIGHT);
      }
      label(
          c,
          osDate(to - 3600000, "HH:mm"),
          plot.left,
          plot.bottom + dp(15),
          9,
          muted,
          Paint.Align.LEFT);
      label(
          c,
          osDate(to - 1800000, "HH:mm"),
          plot.centerX(),
          plot.bottom + dp(15),
          9,
          muted,
          Paint.Align.CENTER);
      label(c, osDate(to, "HH:mm"), plot.right, plot.bottom + dp(15), 9, muted, Paint.Align.RIGHT);
    }

    void monitorStat(
        Canvas c,
        JSONObject widget,
        JSONObject data,
        String key,
        String heading,
        RectF cell,
        float labelY,
        float valueY,
        float numberSize) {
      monitorText(c, heading, cell, labelY, 11, color("#93a0ae"));
      monitorNumber(
          c,
          grafanaNumber(data, key, false),
          new RectF(cell.left, cell.top, cell.left + cell.width() * .58f + dp(20), cell.bottom),
          valueY,
          numberSize,
          monitorColor(widget, key));
      monitorText(
          c,
          sourceStamp(data, key),
          cell,
          valueY + dp(19),
          9,
          grafanaReadingColor(widget, key, metric(data.optJSONObject(key), "value")));
      JSONObject metric = data.optJSONObject(key);
      JSONArray points = metric == null ? null : metric.optJSONArray("points");
      double max = 1;
      if (points != null)
        for (int i = 0; i < points.length(); i++) {
          JSONArray p = points.optJSONArray(i);
          if (p != null) max = Math.max(max, p.optDouble(1, 0));
        }
      long to = data.optLong("capturedAt");
      monitorSeries(
          c,
          points,
          new RectF(cell.left + cell.width() * .60f, labelY + dp(8), cell.right - dp(20), valueY),
          to - 3600000,
          to,
          max,
          monitorLevel(widget, key).equals("normal")
              ? color("#788fa7")
              : monitorColor(widget, key));
    }

    void drawGrafana(Canvas c, JSONObject widget, RectF r) {
      boolean server = widget.optString("metric").equals("system");
      int text = color("#e8edf4"), muted = color("#8291a3"), lineColor = color("#303d4b");
      JSONObject style = widget.optJSONObject("style"),
          health = monitorHealth(widget),
          data = grafanaData(widget);
      String level = health == null ? "unknown" : health.optString("level", "unknown");
      String notice = freshnessNotice(widget, data);
      if (notice != null && !level.equals("critical"))
        level =
            notice.equals(L10n.text("연결 끊김"))
                    || notice.equals(L10n.text("조회 중단"))
                    || notice.equals(L10n.text("오래된 데이터"))
                ? "critical"
                : "warning";
      if (level.equals("critical") || level.equals("warning")) {
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(dp(1.5f));
        paint.setColor(monitorColor(level));
        c.drawRoundRect(
            new RectF(r.left + dp(1), r.top + dp(1), r.right - dp(1), r.bottom - dp(1)),
            dp(16),
            dp(16),
            paint);
        paint.setStyle(Paint.Style.FILL);
      }
      RectF heading = new RectF(r.left, r.top, r.right - dp(90), r.bottom);
      monitorText(
          c,
          template(widget.optString("label", server ? L10n.text("서버 상태") : L10n.text("데이터베이스"))),
          heading,
          r.top + dp(34),
          style == null ? 16 : style.optInt("textSize", 16),
          text);
      monitorBadge(c, r, level, L10n.text("정상"), notice);
      if (!queryFresh(data)) {
        monitorText(
            c,
            notice == null ? L10n.text("지표 연결 확인") : notice,
            r,
            r.top + dp(116),
            24,
            monitorColor("critical"));
        monitorText(
            c,
            !streamFresh()
                ? L10n.text("맥에서 다시 연결되면 자동으로 갱신됩니다")
                : data == null
                    ? L10n.text("최신 데이터를 기다리고 있어요")
                    : data.optString("message", L10n.text("지표 조회가 오래됐어요 · 다시 연결 중")),
            r,
            r.top + dp(148),
            12,
            muted);
        monitorText(
            c,
            L10n.text("마지막 ") + sourceStamp(data, server ? "system" : "cpu"),
            r,
            r.top + dp(181),
            12,
            muted);
      } else if (server) {
        JSONObject cpu = data.optJSONObject("system"),
            collection = data.optJSONObject("collection");
        double value = metric(cpu, "value");
        float base = style == null ? 56 : style.optInt("valueSize", 56);
        monitorText(c, L10n.text("시스템 CPU · 서비스 보고값 중 최대"), r, r.top + dp(68), 12, muted);
        monitorGauge(
            c,
            widget,
            "cpu",
            value,
            r.centerX(),
            r.top + dp(174),
            Math.min(dp(87), r.width() * .30f),
            base,
            color("#8fb5e7"));
        monitorText(
            c,
            sourceStamp(data, "system"),
            r,
            r.top + dp(272),
            11,
            grafanaReadingColor(widget, "cpu", value));
        int healthy = collection == null ? 0 : collection.optInt("healthy"),
            total = collection == null ? 0 : collection.optInt("total");
        JSONArray services = cpu == null ? null : cpu.optJSONArray("nodes");
        monitorText(
            c,
            total > 0
                ? L10n.text("수집 ")
                    + healthy
                    + " / "
                    + total
                    + L10n.text("  ·  서비스 ")
                    + (services == null ? 0 : services.length())
                    + L10n.text("개")
                : L10n.text("수집 대상 없음"),
            r,
            r.top + dp(293),
            12,
            monitorLevel(widget, "collection").equals("critical")
                ? monitorColor("critical")
                : muted);
        monitorText(c, L10n.text("CPU 추이 · %"), r, r.top + dp(329), 11, muted);
        RectF plot =
            new RectF(r.left + dp(43), r.top + dp(347), r.right - dp(20), r.bottom - dp(84));
        long to = data.optLong("capturedAt");
        monitorPlotGrid(c, plot, to, 100);
        monitorSeries(
            c,
            cpu == null ? null : cpu.optJSONArray("points"),
            plot,
            to - 3600000,
            to,
            100,
            monitorLevel(widget, "cpu").equals("normal")
                ? color("#8fb5e7")
                : monitorColor(widget, "cpu"));
      } else {
        JSONObject database = data.optJSONObject("database");
        JSONArray nodes = database == null ? null : database.optJSONArray("nodes");
        int count = nodes == null ? 0 : nodes.length(), shown = Math.min(count, 4);
        float base = style == null ? 44 : style.optInt("valueSize", 44);
        monitorText(
            c,
            "CPU " + sourceStamp(data, "cpu"),
            new RectF(r.left, r.top, r.centerX(), r.bottom),
            r.top + dp(65),
            10,
            grafanaReadingColor(widget, "cpu", metric(data.optJSONObject("cpu"), "value")));
        long to = data.optLong("capturedAt");
        RectF queryTime = new RectF(r.centerX(), r.top, r.right, r.bottom);
        monitorText(
            c,
            "MEM " + sourceStamp(data, "memory"),
            queryTime,
            r.top + dp(65),
            10,
            grafanaReadingColor(widget, "memory", metric(data.optJSONObject("memory"), "value")));
        float width = (r.width() - dp(24)) / Math.max(1, shown);
        double chartMax = 100;
        if (shown == 0) monitorText(c, L10n.text("DB 노드 지표 수집 없음"), r, r.top + dp(170), 21, muted);
        for (int i = 0; i < shown; i++) {
          JSONObject node = nodes.optJSONObject(i);
          if (node == null) continue;
          RectF cell =
              new RectF(
                  r.left + dp(12) + i * width, r.top, r.left + dp(12) + (i + 1) * width, r.bottom);
          String name = node.optString("name", L10n.text("노드"));
          int seriesInk = nodeSeriesColor(name);
          double cpuValue = metric(node, "cpuPercent"), memoryValue = metric(node, "memoryPercent");
          paint.setColor(seriesInk);
          c.drawCircle(cell.left + dp(20), r.top + dp(90), dp(3), paint);
          monitorText(
              c,
              name,
              new RectF(cell.left + dp(13), cell.top, cell.right, cell.bottom),
              r.top + dp(94),
              13,
              text);
          monitorGauge(
              c,
              widget,
              "cpu",
              cpuValue,
              cell.centerX(),
              r.top + dp(174),
              Math.min(dp(59), width * .32f),
              base * .75f,
              seriesInk);
          monitorText(
              c,
              sourceAge(node.optLong("cpuAt")),
              cell,
              r.top + dp(239),
              10,
              grafanaReadingColor(widget, "cpu", cpuValue));
          cpuValue = visibleGrafanaValue(widget, "cpu", cpuValue);
          memoryValue = visibleGrafanaValue(widget, "memory", memoryValue);
          monitorText(c, "MEM", cell, r.top + dp(257), 10, muted);
          RectF memValue = new RectF(cell.left + dp(37), cell.top, cell.right, cell.bottom);
          monitorNumber(
              c,
              metricPercent(memoryValue),
              memValue,
              r.top + dp(258),
              base * .40f,
              grafanaReadingColor(widget, "memory", memoryValue));
          monitorText(
              c,
              metricGiB(visibleGrafanaValue(widget, "memory", metric(node, "memoryUsedBytes")))
                  + " · "
                  + sourceAge(node.optLong("memoryAt")),
              cell,
              r.top + dp(280),
              11,
              muted);
          monitorCapacity(
              c,
              widget,
              "memory",
              memoryValue,
              new RectF(cell.left + dp(20), r.top + dp(290), cell.right - dp(20), r.top + dp(294)));
          if (i > 0)
            line(c, cell.left, r.top + dp(86), cell.left, r.top + dp(294), lineColor, dp(.5f));
          JSONArray points = node.optJSONArray("cpuPoints");
          if (points != null)
            for (int j = 0; j < points.length(); j++) {
              JSONArray p = points.optJSONArray(j);
              if (p != null && p.optDouble(1, 0) > chartMax)
                chartMax = Math.ceil(p.optDouble(1) / 50) * 50;
            }
        }
        monitorText(
            c,
            L10n.text("노드별 CPU 추이 · %")
                + (count > shown
                    ? L10n.text(" · 외 ") + (count - shown) + L10n.text("개는 상세 보기")
                    : ""),
            r,
            r.top + dp(324),
            11,
            muted);
        RectF plot =
            new RectF(r.left + dp(43), r.top + dp(337), r.right - dp(20), r.bottom - dp(149));
        monitorPlotGrid(c, plot, to, chartMax);
        for (int i = 0; i < shown; i++) {
          JSONObject node = nodes.optJSONObject(i);
          if (node == null) continue;
          monitorSeries(
              c,
              node.optJSONArray("cpuPoints"),
              plot,
              to - 3600000,
              to,
              chartMax,
              nodeSeriesColor(node.optString("name")));
        }
        float statWidth = r.width() / 3;
        RectF tpsCell = new RectF(r.left, r.top, r.left + statWidth, r.bottom),
            qpsCell = new RectF(tpsCell.right, r.top, tpsCell.right + statWidth, r.bottom),
            connectionsCell = new RectF(qpsCell.right, r.top, r.right, r.bottom);
        monitorStat(
            c,
            widget,
            data,
            "tps",
            L10n.text("전체 TPS · 커밋/초"),
            tpsCell,
            r.bottom - dp(110),
            r.bottom - dp(76),
            base * .53f);
        monitorStat(
            c,
            widget,
            data,
            "qps",
            L10n.text("전체 QPS · 쿼리/초"),
            qpsCell,
            r.bottom - dp(110),
            r.bottom - dp(76),
            base * .53f);
        monitorText(c, L10n.text("DB 연결 수"), connectionsCell, r.bottom - dp(110), 11, muted);
        double connections =
            visibleGrafanaValue(widget, "connections", metric(database, "connections"));
        monitorNumber(
            c,
            Double.isFinite(connections) ? String.format(L10n.locale(), "%,.0f", connections) : "—",
            connectionsCell,
            r.bottom - dp(76),
            base * .53f,
            grafanaReadingColor(widget, "connections", connections));
        monitorText(
            c, sourceStamp(data, "connections"), connectionsCell, r.bottom - dp(57), 9, muted);
      }
      line(
          c,
          r.left + dp(20),
          r.bottom - dp(51),
          r.right - dp(20),
          r.bottom - dp(51),
          lineColor,
          dp(1));
      monitorText(
          c,
          server
              ? L10n.text("CPU 상세 보기 ›")
              : grafanaProject(widget).optString("label", L10n.text("프로젝트 선택")) + "   ▾",
          r,
          r.bottom - dp(21),
          13,
          muted);
    }

    boolean widgetActive(JSONObject widget) {
      return Boolean.TRUE.equals(variable(widget.optString("stateVariable")))
          || widget.optString("type").equals("toggle")
              && Boolean.TRUE.equals(variable(widget.optString("binding")));
    }

    JSONObject effectiveWidget(JSONObject widget) {
      if (!widgetActive(widget)) return widget;
      String id = widget.optString("id");
      JSONObject active = activeWidgets.get(id);
      if (active != null) return active;
      try {
        active = new JSONObject(widget.toString());
        if (widget.has("activeLabel")) active.put("label", widget.get("activeLabel"));
        if (widget.has("activeIcon")) active.put("icon", widget.get("activeIcon"));
        JSONObject style = widget.optJSONObject("style");
        style = style == null ? new JSONObject() : new JSONObject(style.toString());
        JSONObject overrides = widget.optJSONObject("activeStyle");
        if (overrides != null) {
          Iterator<String> keys = overrides.keys();
          while (keys.hasNext()) {
            String key = keys.next();
            style.put(key, overrides.get(key));
          }
        }
        active.put("style", style);
        activeWidgets.put(id, active);
        return active;
      } catch (JSONException ignored) {
        return widget;
      }
    }

    void drawWidget(Canvas c, JSONObject w, RectF r) {
      w = effectiveWidget(w);
      String type = w.optString("type"), id = w.optString("id");
      int accent = color(w.optString("color", "#86b6ff"));
      JSONObject style = w.optJSONObject("style");
      if (style == null) style = new JSONObject();
      if (type.equals("spacer")) return;
      float radius = dp((drawingPage == null ? activePage() : drawingPage).optInt("radius", 13));
      paint.setColor(color(style.optString("background", themeValue("surface"))));
      paint.setStyle(Paint.Style.FILL);
      c.drawRoundRect(r, radius, radius, paint);
      if (type.equals("button") && style.optString("presentation").equals("os-action")) {
        drawOSAction(c, w, r, style);
        return;
      }
      if (type.equals("button") || type.equals("page") || style.optInt("borderWidth", 0) > 0) {
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(dp(style.optInt("borderWidth", 1)));
        paint.setColor(
            color(style.optString("borderColor", w.optString("color", themeValue("accent")))));
        c.drawRoundRect(r, radius, radius, paint);
        paint.setStyle(Paint.Style.FILL);
      }
      float cx = r.centerX(), cy = r.centerY(), basis = Math.min(r.width(), r.height());
      if (type.equals("button") || type.equals("page")) {
        String position = style.optString("labelPosition", "bottom");
        float imageY =
            r.top
                + r.height()
                    * (position.equals("top") ? .63f : position.equals("hidden") ? .5f : .37f);
        float size = basis * style.optInt("iconSize", 32) / 100f;
        Bitmap image =
            bitmap(
                w.optString("image"),
                ClientSettingsPolicy.iconResolution(size, settingInt("iconResolution")));
        if (image != null) {
          paint.setColor(Color.WHITE);
          paint.setFilterBitmap(true);
          c.drawBitmap(
              image,
              null,
              new RectF(cx - size / 2, imageY - size / 2, cx + size / 2, imageY + size / 2),
              paint);
        } else
          drawIcon(
              c,
              w.optString("icon", type.equals("page") ? "tasks" : "monitor"),
              cx,
              imageY,
              size,
              accent);
        if (!position.equals("hidden")) drawLabel(c, w, r, style, position);
      } else if (type.equals("system")) {
        drawSystem(c, w, r);
      } else if (type.equals("grafana")) {
        drawGrafana(c, w, r);
      } else if (type.equals("clock")) {
        label(
            c,
            w.optString("label"),
            cx,
            r.top + r.height() * .27f,
            11,
            color("#a4b7d3"),
            Paint.Align.CENTER);
        label(
            c,
            timeFormat.format(new Date(hostNow())),
            cx,
            r.top + r.height() * .60f,
            Math.min(48, basis / dp(1) * .24f),
            color(themeValue("text")),
            Paint.Align.CENTER);
        label(
            c,
            dateFormat.format(new Date(hostNow())),
            cx,
            r.top + r.height() * .79f,
            13,
            color("#99acc9"),
            Paint.Align.CENTER);
      } else if (type.equals("gauges")) {
        label(
            c,
            w.optString("label"),
            r.left + dp(15),
            r.top + dp(24),
            10,
            color("#a6b6d0"),
            Paint.Align.LEFT);
        float rad = Math.min(r.width() * .19f, r.height() * .28f);
        for (int k = 0; k < 2; k++) {
          float gx = r.left + r.width() * (k == 0 ? .27f : .73f), gy = r.top + r.height() * .44f;
          int val = state.optInt(k == 0 ? "cpu" : "memory");
          arcBounds.set(gx - rad, gy - rad, gx + rad, gy + rad);
          arc(c, arcBounds, val / 100f, color(k == 0 ? "#7cbaff" : "#ad9bff"));
          label(
              c,
              val + "%",
              gx,
              r.top + r.height() * .80f,
              20,
              color(themeValue("text")),
              Paint.Align.CENTER);
          label(
              c,
              k == 0 ? "CPU" : "MEM",
              gx,
              r.top + r.height() * .91f,
              9,
              color("#8196b5"),
              Paint.Align.CENTER);
        }
      } else if (type.equals("timer")) {
        JSONObject all = state.optJSONObject("timers"),
            t = all == null ? null : all.optJSONObject(id);
        long duration = w.optLong("minutes", 25) * 60000,
            remaining =
                t == null
                    ? duration
                    : t.optBoolean("running")
                        ? Math.max(0, t.optLong("end") - hostNow())
                        : t.optLong("remaining", duration);
        float rad = basis * .34f;
        arcBounds.set(cx - rad, cy - rad - dp(8), cx + rad, cy + rad - dp(8));
        arc(c, arcBounds, remaining / (float) duration, accent);
        long sec = (remaining + 999) / 1000;
        label(
            c,
            String.format(Locale.ROOT, "%02d:%02d", sec / 60, sec % 60),
            cx,
            cy,
            Math.min(34, basis / dp(1) * .17f),
            color(themeValue("text")),
            Paint.Align.CENTER);
        label(c, w.optString("label"), cx, cy + dp(23), 11, color("#a6b6d0"), Paint.Align.CENTER);
        label(
            c,
            L10n.text("탭: 시작·일시정지   길게: 초기화"),
            cx,
            r.bottom - dp(13),
            8,
            color("#647d9f"),
            Paint.Align.CENTER);
      } else if (type.equals("volume") || type.equals("slider")) {
        double bound =
            variable(w.optString("binding")) instanceof Number
                ? ((Number) variable(w.optString("binding"))).doubleValue()
                : w.optDouble("min", 0);
        double min = type.equals("volume") ? 0 : w.optDouble("min", 0),
            max = type.equals("volume") ? 100 : w.optDouble("max", 100);
        double value =
            dragVolume >= 0 && downIndex >= 0 && widgets.get(downIndex).optString("id").equals(id)
                ? min + (max - min) * dragVolume / 100f
                : type.equals("volume") ? state.optInt("volume", 50) : bound;
        label(
            c,
            w.optString("label"),
            r.left + dp(16),
            r.top + dp(29),
            14,
            color(themeValue("text")),
            Paint.Align.LEFT);
        label(
            c,
            String.format(Locale.ROOT, "%.0f", value) + (type.equals("volume") ? "%" : ""),
            r.right - dp(16),
            r.top + dp(29),
            17,
            color(themeValue("text")),
            Paint.Align.RIGHT);
        float x1 = r.left + dp(25),
            x2 = r.right - dp(25),
            y = r.centerY() + dp(15),
            x = x1 + (x2 - x1) * (float) ((value - min) / (max - min));
        line(c, x1, y, x2, y, color("#29334a"), 12);
        line(c, x1, y, x, y, accent, 12);
        paint.setColor(color("#e6efff"));
        c.drawCircle(x, y, dp(13), paint);
      } else if (type.equals("toggle")) {
        boolean on = Boolean.TRUE.equals(variable(w.optString("binding")));
        paint.setColor(on ? accent : color("#445268"));
        float sw = Math.min(r.width() * .55f, dp(100)), sh = sw * .48f;
        c.drawRoundRect(
            new RectF(cx - sw / 2, cy - sh / 2, cx + sw / 2, cy + sh / 2), sh / 2, sh / 2, paint);
        paint.setColor(Color.WHITE);
        c.drawCircle(cx + (on ? 1 : -1) * (sw - sh) / 2, cy, sh * .38f, paint);
        drawLabel(c, w, r, style, style.optString("labelPosition", "bottom"));
      } else if (type.equals("agenda")
          || type.equals("inbox")
          || type.equals("notification-feed")) {
        drawOSSummary(c, w, r, accent);
      } else if (type.equals("calendar")) {
        Calendar date = Calendar.getInstance(TimeZone.getTimeZone("Asia/Seoul"));
        date.setTimeInMillis(hostNow());
        boolean provider = w.optString("provider").equals("jimin-os");
        if (provider) date.add(Calendar.MONTH, osMonthOffset);
        int day = date.get(Calendar.DAY_OF_MONTH),
            days = date.getActualMaximum(Calendar.DAY_OF_MONTH);
        date.set(Calendar.DAY_OF_MONTH, 1);
        int offset = date.get(Calendar.DAY_OF_WEEK) - 1;
        label(
            c,
            osDate(date.getTimeInMillis(), "yyyy년 M월") + (provider ? "  ›" : ""),
            cx,
            r.top + dp(28),
            16,
            accent,
            Paint.Align.CENTER);
        float cw = r.width() / 8, ch = (r.height() - dp(72)) / 7;
        for (int i = 0; i < 7; i++)
          label(
              c,
              new java.text.DateFormatSymbols(L10n.locale()).getShortWeekdays()[i + 1],
              r.left + cw * (i + 1),
              r.top + dp(48),
              10,
              color(themeValue("text")),
              Paint.Align.CENTER);
        for (int d = 1; d <= days; d++) {
          int at = offset + d - 1;
          float x = r.left + cw * (at % 7 + 1), y = r.top + dp(48) + ch * (at / 7 + 1);
          if (d == day && (!provider || osMonthOffset == 0)) {
            paint.setColor(accent);
            c.drawCircle(x, y - dp(4), dp(10), paint);
          }
          label(
              c,
              String.valueOf(d),
              x,
              y,
              11,
              color(
                  d == day && (!provider || osMonthOffset == 0)
                      ? themeValue("background")
                      : themeValue("text")),
              Paint.Align.CENTER);
          if (provider && osData() != null) {
            date.set(Calendar.DAY_OF_MONTH, d);
            String dateKey = osDate(date.getTimeInMillis(), "yyyy-MM-dd");
            int count = osEventDays.getOrDefault(dateKey, 0);
            boolean hasTask = osTaskDays.contains(dateKey);
            if (hasTask) {
              paint.setColor(color("#e7ba83"));
              c.drawCircle(x + dp(10), y + dp(8), dp(1.8f), paint);
            }
            paint.setColor(accent);
            for (int dot = 0; dot < Math.min(3, count); dot++)
              c.drawCircle(
                  x + (dot - (Math.min(3, count) - 1) / 2f) * dp(5), y + dp(8), dp(1.8f), paint);
          }
        }
        if (provider)
          label(
              c,
              osData() == null ? L10n.text("Jimin OS 연결 대기") : L10n.text("날짜를 눌러 일정과 할 일을 확인해요"),
              cx,
              r.bottom - dp(13),
              10,
              color("#8ba4af"),
              Paint.Align.CENTER);
      } else if (type.equals("graph")) {
        JSONObject histories = state.optJSONObject("history");
        JSONArray values =
            histories == null ? null : histories.optJSONArray(w.optString("binding", "cpu"));
        if (values != null && values.length() > 1) {
          Path path = iconPath;
          path.rewind();
          int start = Math.max(0, values.length() - 60), len = values.length() - start;
          for (int i = 0; i < len; i++) {
            float x = r.left + dp(15) + (r.width() - dp(30)) * i / (len - 1),
                y =
                    r.bottom
                        - dp(40)
                        - (r.height() - dp(65))
                            * (float) Math.max(0, Math.min(1, values.optDouble(start + i) / 100));
            if (i == 0) path.moveTo(x, y);
            else path.lineTo(x, y);
          }
          paint.setStyle(Paint.Style.STROKE);
          paint.setStrokeWidth(dp(2));
          paint.setColor(accent);
          c.drawPath(path, paint);
          paint.setStyle(Paint.Style.FILL);
        }
        drawLabel(c, w, r, style, "bottom");
      } else if (type.equals("todo")) {
        JSONObject all = state.optJSONObject("todos");
        JSONArray items = all == null ? null : all.optJSONArray(id);
        label(
            c,
            template(w.optString("label")),
            r.left + dp(18),
            r.top + dp(30),
            16,
            accent,
            Paint.Align.LEFT);
        int count = items == null ? 0 : items.length(),
            limit = Math.max(0, (int) ((r.height() - dp(75)) / dp(28)));
        for (int i = 0; i < Math.min(count, limit); i++) {
          JSONObject item = items.optJSONObject(i);
          label(
              c,
              ellipsize(
                  (item.optBoolean("done") ? "✓ " : "○ ") + item.optString("text"),
                  r.width() - dp(36),
                  13),
              r.left + dp(18),
              r.top + dp(62 + i * 28),
              13,
              color(themeValue("text")),
              Paint.Align.LEFT);
        }
        label(
            c,
            count == 0 ? L10n.text("탭해서 할 일 추가") : L10n.text("탭해서 목록 편집"),
            cx,
            r.bottom - dp(17),
            10,
            color(themeValue("text")),
            Paint.Align.CENTER);
      } else if (type.equals("image")) {
        Bitmap image = bitmap(w.optString("image"), 1024);
        if (image != null) {
          int save = c.save();
          Path clip = iconPath;
          clip.rewind();
          clip.addRoundRect(r, radius, radius, Path.Direction.CW);
          c.clipPath(clip);
          paint.setColor(Color.WHITE);
          paint.setFilterBitmap(true);
          float scale = Math.max(r.width() / image.getWidth(), r.height() / image.getHeight()),
              iw = image.getWidth() * scale,
              ih = image.getHeight() * scale;
          c.drawBitmap(
              image, null, new RectF(cx - iw / 2, cy - ih / 2, cx + iw / 2, cy + ih / 2), paint);
          c.restoreToCount(save);
        }
        drawLabel(c, w, r, style, style.optString("labelPosition", "bottom"));
      } else {
        String text = template(w.optString("label"));
        if (w.has("binding") && !text.contains("{{") && !w.optString("binding").isEmpty())
          text += "\n" + String.valueOf(variable(w.optString("binding")));
        drawLabel(c, w, r, style, style.optString("labelPosition", "center"), text);
      }
    }

    String ellipsize(String text, float width, float size) {
      paint.setTypeface(font);
      paint.setTextLocale(L10n.locale());
      paint.setTextSize(dp(size) * settingInt("textScale") / 100f);
      if (paint.measureText(text) <= width) return text;
      int end = text.length();
      while (end > 0 && paint.measureText(text.substring(0, end) + "…") > width) end--;
      return text.substring(0, end) + "…";
    }

    void drawLabel(Canvas c, JSONObject w, RectF r, JSONObject style, String position) {
      drawLabel(c, w, r, style, position, template(w.optString("label")));
    }

    void drawLabel(
        Canvas c, JSONObject w, RectF r, JSONObject style, String position, String text) {
      if (position.equals("hidden")) return;
      float size = Math.min(style.optInt("textSize", 17), Math.max(9, r.height() / dp(1) * .22f));
      String[] lines = text.split("\n");
      float textScale = settingInt("textScale") / 100f;
      float lineHeight = dp(size * 1.3f * textScale),
          y =
              position.equals("top")
                  ? r.top + dp(size * textScale + 14)
                  : position.equals("center")
                      ? r.centerY()
                          - lineHeight * (lines.length - 1) / 2
                          + dp(size * .35f * textScale)
                      : r.bottom - dp(22) - lineHeight * (lines.length - 1);
      Paint.Align align =
          style.optString("align", "center").equals("left")
              ? Paint.Align.LEFT
              : style.optString("align", "center").equals("right")
                  ? Paint.Align.RIGHT
                  : Paint.Align.CENTER;
      float x =
          align == Paint.Align.LEFT
              ? r.left + dp(16)
              : align == Paint.Align.RIGHT ? r.right - dp(16) : r.centerX();
      Typeface chosen =
          style.optString("font").equals("mono")
              ? Typeface.MONOSPACE
              : style.optString("font").equals("serif") ? Typeface.SERIF : font;
      for (String line : lines) {
        paint.setTextSize(dp(size) * settingInt("textScale") / 100f);
        paint.setTypeface(chosen);
        String fitting = line;
        while (fitting.length() > 1 && paint.measureText(fitting) > r.width() - dp(30))
          fitting = fitting.substring(0, fitting.length() - 1);
        if (!fitting.equals(line) && fitting.length() > 1)
          fitting = fitting.substring(0, fitting.length() - 1) + "…";
        paint.setColor(color(style.optString("textColor", themeValue("text"))));
        paint.setStyle(Paint.Style.FILL);
        paint.setTextAlign(align);
        c.drawText(fitting, x, y, paint);
        y += lineHeight;
      }
    }

    void drawOSAction(Canvas c, JSONObject widget, RectF r, JSONObject style) {
      boolean primary = style.optString("emphasis").equals("primary");
      int ink = color(primary ? "#dfe7f1" : "#94a4b6");
      drawIcon(
          c,
          widget.optString("icon", "tasks"),
          r.left + dp(28),
          r.centerY(),
          dp(20),
          color(primary ? "#9bb8d6" : "#778a9e"));
      RectF title = new RectF(r.left + dp(35), r.top, r.right - dp(24), r.bottom);
      monitorText(
          c,
          template(widget.optString("label")),
          title,
          r.centerY() + dp(5),
          style.optInt("textSize", primary ? 15 : 13),
          ink);
      label(c, "›", r.right - dp(18), r.centerY() + dp(5), 14, color("#6f8399"), Paint.Align.RIGHT);
    }

    void drawOSSummary(Canvas c, JSONObject widget, RectF r, int accent) {
      String type = widget.optString("type");
      int ink = color("#dfe7f1"), muted = color("#8291a3");
      monitorText(c, widget.optString("label"), r, r.top + dp(32), 16, ink);
      if (!osFresh() && !type.equals("notification-feed"))
        label(
            c,
            L10n.text("이전 데이터"),
            r.right - dp(20),
            r.top + dp(32),
            10,
            color("#efbd73"),
            Paint.Align.RIGHT);
      if (type.equals("notification-feed")) {
        JSONArray feed = osNotificationFeed();
        int count = 0;
        for (int i = feed.length() - 1; i >= 0 && count < 2; i--) {
          JSONObject row = feed.optJSONObject(i);
          if (row == null) continue;
          float y = r.top + dp(75 + count * 52);
          monitorText(c, row.optString("title"), r, y, 12, ink);
          monitorText(c, osDate(row.optLong("createdAt"), "M/d HH:mm"), r, y + dp(20), 10, muted);
          count++;
        }
        if (count == 0) monitorText(c, L10n.text("새 알림이 없어요"), r, r.top + dp(83), 12, muted);
        return;
      }
      if (osData() == null) {
        monitorText(c, L10n.text("Jimin OS 연결 대기"), r, r.top + dp(82), 13, muted);
        return;
      }
      if (type.equals("inbox")) {
        JSONObject counts = osData().optJSONObject("counts");
        int requests = counts == null ? -1 : counts.optInt("requests"),
            updates = counts == null ? -1 : counts.optInt("updates");
        monitorNumber(
            c,
            requests < 0 ? "—" : requests + L10n.text("건"),
            r,
            r.top + dp(91),
            requests > 0 ? 30 : 24,
            requests > 0 ? color("#efbd73") : ink);
        monitorText(
            c,
            L10n.text("새 요청 · 업데이트 ") + (updates < 0 ? "—" : updates),
            r,
            r.top + dp(118),
            11,
            muted);
        JSONArray rows = osRows("inbox");
        if (rows.length() > 0)
          monitorText(c, rows.optJSONObject(0).optString("title"), r, r.top + dp(153), 12, ink);
        monitorText(c, L10n.text("업무 요청 확인 ›"), r, r.bottom - dp(19), 11, muted);
        return;
      }
      monitorText(c, L10n.text("예정 일정"), r, r.top + dp(65), 11, muted);
      JSONArray events = osRows("events");
      String today = osDate(hostNow(), "yyyy-MM-dd");
      int shown = 0;
      for (int i = 0; i < events.length() && shown < 3; i++) {
        JSONObject event = events.optJSONObject(i);
        if (event == null || instant(event.optString("endsAt")) < hostNow()) continue;
        long start = instant(event.optString("startsAt"));
        float y = r.top + dp(99 + shown * 44);
        RectF time = new RectF(r.left, r.top, r.left + dp(108), r.bottom),
            title = new RectF(r.left + dp(95), r.top, r.right, r.bottom);
        monitorText(
            c,
            osDate(start, today.equals(osDate(start, "yyyy-MM-dd")) ? "HH:mm" : "M/d HH:mm"),
            time,
            y,
            12,
            muted);
        monitorText(c, event.optString("title"), title, y, 14, ink);
        shown++;
      }
      if (shown == 0) monitorText(c, L10n.text("예정된 일정이 없어요"), r, r.top + dp(101), 13, muted);
      line(
          c,
          r.left + dp(20),
          r.top + dp(222),
          r.right - dp(20),
          r.top + dp(222),
          color("#303d4b"),
          dp(1));
      JSONArray tasks = osRows("tasks");
      monitorText(
          c, L10n.text("할 일 · ") + tasks.length() + L10n.text("개"), r, r.top + dp(253), 11, muted);
      int count = 0;
      for (int i = 0; i < tasks.length() && count < 2; i++) {
        JSONObject task = tasks.optJSONObject(i);
        if (task == null) continue;
        long due = instant(task.optString("dueAt"));
        boolean late = due > 0 && due < hostNow();
        float y = r.top + dp(287 + count * 44);
        monitorText(c, task.optString("title"), r, y, 14, ink);
        monitorText(
            c,
            due == 0
                ? L10n.text("마감 없음")
                : (late ? L10n.text("마감 지남 · ") : "") + osDate(due, "M/d HH:mm"),
            r,
            y + dp(19),
            10,
            late ? color("#efbd73") : muted);
        count++;
      }
      if (count == 0) monitorText(c, L10n.text("남은 할 일이 없어요"), r, r.top + dp(289), 13, muted);
      monitorText(c, L10n.text("일정과 할 일 확인 ›"), r, r.bottom - dp(17), 11, muted);
    }

    void osCalendarTap(JSONObject w, RectF r, float x, float y) {
      if (y < r.top + dp(38)) {
        osMonthOffset = osMonthOffset == 0 ? 1 : 0;
        refresh(w.optString("id"));
        return;
      }
      Calendar date = Calendar.getInstance(TimeZone.getTimeZone("Asia/Seoul"));
      date.setTimeInMillis(hostNow());
      date.add(Calendar.MONTH, osMonthOffset);
      date.set(Calendar.DAY_OF_MONTH, 1);
      float cw = r.width() / 8, ch = (r.height() - dp(72)) / 7;
      int col = Math.round((x - r.left) / cw) - 1, row = Math.round((y - r.top - dp(48)) / ch) - 1;
      int day = row * 7 + col - (date.get(Calendar.DAY_OF_WEEK) - 1) + 1;
      if (col >= 0
          && col < 7
          && row >= 0
          && day >= 1
          && day <= date.getActualMaximum(Calendar.DAY_OF_MONTH)) {
        date.set(Calendar.DAY_OF_MONTH, day);
        osList(w, osDate(date.getTimeInMillis(), "yyyy-MM-dd"));
      }
    }

    void drawIcon(Canvas c, String type, float cx, float cy, float size, int col) {
      c.save();
      c.translate(cx - size / 2, cy - size / 2);
      c.scale(size / 24, size / 24);
      paint.setColor(col);
      paint.setStyle(Paint.Style.STROKE);
      paint.setStrokeWidth(1.8f);
      paint.setStrokeCap(Paint.Cap.ROUND);
      paint.setStrokeJoin(Paint.Join.ROUND);
      Path p = iconPath;
      p.rewind();
      switch (type) {
        case "mic":
          c.drawRoundRect(new RectF(9, 2, 15, 15), 3, 3, paint);
          c.drawArc(new RectF(5, 5, 19, 19), 0, 180, false, paint);
          c.drawLine(5, 10, 5, 12, paint);
          c.drawLine(19, 10, 19, 12, paint);
          c.drawLine(12, 19, 12, 23, paint);
          c.drawLine(8, 23, 16, 23, paint);
          break;
        case "refresh":
          c.drawArc(new RectF(3, 3, 21, 21), 20, 290, false, paint);
          c.drawLine(20, 2, 20, 8, paint);
          c.drawLine(20, 8, 14, 8, paint);
          break;
        case "calendar":
          c.drawRoundRect(new RectF(3, 5, 21, 22), 2, 2, paint);
          c.drawLine(3, 10, 21, 10, paint);
          c.drawLine(8, 2, 8, 8, paint);
          c.drawLine(16, 2, 16, 8, paint);
          break;
        case "clock":
          c.drawCircle(12, 12, 9, paint);
          c.drawLine(12, 6, 12, 12, paint);
          c.drawLine(12, 12, 16, 14, paint);
          break;
        case "bell":
          c.drawArc(new RectF(5, 3, 19, 20), 180, 180, false, paint);
          c.drawLine(5, 11, 5, 18, paint);
          c.drawLine(19, 11, 19, 18, paint);
          c.drawLine(3, 18, 21, 18, paint);
          c.drawArc(new RectF(9, 19, 15, 23), 0, 180, false, paint);
          break;
        case "power":
          c.drawArc(new RectF(3, 3, 21, 21), -52, 284, false, paint);
          c.drawLine(12, 1, 12, 11, paint);
          break;
        case "mail":
          c.drawRoundRect(new RectF(2, 5, 22, 20), 2, 2, paint);
          p.moveTo(2, 6);
          p.lineTo(12, 14);
          p.lineTo(22, 6);
          c.drawPath(p, paint);
          break;
        case "chat":
          p.moveTo(3, 3);
          p.lineTo(21, 3);
          p.lineTo(21, 17);
          p.lineTo(9, 17);
          p.lineTo(3, 22);
          p.close();
          c.drawPath(p, paint);
          break;
        case "spark":
          p.moveTo(14, 1);
          p.lineTo(3, 14);
          p.lineTo(11, 14);
          p.lineTo(10, 23);
          p.lineTo(22, 9);
          p.lineTo(13, 9);
          p.close();
          c.drawPath(p, paint);
          break;
        case "code":
          p.moveTo(7, 5);
          p.lineTo(1, 12);
          p.lineTo(7, 19);
          p.moveTo(17, 5);
          p.lineTo(23, 12);
          p.lineTo(17, 19);
          p.moveTo(14, 2);
          p.lineTo(10, 22);
          c.drawPath(p, paint);
          break;
        case "link":
          c.save();
          c.rotate(-40, 12, 12);
          c.drawRoundRect(new RectF(2, 7, 14, 17), 5, 5, paint);
          c.drawRoundRect(new RectF(10, 7, 22, 17), 5, 5, paint);
          c.restore();
          break;
        case "tasks":
          c.drawRoundRect(new RectF(4, 2, 21, 22), 2, 2, paint);
          for (int i = 0; i < 3; i++) {
            float y = 6 + i * 6;
            c.drawLine(7, y, 9, y + 2, paint);
            c.drawLine(9, y + 2, 12, y - 1, paint);
            c.drawLine(15, y + 1, 18, y + 1, paint);
          }
          break;
        case "globe":
          c.drawCircle(12, 12, 10, paint);
          c.drawOval(new RectF(7, 2, 17, 22), paint);
          c.drawLine(2, 12, 22, 12, paint);
          break;
        case "note":
          c.drawRoundRect(new RectF(4, 2, 20, 22), 2, 2, paint);
          for (int y = 7; y < 20; y += 5) c.drawLine(8, y, 16, y, paint);
          break;
        case "music":
          p.moveTo(8, 19);
          p.lineTo(8, 5);
          p.lineTo(20, 2);
          p.lineTo(20, 16);
          c.drawPath(p, paint);
          c.drawOval(new RectF(2, 16, 8, 22), paint);
          c.drawOval(new RectF(14, 13, 20, 19), paint);
          break;
        case "volume":
          p.moveTo(2, 9);
          p.lineTo(7, 9);
          p.lineTo(12, 4);
          p.lineTo(12, 20);
          p.lineTo(7, 15);
          p.lineTo(2, 15);
          p.close();
          c.drawPath(p, paint);
          c.drawArc(new RectF(8, 4, 23, 20), -65, 130, false, paint);
          break;
        default:
          c.drawRoundRect(new RectF(2, 3, 22, 17), 2, 2, paint);
          c.drawLine(12, 17, 12, 22, paint);
          c.drawLine(7, 22, 17, 22, paint);
      }
      paint.setStyle(Paint.Style.FILL);
      c.restore();
    }

    int hit(float x, float y) {
      if (y < contentTop() || y > getHeight() - contentBottom()) return -1;
      for (int i = 0; i < rects.size(); i++) if (rects.get(i).contains(x, y)) return i;
      return -1;
    }

    float volumeAt(float x, RectF r) {
      return Math.max(0, Math.min(100, (x - r.left - dp(25)) / (r.width() - dp(50)) * 100));
    }

    @Override
    public boolean onTouchEvent(android.view.MotionEvent e) {
      float x = e.getX(), y = e.getY();
      switch (e.getActionMasked()) {
        case MotionEvent.ACTION_DOWN:
          clearVelocity();
          boolean resumeSwipe =
              swipeSettle != null && y > contentTop() && y < getHeight() - contentBottom();
          if (resumeSwipe) {
            swipeSettle.removeAllListeners();
            swipeSettle.cancel();
            swipeSettle = null;
          }
          gestureBlocked =
              !resumeSwipe
                  && (swipeSettle != null || SystemClock.elapsedRealtime() < transitionUntil);
          if (gestureBlocked) return true;
          swipeVelocity = VelocityTracker.obtain();
          swipeVelocity.addMovement(e);
          downX = x;
          downY = y;
          lastY = y;
          downAt = System.currentTimeMillis();
          moved = resumeSwipe;
          touchAxis = resumeSwipe ? 1 : 0;
          dragStartOffset =
              resumeSwipe
                  ? SwipePhysics.distance(swipeOffset, getWidth(), swipePreview != null)
                  : 0;
          downIndex = resumeSwipe ? -1 : hit(x, y);
          if (downIndex >= 0) {
            Tile tile = tiles.get(downIndex);
            tile.animate().cancel();
            if (!reducedMotion()) {
              tile.setScaleX(.985f);
              tile.setScaleY(.985f);
            }
          }
          if (downIndex >= 0
              && (widgets.get(downIndex).optString("type").equals("volume")
                  || widgets.get(downIndex).optString("type").equals("slider"))) {
            dragVolume = volumeAt(x, rects.get(downIndex));
            tiles.get(downIndex).invalidate();
          }
          return true;
        case MotionEvent.ACTION_MOVE:
          if (gestureBlocked) return true;
          if (swipeVelocity != null) swipeVelocity.addMovement(e);
          if (Math.abs(x - downX) + Math.abs(y - downY) > dp(10)) {
            if (!moved) releasePress();
            moved = true;
            if (touchAxis == 0)
              touchAxis = Math.abs(x - downX) > Math.abs(y - downY) * 1.3f ? 1 : 2;
          }
          if (dragVolume >= 0 && downIndex >= 0) dragVolume = volumeAt(x, rects.get(downIndex));
          else if (settingBool("swipeEnabled")
              && touchAxis == 1
              && downY > contentTop()
              && downY < getHeight() - contentBottom()) dragPage(dragStartOffset + x - downX);
          else if (touchAxis == 2 && maxScroll > 0) {
            scroll = Math.max(0, Math.min(maxScroll, scroll + lastY - y));
            requestLayout();
          }
          lastY = y;
          if (downIndex >= 0 && dragVolume >= 0) tiles.get(downIndex).invalidate();
          return true;
        case MotionEvent.ACTION_POINTER_DOWN:
          gestureBlocked = true;
          clearVelocity();
          if (swiping && swipeSettle == null) settleSwipe(false, 0);
          moved = true;
          touchAxis = 2;
          dragVolume = -1;
          releasePress();
          return true;
        case MotionEvent.ACTION_CANCEL:
          clearVelocity();
          if (swiping && swipeSettle == null) settleSwipe(false, 0);
          releasePress();
          dragVolume = -1;
          invalidate();
          return true;
        case MotionEvent.ACTION_UP:
          if (gestureBlocked) {
            clearVelocity();
            return true;
          }
          float velocity = 0;
          if (swipeVelocity != null) {
            swipeVelocity.addMovement(e);
            swipeVelocity.computeCurrentVelocity(1000, dp(8000));
            velocity = swipeVelocity.getXVelocity();
          }
          clearVelocity();
          releasePress();
          if (swiping) {
            dragPage(dragStartOffset + x - downX);
            settleSwipe(true, velocity);
            return true;
          }
          try {
            if (dragVolume >= 0) {
              int value = Math.round(dragVolume);
              dragVolume = -1;
              JSONObject w = widgets.get(downIndex);
              if (w.optString("type").equals("volume")) {
                state.put("volume", value);
                action(new JSONObject().put("kind", "volume").put("value", value));
              } else {
                double actual =
                    w.optDouble("min", 0)
                        + (w.optDouble("max", 100) - w.optDouble("min", 0)) * value / 100.0;
                action(
                    new JSONObject()
                        .put("kind", "control")
                        .put("id", w.getString("id"))
                        .put("value", actual));
              }
              if (downIndex >= 0) tiles.get(downIndex).invalidate();
              return true;
            }
            if (moved) return true;
            if (SystemClock.elapsedRealtime() < transitionUntil) return true;
            if (!settingBool("settingsButtonHidden") && y < dp(60) && x > getWidth() - dp(75)) {
              settings();
              return true;
            }
            if (settingBool("showNavigation") && y > getHeight() - dp(46)) {
              JSONArray ps = config.optJSONArray("pages");
              for (int i = 0; i < pageRects.size(); i++)
                if (pageRects.get(i).contains(x, y)) {
                  if (ps.length() > 6) {
                    String[] names = new String[ps.length()];
                    for (int j = 0; j < ps.length(); j++)
                      names[j] = ps.optJSONObject(j).optString("name");
                    new AlertDialog.Builder(L10n.context(MainActivity.this))
                        .setTitle(L10n.text("페이지 이동"))
                        .setItems(
                            names, (d, index) -> navigate(ps.optJSONObject(index).optString("id")))
                        .setNegativeButton(L10n.text("닫기"), null)
                        .show();
                  } else navigate(ps.getJSONObject(i).getString("id"));
                }
              return true;
            }
            if (downIndex < 0 || downIndex != hit(x, y)) return true;
            JSONObject w = widgets.get(downIndex);
            String type = w.optString("type");
            if (type.equals("calendar") && w.optString("provider").equals("jimin-os"))
              osCalendarTap(w, rects.get(downIndex), x, y);
            else if (type.equals("agenda")
                || type.equals("inbox")
                || type.equals("notification-feed")) osList(w, null);
            else if (type.equals("button"))
              dispatchButton(w, System.currentTimeMillis() - downAt > 650 ? "long" : "tap");
            else if (type.equals("page")) navigate(w.optString("targetPage"));
            else if (type.equals("system")) systemDetails(w);
            else if (type.equals("grafana")) {
              if ((!w.optString("metric").equals("system")
                      && y > rects.get(downIndex).bottom - dp(51))
                  || System.currentTimeMillis() - downAt > 650) grafanaChoose(w);
              else grafanaDetails(w);
            } else if (type.equals("todo")) todoDialog(w);
            else if (type.equals("toggle"))
              action(
                  new JSONObject()
                      .put("kind", "control")
                      .put("id", w.getString("id"))
                      .put("value", !Boolean.TRUE.equals(variable(w.optString("binding")))));
            else if (type.equals("timer"))
              action(
                  new JSONObject()
                      .put("id", w.getString("id"))
                      .put("kind", "timer")
                      .put("gesture", System.currentTimeMillis() - downAt > 650 ? "reset" : "tap"));
            performClick();
          } catch (JSONException ignored) {
          }
          return true;
      }
      return super.onTouchEvent(e);
    }

    void releasePress() {
      if (downIndex >= 0 && downIndex < tiles.size())
        tiles
            .get(downIndex)
            .animate()
            .scaleX(1f)
            .scaleY(1f)
            .setDuration(reducedMotion() ? 0 : 90)
            .start();
    }

    @Override
    public boolean performClick() {
      super.performClick();
      return true;
    }
  }
}
