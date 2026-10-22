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
  private long serverTime = 0, receivedAt = 0;
  private String renderedConfig = "";
  private final Set<String> runningIds = new HashSet<>();
  private volatile boolean stopped = false, connected = false;
  private boolean foreground = false;
  private volatile HttpURLConnection eventConnection;
  private volatile String token = "", base = "http://127.0.0.1:8840";
  private String pageId = "";
  private volatile String wifiPin = "", transport = "auto";
  private volatile List<String> wifiUrls = new ArrayList<>();
  private volatile int connectionRevision = 0;
  private String connectionError = "";
  private long lastWifiProbe = -15000;
  private volatile JSONObject config = new JSONObject(), state = new JSONObject();
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
  private PopupWindow monitorBanner;
  private final Map<String, Long> lastErrors = new HashMap<>();
  private final Runnable tick =
      new Runnable() {
        public void run() {
          if (deck != null && hasWindowFocus()) deck.tick();
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
    pageId = prefs.getString("page", "");
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
            "jimin-os", "Jimin OS 일정과 업무", NotificationManager.IMPORTANCE_DEFAULT);
    channel.setDescription("일정 시작, 할 일 마감, 새 업무 요청을 알려드려요.");
    channel.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
    notificationManager.createNotificationChannel(channel);
    NotificationChannel monitorChannel =
        new NotificationChannel(
            "monitor-alerts", "시스템·DB 임계치 알림", NotificationManager.IMPORTANCE_HIGH);
    monitorChannel.setDescription("주의·위험 임계치 초과와 정상 복구를 알려드려요.");
    monitorChannel.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
    notificationManager.createNotificationChannel(monitorChannel);
    token = readToken();
    immersive();
    if (prefs.getBoolean("awake", true))
      getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    if (token.isEmpty()) pairScreen();
    else showDeck();
    ui.post(tick);
    if (getIntent().getBooleanExtra("openOS", false)) pageId = "jimin-os-page";
  }

  @Override
  public void onResume() {
    super.onResume();
    foreground = true;
    if (deck != null) {
      deck.rebuild();
      deck.updateState();
    }
  }

  @Override
  public void onPause() {
    foreground = false;
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
      formatter = new SimpleDateFormat(pattern, Locale.KOREA);
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
    close.setContentDescription("모니터 알림 닫기");
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
        if (foreground && shown == 0) showMonitorBanner(n, open);
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
    return String.format(Locale.KOREA, value >= 100 ? "%.0f %s" : "%.1f %s", value, units[i]);
  }

  private double metric(JSONObject data, String key) {
    return data == null || data.isNull(key) ? Double.NaN : data.optDouble(key, Double.NaN);
  }

  private String metricPercent(double value) {
    return Double.isFinite(value) ? String.format(Locale.KOREA, "%.1f%%", value) : "—";
  }

  private String pressureText(String value) {
    return value.equals("normal")
        ? "정상"
        : value.equals("warning") ? "주의" : value.equals("critical") ? "높음" : "확인 중";
  }

  private String thermalText(String value) {
    return value.equals("normal")
        ? "정상"
        : value.equals("fair")
            ? "약간 높음"
            : value.equals("serious") ? "높음" : value.equals("critical") ? "매우 높음" : "확인 중";
  }

  private List<String> systemWarnings(JSONObject data) {
    List<String> warnings = new ArrayList<>();
    JSONObject mem = data.optJSONObject("memory"),
        disk = data.optJSONObject("disk"),
        power = data.optJSONObject("power");
    if (mem != null
        && (mem.optString("pressure").equals("warning")
            || mem.optString("pressure").equals("critical")))
      warnings.add("메모리 압력 " + pressureText(mem.optString("pressure")));
    double available = metric(disk, "availableBytes"), total = metric(disk, "totalBytes");
    if (Double.isFinite(available)
        && (available < 20d * 1024 * 1024 * 1024 || available / total < .05))
      warnings.add("저장 공간 여유 " + metricBytes(available));
    if (power != null
        && (power.optString("thermal").equals("serious")
            || power.optString("thermal").equals("critical")))
      warnings.add("발열 부담 " + thermalText(power.optString("thermal")));
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
      body.append(data.optString("model", "내 Mac"))
          .append(" · ")
          .append(data.optInt("logicalCores"))
          .append("코어\n");
      List<String> alerts = systemWarnings(data);
      body.append(alerts.isEmpty() ? "확인할 상태가 없어요." : String.join("\n", alerts)).append("\n\n");
    }
    if (kind.equals("cpu") || kind.equals("overview")) {
      body.append("전체 CPU  ").append(metricPercent(metric(cpu, "percent"))).append("\n");
      JSONArray cores = cpu == null ? null : cpu.optJSONArray("cores");
      if (cores != null)
        for (int i = 0; i < cores.length(); i++)
          body.append("코어 ")
              .append(i + 1)
              .append("  ")
              .append(metricPercent(cores.optDouble(i, Double.NaN)))
              .append(i % 2 == 0 ? "     " : "\n");
      body.append("\n");
    }
    if (kind.equals("memory") || kind.equals("overview")) {
      body.append("메모리  ")
          .append(metricGiB(metric(memory, "usedBytes")))
          .append(" / ")
          .append(metricGiB(metric(memory, "totalBytes")))
          .append(" · ")
          .append(
              metricPercent(
                  metric(memory, "totalBytes") > 0
                      ? 100 * metric(memory, "usedBytes") / metric(memory, "totalBytes")
                      : Double.NaN))
          .append("\n압력  ")
          .append(pressureText(memory == null ? "" : memory.optString("pressure")))
          .append("\n앱  ")
          .append(metricBytes(metric(memory, "appBytes")))
          .append("\n시스템 고정  ")
          .append(metricBytes(metric(memory, "wiredBytes")))
          .append("\n압축  ")
          .append(metricBytes(metric(memory, "compressedBytes")))
          .append("\n스왑  ")
          .append(metricBytes(metric(memory, "swapBytes")))
          .append("\n\n");
    }
    if (kind.equals("disk") || kind.equals("overview")) {
      body.append("내장 저장 공간  ")
          .append(metricBytes(metric(disk, "totalBytes")))
          .append("\n사용 가능  ")
          .append(metricBytes(metric(disk, "availableBytes")))
          .append("\n읽기  ")
          .append(metricBytes(metric(io, "readBytesPerSecond")))
          .append("/s\n쓰기  ")
          .append(metricBytes(metric(io, "writeBytesPerSecond")))
          .append("/s\nAPFS 공유 공간 기준 · I/O는 전체 저장 장치 합계\n\n");
    }
    if (kind.equals("network") || kind.equals("overview")) {
      body.append("네트워크 수신  ")
          .append(metricBytes(metric(network, "rxBytesPerSecond")))
          .append("/s\n송신  ")
          .append(metricBytes(metric(network, "txBytesPerSecond")))
          .append("/s\n활성 유선·Wi-Fi 인터페이스 합계 (VPN 중복 제외)\n\n");
    }
    if (kind.equals("power") || kind.equals("overview")) {
      body.append("배터리  ")
          .append(metricPercent(metric(power, "batteryPercent")))
          .append("\n전원  ")
          .append(power != null && power.optBoolean("pluggedIn") ? "전원 연결됨" : "배터리 사용 중")
          .append("\n발열 부담  ")
          .append(thermalText(power == null ? "" : power.optString("thermal")))
          .append("\n");
    }
    return body.toString();
  }

  private void systemDetails(JSONObject widget) {
    JSONObject data = macSystem();
    if (data == null) {
      osDialog()
          .setTitle("맥 상태 연결 대기")
          .setMessage("맥의 최신 상태를 기다리고 있어요.")
          .setPositiveButton("닫기", null)
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
        .setTitle(widget.optString("label", "맥 상태"))
        .setView(scroll)
        .setPositiveButton("닫기", null)
        .show();
  }

  private void systemTabs(JSONObject widget) {
    String[] names = {"CPU", "메모리", "저장 공간", "전원·발열", "네트워크"};
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
                  ? "맥 연결과 최신 상태를 기다리고 있어요."
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
      b.setContentDescription(names[i] + " 상세 탭");
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
            .setTitle(widget.optString("label", "내 Mac") + " · 상세")
            .setView(layout)
            .setPositiveButton("닫기", null)
            .setNeutralButton(
                "앱별 사용량",
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
      setContentDescription("맥 상태 실시간 추이 그래프");
    }

    void text(Canvas c, String value, float x, float y, float size, int color, Paint.Align align) {
      p.setStyle(Paint.Style.FILL);
      p.setColor(color);
      p.setTypeface(font);
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
          title = "CPU 추이",
          legend = "전체 CPU";
      boolean percent = true;
      int accent = Color.parseColor("#86b6ef"),
          other = Color.parseColor("#83cbb9"),
          muted = Color.parseColor("#9bafbd");
      if (kind.equals("memory")) {
        first = "memory";
        title = "메모리 사용률";
        legend = "물리 메모리 대비";
        accent = Color.parseColor("#b6a6ec");
      } else if (kind.equals("disk")) {
        first = "read";
        second = "write";
        title = "디스크 I/O 추이";
        legend = "읽기";
        percent = false;
        other = Color.parseColor("#efbd73");
      } else if (kind.equals("network")) {
        first = "rx";
        second = "tx";
        title = "네트워크 추이";
        legend = "수신";
        percent = false;
      } else if (kind.equals("power")) {
        first = "battery";
        title = "배터리 추이";
        legend = "배터리 잔량";
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
            kind.equals("disk") ? "쓰기" : "송신",
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
            percent ? String.format(Locale.KOREA, "%.0f%%", value) : metricBytes(value) + "/s",
            plot.left - dp(8),
            y + dp(3),
            8,
            muted,
            Paint.Align.RIGHT);
      }
      if (a == null || a.length() < 2)
        text(c, "추이 수집 중", plot.centerX(), plot.centerY(), 12, muted, Paint.Align.CENTER);
      else {
        curve(c, a, max, accent);
        curve(c, b, max, other);
      }
      text(c, "이전", plot.left, getHeight() - dp(17), 9, muted, Paint.Align.LEFT);
      text(c, "지금 · 2초 갱신", plot.right, getHeight() - dp(17), 9, muted, Paint.Align.RIGHT);
    }
  }

  private class GrafanaHistoryView extends MacHistoryView {
    final JSONObject widget;
    String chartMetric;

    GrafanaHistoryView(JSONObject widget) {
      super(new int[] {0}, new String[] {"cpu"});
      this.widget = widget;
      chartMetric = widget.optString("metric").equals("system") ? "system" : "tps";
      setContentDescription("Grafana 최근 1시간 추이 그래프");
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
              ? "시스템 CPU 추이"
              : chartMetric.equals("cpu")
                  ? "DB CPU 추이"
                  : chartMetric.equals("memory")
                      ? "DB 메모리 추이"
                      : chartMetric.equals("qps") ? "QPS · 쿼리/초" : "TPS · 커밋/초",
          dp(16),
          dp(29),
          14,
          Color.parseColor("#d9f4fa"),
          Paint.Align.LEFT);
      text(c, "최근 1시간", dp(16), dp(50), 10, muted, Paint.Align.LEFT);
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
            String.format(Locale.KOREA, percent ? "%.0f%%" : "%.1f", max * (2 - i) / 2),
            plot.left - dp(6),
            y + dp(3),
            9,
            muted,
            Paint.Align.RIGHT);
      }
      if (points == null || points.length() < 2)
        text(c, "수집 데이터 없음", plot.centerX(), plot.centerY(), 12, muted, Paint.Align.CENTER);
      else if (deck != null) deck.grafanaTrend(c, points, plot, accent, percent);
      text(c, "이전", plot.left, getHeight() - dp(16), 9, muted, Paint.Align.LEFT);
      text(c, "최근", plot.right, getHeight() - dp(16), 9, muted, Paint.Align.RIGHT);
    }
  }

  private void systemProcesses(JSONObject data, boolean memoryOrder) {
    JSONObject processes = data.optJSONObject("processes");
    JSONArray rows =
        processes == null ? null : processes.optJSONArray(memoryOrder ? "memory" : "cpu");
    StringBuilder body =
        new StringBuilder("CPU 100%는 1코어 사용량이에요. 약 6초 간격으로 비교하며 메모리는 앱의 물리적 사용량을 보여줘요.\n\n");
    if (rows != null)
      for (int i = 0; i < rows.length(); i++) {
        JSONObject row = rows.optJSONObject(i);
        if (row == null) continue;
        body.append(row.optString("name"))
            .append("  (PID ")
            .append(row.optInt("pid"))
            .append(")\nCPU ")
            .append(metricPercent(metric(row, "cpuPercent")))
            .append(" · 메모리 ")
            .append(metricBytes(metric(row, "memoryBytes")))
            .append("\n\n");
      }
    if (rows == null || rows.length() == 0) body.append("사용량을 비교하고 있어요. 잠시 후 다시 확인해 주세요.");
    osDialog()
        .setTitle(memoryOrder ? "메모리를 많이 쓰는 앱" : "CPU를 많이 쓰는 앱")
        .setMessage(body.toString())
        .setPositiveButton(
            memoryOrder ? "CPU 순으로" : "메모리 순으로",
            (d, x) -> {
              JSONObject latest = macSystem();
              if (latest != null) systemProcesses(latest, !memoryOrder);
            })
        .setNegativeButton("닫기", null)
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
        .setTitle("Grafana 프로젝트")
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
        .setNegativeButton("닫기", null)
        .show();
  }

  private JSONObject grafanaData(JSONObject widget) {
    JSONObject all = state.optJSONObject("grafana");
    JSONObject widgets = all == null ? null : all.optJSONObject("widgets");
    JSONObject entry = widgets == null ? null : widgets.optJSONObject(widget.optString("id"));
    JSONObject projects = entry == null ? null : entry.optJSONObject("projects");
    JSONObject data =
        projects == null ? null : projects.optJSONObject(grafanaProject(widget).optString("value"));
    if (data != null
        && data.optString("status").equals("ready")
        && hostNow() - data.optLong("capturedAt") > 90000) return null;
    return data;
  }

  private String metricGiB(double value) {
    return Double.isFinite(value) && value >= 0
        ? String.format(Locale.KOREA, "%.1f GiB", value / 1073741824d)
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
            : level.equals("warning") ? "#efbd73" : level.equals("normal") ? "#83cbb9" : "#9bafbd");
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

  private String grafanaNumber(JSONObject data, String key, boolean percent) {
    double value = metric(data == null ? null : data.optJSONObject(key), "value");
    return percent
        ? metricPercent(value)
        : Double.isFinite(value) ? String.format(Locale.KOREA, "%,.2f", value) : "—";
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
            firstRow, system ? "시스템 CPU" : "DB CPU", system ? "서비스 보고값 중 최대" : "노드 최대 · 할당 한도 대비");
    values[1] =
        grafanaStat(firstRow, system ? "수집 정상" : "TPS", system ? "정상 대상 / 전체 대상" : "커밋/초 · 5분 평균");
    values[2] =
        grafanaStat(
            firstRow, system ? "보고 서비스" : "QPS", system ? "CPU 보고 job 수" : "쿼리/초 · 전체 노드 합계");
    if (!system) {
      LinearLayout secondRow = new LinearLayout(this);
      layout.addView(secondRow);
      values[3] = grafanaStat(secondRow, "연결 수", "전체 노드의 현재 연결 합계");
      values[4] = grafanaStat(secondRow, "DB 메모리", "노드 최대 · 할당 한도 대비");
      values[5] = grafanaStat(secondRow, "DB 상태", "준비 상태 · 수집 대상 확인");
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
      String[] labels = {"TPS", "QPS", "CPU", "메모리"};
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
        button.setContentDescription("Grafana " + labels[i] + " 그래프");
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
        button.setAlpha(i == 0 ? 1f : .5f);
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
          String signature = String.valueOf(data);
          if (signature.equals(last[0])) return;
          last[0] = signature;
          nodes.removeAllViews();
          boolean ready = data != null && data.optString("status").equals("ready");
          for (TextView value : values) value.setText("—");
          if (!ready) {
            updated.setText(
                data == null
                    ? "맥에서 Grafana 연결을 확인해 주세요."
                    : data.optString("message", "지표를 조회하고 있어요."));
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
                services == null || services.length() == 0 ? "—" : services.length() + "개");
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
                    ? String.format(Locale.KOREA, "%,.0f", connections)
                    : "—");
            values[4].setText(grafanaNumber(data, "memory", true));
            ((TextView) values[4].getTag())
                .setText(
                    metricGiB(metric(data.optJSONObject("memory"), "usedBytes")) + " 사용 · 노드 최대");
            values[5].setText(
                database == null || database.isNull("ready")
                    ? "확인 불가"
                    : database.optBoolean("ready") ? "정상" : "확인 필요");
          }
          TextView nodeTitle = new TextView(this);
          nodeTitle.setText(system ? "서비스별 시스템 CPU" : "노드별 DB CPU");
          nodeTitle.setTextSize(12);
          nodeTitle.setIncludeFontPadding(false);
          nodes.addView(nodeTitle);
          JSONArray rows = cpu == null ? null : cpu.optJSONArray("nodes");
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
              value.setText(metricPercent(metric(row, "value")));
              value.setTextSize(22);
              value.setIncludeFontPadding(false);
              value.setTypeface(font, android.graphics.Typeface.BOLD);
              nodes.addView(value);
              styleOSText(name);
              styleOSText(value);
              value.setTextColor(monitorValueColor(widget, "cpu", metric(row, "value")));
            }
          styleOSText(nodeTitle);
          updated.setText(
              "조회 "
                  + osDate(data.optLong("capturedAt"), "HH:mm:ss")
                  + " · 30초 갱신 · 최근 1시간 추이"
                  + (system ? " · 수집 성공 기준" : " · TPS는 Galera 로컬 커밋, QPS는 Questions 기준"));
          graph.invalidate();
        };
    AlertDialog dialog =
        osDialog()
            .setTitle(
                grafanaProject(widget).optString("label", "프로젝트")
                    + " · "
                    + widget.optString("label", system ? "시스템 상태" : "DB 상태"))
            .setView(layout)
            .setPositiveButton("프로젝트 변경", (d, x) -> grafanaChoose(widget))
            .setNegativeButton("닫기", null)
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
    return new AlertDialog.Builder(this) {
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

  private void osList(JSONObject widget, String day) {
    String type = widget.optString("type");
    if (type.equals("inbox")) {
      osAction(widget, "navigate", null);
      return;
    }
    if (type.equals("notification-feed")) {
      JSONArray feed = state.optJSONArray("notifications");
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
          .setTitle("Jimin OS 알림")
          .setMessage(text.length() == 0 ? "새 알림이 없어요." : text.toString())
          .setPositiveButton("닫기", null)
          .show();
      return;
    }
    if (osData() == null) {
      osDialog()
          .setTitle("Jimin OS 연결 대기")
          .setMessage("맥에서 Jimin OS 앱을 열고 로그인 상태를 확인해 주세요.")
          .setPositiveButton("확인", null)
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
          "할 일 · "
              + (due == 0 ? "마감 없음" : osDate(due, "M/d HH:mm"))
              + "  "
              + task.optString("title"));
    }
    AlertDialog.Builder dialog =
        osDialog()
            .setTitle(tasksOnly ? "할 일" : day == null ? "다가오는 일정" : day + " 일정")
            .setNegativeButton("닫기", null);
    if (!tasksOnly && osCan("scheduleCreate"))
      dialog.setPositiveButton("일정 추가", (a, b) -> osCreateSchedule(widget, day));
    if (items.isEmpty()) dialog.setMessage("등록된 일정이 없어요.");
    else
      dialog.setItems(
          labels.toArray(new String[0]),
          (d, index) -> {
            JSONObject e = items.get(index);
            AlertDialog.Builder detail =
                osDialog()
                    .setTitle(e.optString("title"))
                    .setMessage(
                        e.has("startsAt")
                            ? osDate(instant(e.optString("startsAt")), "M월 d일 EEEE HH:mm")
                                + " – "
                                + osDate(instant(e.optString("endsAt")), "M/d HH:mm")
                            : "마감 · "
                                + (instant(e.optString("dueAt")) == 0
                                    ? "없음"
                                    : osDate(instant(e.optString("dueAt")), "M월 d일 EEEE HH:mm")))
                    .setNeutralButton(
                        "맥에서 열기",
                        (a, b) ->
                            osAction(
                                widget,
                                e.has("startsAt") ? "open-schedule" : "open-task",
                                e.optString("id")))
                    .setNegativeButton("닫기", null);
            if (!e.has("startsAt") && osCan("taskComplete") && e.optInt("version") > 0)
              detail.setPositiveButton("완료하기", (a, b) -> osCompleteTask(widget, e));
            detail.show();
          });
    dialog.show();
  }

  private boolean osCan(String capability) {
    JSONObject data = osData();
    JSONObject caps = data == null ? null : data.optJSONObject("capabilities");
    return connected && caps != null && caps.optBoolean(capability);
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
            this,
            (picker, year, month, day) -> {
              new TimePickerDialog(
                      this,
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
              : "할 일 완료 요청");
      TextView status = osText(form, "이전 요청의 처리 결과를 확인해 주세요. 다시 시도해도 같은 요청으로 확인해 중복 저장을 막아요.");
      AlertDialog dialog =
          osDialog()
              .setTitle("처리 결과 확인")
              .setView(osScroll(form))
              .setPositiveButton("상태 확인", null)
              .setNeutralButton("같은 요청 재시도", null)
              .setNegativeButton("닫기", null)
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
          .setTitle("일정 추가 연결 대기")
          .setMessage("맥의 Jimin OS와 Open Deck을 최신 버전으로 열고 연결을 확인해 주세요.")
          .setPositiveButton("확인", null)
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
    osText(form, "Jimin OS 캘린더에 저장해요. 시간은 한국 표준시예요.");
    EditText title = osField(form, "일정 제목", 160, false);
    osText(form, "시작");
    Button from = new Button(this);
    from.setText(osDate(start.getTimeInMillis(), "M월 d일 EEEE HH:mm"));
    form.addView(from);
    from.setOnClickListener(v -> osPickTime(start, from));
    osText(form, "종료");
    Button to = new Button(this);
    to.setText(osDate(end.getTimeInMillis(), "M월 d일 EEEE HH:mm"));
    form.addView(to);
    to.setOnClickListener(v -> osPickTime(end, to));
    EditText notes = osField(form, "메모 (선택)", 2000, true);
    TextView status = osText(form, "");
    AlertDialog dialog =
        osDialog()
            .setTitle("일정 추가")
            .setView(osScroll(form))
            .setPositiveButton("저장", null)
            .setNeutralButton("같은 요청 재시도", null)
            .setNegativeButton("닫기", null)
            .show();
    dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setVisibility(View.GONE);
    dialog
        .getButton(AlertDialog.BUTTON_POSITIVE)
        .setOnClickListener(
            v -> {
              if (title.getText().toString().trim().isEmpty()) {
                title.setError("제목을 입력해 주세요.");
                return;
              }
              if (end.getTimeInMillis() <= start.getTimeInMillis()) {
                status.setText("종료 시간을 시작 시간 뒤로 설정해 주세요.");
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
        form, "완료하면 Jimin OS와 연결된 업무에도 반영돼요. 답글을 쓰면 일감에 저장하고, Google Chat에서 받은 일감은 원래 대화에도 전달해요.");
    EditText note = osField(form, "완료 답글 (선택)", 2000, true);
    TextView status = osText(form, "");
    AlertDialog dialog =
        osDialog()
            .setTitle("할 일 완료")
            .setView(osScroll(form))
            .setPositiveButton("완료하기", null)
            .setNeutralButton("같은 요청 재시도", null)
            .setNegativeButton("닫기", null)
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
      controls(false, "처리 확인 중…", false);
      status.setText(post ? "Jimin OS에 저장하고 있어요…" : "저장 결과를 확인하고 있어요…");
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
                      status.setText("결과를 아직 확인하지 못했어요. 상태를 확인하거나 같은 요청을 다시 시도해 주세요.");
                      controls(true, "상태 확인", true);
                    });
              }
            });
      } catch (RejectedExecutionException e) {
        busy = false;
        status.setText("다른 요청이 진행 중이에요. 잠시 후 상태를 확인해 주세요.");
        controls(true, "상태 확인", true);
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
                    ? "일정을 저장했어요."
                    : receipt.optBoolean("alreadyCompleted") ? "이미 완료된 할 일이에요." : "할 일을 완료했어요.",
                Toast.LENGTH_SHORT)
            .show();
      } else if (value.equals("failed")) {
        prefs.edit().remove("pendingOSMutation").apply();
        String code = receipt.optString("error");
        status.setText(
            code.equals("CONFLICT")
                ? "다른 곳에서 변경된 할 일이에요. 닫고 최신 목록에서 다시 확인해 주세요."
                : code.equals("AUTH_REQUIRED")
                    ? "맥의 Jimin OS에서 로그인을 확인해 주세요."
                    : "저장하지 못했어요. 닫고 내용을 확인한 뒤 다시 시도해 주세요.");
        controls(true, "닫기", false);
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> dialog.dismiss());
      } else if (value.equals("running")) {
        status.setText("Jimin OS에서 처리 중이에요. 이 창을 닫아도 다음 요청 때 결과를 확인할 수 있어요.");
        controls(true, "상태 확인", false);
        if (++polls < 30 && dialog.isShowing())
          ui.postDelayed(
              () -> {
                if (dialog.isShowing()) check();
              },
              1000);
      } else {
        status.setText("저장 여부를 확인해야 해요. 같은 요청을 다시 시도하면 중복 여부를 먼저 확인해요.");
        controls(true, "상태 확인", true);
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
    stopped = true;
    connected = false;
    disconnectEvents();
    if (events != null) events.interrupt();
    commands.shutdownNow();
    images.shutdownNow();
    ui.removeCallbacks(tick);
    super.onDestroy();
  }

  @Override
  public void onConfigurationChanged(android.content.res.Configuration c) {
    super.onConfigurationChanged(c);
    if (deck != null) deck.requestLayout();
  }

  private void immersive() {
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
    base = "http://127.0.0.1:8840";
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
    TextView title = text("내 책상과 연결하기", 28, Color.WHITE);
    title.setPadding(0, (int) dp(25), 0, (int) dp(12));
    card.addView(title);
    TextView help =
        text(
            "최초 등록은 USB로 맥에 연결하고 Open Deck 앱을 실행하세요.\n6자리 코드로 등록하면 같은 Wi-Fi에서 무선으로 사용할 수 있습니다.",
            14,
            color("#9caec9"));
    help.setLineSpacing(dp(5), 1);
    card.addView(help);
    EditText code = new EditText(this);
    code.setHint("6자리 페어링 코드");
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
    connect.setText("연결하기");
    card.addView(connect, new LinearLayout.LayoutParams(-1, (int) dp(52)));
    connect.setOnClickListener(
        v -> {
          String pin = code.getText().toString().trim();
          if (!pin.matches("[0-9]{6}")) {
            error.setText("6자리 코드를 입력하세요.");
            return;
          }
          connect.setEnabled(false);
          error.setText("연결 중…");
          commands.execute(
              () -> {
                try {
                  JSONObject request =
                      new JSONObject()
                          .put("pin", pin)
                          .put("name", Build.MANUFACTURER + " " + Build.MODEL);
                  JSONObject r = request("/api/pair", "POST", request, false);
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
                        error.setText("연결하지 못했습니다. USB와 맥 앱, 페어링 코드를 확인하세요.\n" + e.getMessage());
                      });
                }
              });
        });
    TextView note = text("계정 없이 · 구독 없이 · 내 기기에서만", 12, color("#7185a7"));
    note.setPadding(0, (int) dp(22), 0, 0);
    card.addView(note);
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
    HttpURLConnection c = PinnedConnection.open(base + route, wifiPin);
    c.setConnectTimeout(2200);
    c.setReadTimeout(12000);
    c.setRequestMethod(method);
    if (auth) c.setRequestProperty("Authorization", "Bearer " + token);
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
      if (status >= 400) throw new IOException(data.optString("error", "HTTP " + status));
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
      if (out.size() + n > 524288) throw new IOException("응답이 너무 큽니다.");
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
      boolean switchToWifi = false;
      HttpURLConnection c = null;
      try {
        c = PinnedConnection.open(base + "/api/events", wifiPin);
        eventConnection = c;
        c.setConnectTimeout(2500);
        c.setReadTimeout(6000);
        c.setRequestProperty("Authorization", "Bearer " + token);
        if (c.getResponseCode() == 401) {
          token = "";
          prefs.edit().remove("token").apply();
          ui.post(this::pairScreen);
          return;
        }
        if (c.getResponseCode() != 200) throw new IOException("Host unavailable");
        connected = true;
        connectionError = "";
        delay = 1000;
        ui.post(
            () -> {
              if (deck != null) deck.invalidate();
            });
        try (BufferedReader reader =
            new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8))) {
          String line;
          while (!stopped && (line = reader.readLine()) != null) {
            if (line.startsWith("data: ")) {
              JSONObject snapshot = new JSONObject(line.substring(6));
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
                    boolean changed = cfg != null && !renderedConfig.equals(configJson);
                    if (cfg != null) config = cfg;
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
        connectionError = e.getMessage() == null ? "연결할 수 없습니다." : e.getMessage();
        if (!stopped) {
          connected = false;
          ui.post(
              () -> {
                if (deck != null) deck.invalidate();
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
        probe = PinnedConnection.open(wifiUrls.get(i) + "/health", wifiPin);
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
    if (!"usb".equals(transport) && !wifiPin.isEmpty()) urls.addAll(wifiUrls);
    if (!"wifi".equals(transport) || urls.isEmpty()) urls.add("http://127.0.0.1:8840");
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
    try {
      URI u = new URI(value);
      return "https".equals(u.getScheme())
          && u.getUserInfo() == null
          && u.getQuery() == null
          && u.getFragment() == null
          && (u.getPath() == null || u.getPath().isEmpty())
          && u.getPort() == 8841
          && u.getHost() != null
          && u.getHost().matches("(?:10\\.|192\\.168\\.|172\\.(?:1[6-9]|2[0-9]|3[01])\\.)[0-9.]+");
    } catch (Exception e) {
      return false;
    }
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
        "wifi".equals(transport) ? "Wi-Fi" : "usb".equals(transport) ? "USB" : "자동 (Wi-Fi 우선)";
    new AlertDialog.Builder(this)
        .setTitle("연결: " + mode)
        .setItems(
            new String[] {
              "자동: Wi-Fi 우선 · USB 대체", "Wi-Fi로만 연결", "USB로만 연결", "맥 Wi-Fi 주소 변경", "현재 연결 정보"
            },
            (d, index) -> {
              if (index < 3) {
                if (index == 1 && wifiPin.isEmpty()) {
                  Toast.makeText(this, "USB로 한 번 연결해 Wi-Fi 인증서를 등록하세요.", Toast.LENGTH_LONG).show();
                  return;
                }
                reconnect(new String[] {"auto", "wifi", "usb"}[index]);
              } else if (index == 3) {
                EditText input = new EditText(this);
                input.setSingleLine(true);
                input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
                input.setText(wifiUrls.isEmpty() ? "https://192.168.0.1:8841" : wifiUrls.get(0));
                new AlertDialog.Builder(this)
                    .setTitle("맥 편집기에 표시된 HTTPS 주소")
                    .setView(input)
                    .setNegativeButton("취소", null)
                    .setPositiveButton(
                        "저장",
                        (x, y) -> {
                          String address = input.getText().toString().trim();
                          if (!validWifiUrl(address)) {
                            Toast.makeText(
                                    this, "사설 IP의 https://주소:8841 형식으로 입력하세요.", Toast.LENGTH_LONG)
                                .show();
                            return;
                          }
                          wifiUrls = new ArrayList<>(Collections.singletonList(address));
                          prefs
                              .edit()
                              .putString("wifiUrls", new JSONArray(wifiUrls).toString())
                              .apply();
                          reconnect(transport);
                        })
                    .show();
              } else {
                new AlertDialog.Builder(this)
                    .setTitle("연결 정보")
                    .setMessage(
                        (connected ? "연결됨: " : "재연결 중: ")
                            + base
                            + "\n\n인증서: "
                            + (wifiPin.isEmpty() ? "미등록 · USB로 먼저 연결하세요" : wifiPin)
                            + (connectionError.isEmpty() ? "" : "\n\n" + connectionError))
                    .setPositiveButton("확인", null)
                    .show();
              }
            })
        .setNegativeButton("닫기", null)
        .show();
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
    if (pages == null || id.equals(pageId)) return;
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
              c = PinnedConnection.open(base + "/api/assets/" + id, wifiPin);
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
    labels[0] = "＋ 할 일 추가";
    for (int i = 0; i < items.length(); i++) {
      JSONObject item = items.optJSONObject(i);
      labels[i + 1] = (item.optBoolean("done") ? "✓ " : "○ ") + item.optString("text");
    }
    new AlertDialog.Builder(this)
        .setTitle(w.optString("label", "할 일"))
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
                new AlertDialog.Builder(this)
                    .setTitle("새 할 일")
                    .setView(input)
                    .setNegativeButton("취소", null)
                    .setPositiveButton(
                        "추가",
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
                new AlertDialog.Builder(this)
                    .setTitle(item.optString("text"))
                    .setItems(
                        new String[] {item.optBoolean("done") ? "다시 진행" : "완료로 표시", "삭제"},
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
        .setNegativeButton("닫기", null)
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
      Toast.makeText(this, "맥 연결을 기다리는 중입니다.", Toast.LENGTH_SHORT).show();
      return;
    }
    String id = body.optString("id", "volume");
    if (pending.containsKey(id) || runningIds.contains(id)) return;
    pending.put(id, SystemClock.elapsedRealtime());
    if (deck != null) deck.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP);
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
      Toast.makeText(this, "다른 동작이 진행 중입니다. 잠시 후 다시 눌러 주세요.", Toast.LENGTH_SHORT).show();
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

  private void settings() {
    String[] options = {
      "화면 켜짐 유지: " + (prefs.getBoolean("awake", true) ? "켜짐" : "꺼짐"),
      "연결 방식 · Wi-Fi / USB",
      "연결 초기화",
      "Open Deck 0.4.0 · MIT · 무료"
    };
    new AlertDialog.Builder(this)
        .setTitle("Open Deck")
        .setItems(
            options,
            (d, index) -> {
              if (index == 0) {
                boolean awake = !prefs.getBoolean("awake", true);
                prefs.edit().putBoolean("awake", awake).apply();
                if (awake) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
              }
              if (index == 1) connectionSettings();
              if (index == 2)
                new AlertDialog.Builder(this)
                    .setMessage("저장된 맥 연결을 초기화할까요?")
                    .setNegativeButton("취소", null)
                    .setPositiveButton(
                        "초기화",
                        (x, y) -> {
                          token = "";
                          prefs.edit().remove("token").apply();
                          disconnectEvents();
                          pairScreen();
                        })
                    .show();
            })
        .setNegativeButton("닫기", null)
        .show();
  }

  private class DeckView extends ViewGroup {
    final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    final Path iconPath = new Path();
    final RectF arcBounds = new RectF();
    final SimpleDateFormat timeFormat = new SimpleDateFormat("HH:mm", Locale.KOREA);
    final SimpleDateFormat dateFormat = new SimpleDateFormat("M월 d일 EEEE", Locale.KOREA);
    final ArrayList<Tile> tiles = new ArrayList<>();
    final Map<String, Tile> cachedTiles = new HashMap<>();
    String cachedConfig = "";
    JSONObject drawingPage;
    final Map<String, PageBackdrop> backdrops = new HashMap<>();
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
      setContentDescription("Open Deck 태블릿 컨트롤 패널");
    }

    void label(Canvas c, String value, float x, float y, float size, int col, Paint.Align align) {
      paint.setColor(col);
      paint.setStyle(Paint.Style.FILL);
      paint.setTypeface(font);
      paint.setTextSize(dp(size));
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
              performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK);
            }
          };
      if (!android.animation.ValueAnimator.areAnimatorsEnabled()
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
      if (getWidth() == 0 || !android.animation.ValueAnimator.areAnimatorsEnabled()) return;
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
        backdrops.clear();
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
      float margin = dp(18), gap = dp(p.optInt("gap", 12)), available = height - dp(132);
      float cellW = (width - margin * 2 - gap * (cols - 1)) / cols;
      float cellH = Math.max(dp(48), (available - gap * (rows - 1)) / rows);
      float maxScroll = Math.max(0, rows * (cellH + gap) - gap - available);
      scroll = Math.min(scroll, maxScroll);
      for (int i = 0; i < tiles.size(); i++) {
        int[] box = boxes[i];
        float left = margin + box[0] * (cellW + gap),
            top = dp(68) + box[1] * (cellH + gap) - scroll;
        int tw = Math.round(box[2] * cellW + (box[2] - 1) * gap),
            th = Math.round(box[3] * cellH + (box[3] - 1) * gap);
        rects.get(i).set(left, top, left + tw, top + th);
        tiles
            .get(i)
            .measure(
                MeasureSpec.makeMeasureSpec(tw, MeasureSpec.EXACTLY),
                MeasureSpec.makeMeasureSpec(th, MeasureSpec.EXACTLY));
      }
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
            rect.bottom > dp(68) && rect.top < height - dp(46) ? View.VISIBLE : View.INVISIBLE);
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
      c.clipRect(0, dp(68), getWidth(), getHeight() - dp(46));
      super.dispatchDraw(c);
      c.restore();
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
              + String.valueOf(osProvider() == null ? null : osProvider().optString("status"));
      if (!status.equals(headerStatus)) {
        headerStatus = status;
        invalidate();
      }
      String osSignature =
          String.valueOf(osProvider()) + String.valueOf(state.optJSONArray("notifications"));
      String systemSignature = String.valueOf(state.optJSONObject("system"));
      String grafanaSignature = String.valueOf(state.optJSONObject("grafana"));
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
        if (tile.widget.has("binding") || tile.widget.optString("label").contains("{{"))
          next += String.valueOf(state.optJSONObject("variables"));
        if (!next.equals(tile.signature)) {
          tile.signature = next;
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
                tile.widget.optString("label", "Grafana")
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
                    + ", 길게 눌러 프로젝트 변경");
          }
          if (tile.getVisibility() == View.VISIBLE) tile.invalidate();
        }
        float alpha =
            (connected ? 1f : .55f)
                * (tile.widget.optJSONObject("style") == null
                    ? 1f
                    : tile.widget.optJSONObject("style").optInt("opacity", 100) / 100f);
        if (tile.getAlpha() != alpha) tile.setAlpha(alpha);
      }
    }

    void tick() {
      for (Tile tile : cachedTiles.values()) {
        if (tile.getVisibility() != View.VISIBLE) continue;
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
      long clockMinute = -1;

      Tile(JSONObject w, JSONObject page) {
        super(MainActivity.this);
        widget = w;
        ownerPage = page;
        id = w.optString("id");
        type = w.optString("type");
        setContentDescription(w.optString("label"));
        setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_YES);
        setFocusable(true);
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
          connected
              ? (base.startsWith("https:") ? "Wi-Fi · 암호화 연결됨" : "USB · 연결됨")
                  + (pageId.equals("jimin-os-page")
                      ? (osData() == null ? "  · OS 연결 대기" : "  · OS 동기화됨")
                      : "")
              : "맥에 다시 연결하는 중…",
          dp(18),
          dp(49),
          10,
          color(connected ? "#70c9a8" : "#e7b16c"),
          Paint.Align.LEFT);
      label(c, "⚙", getWidth() - dp(18), dp(40), 24, color("#879dbd"), Paint.Align.RIGHT);
      if (tiles.isEmpty())
        label(
            c,
            "맥에서 Open Deck을 실행하고 연결을 확인하세요.",
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
      if (themedPage.has("gradient")) {
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
          template(widget.optString("label", "맥 상태")),
          r,
          top + dp(27),
          widget.optJSONObject("style") == null
              ? 18
              : widget.optJSONObject("style").optInt("textSize", 18),
          accent);
      JSONObject data = macSystem();
      if (data == null) {
        systemLabel(c, "실시간 상태 대기", r, top + dp(72), 20, text);
        systemLabel(c, "맥 연결과 최신 앱을 확인해 주세요", r, top + dp(100), 11, muted);
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
        systemLabel(c, data.optInt("logicalCores") + "코어 · 전체 사용률", r, top + dp(91), 11, muted);
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
            "전체 " + metricBytes(total) + " · 압력 " + pressureText(pressure),
            r,
            top + dp(87),
            10,
            stateColor);
        systemLabel(
            c,
            "압축 "
                + metricBytes(metric(mem, "compressedBytes"))
                + " · 스왑 "
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
            metricBytes(free) + " 여유",
            r,
            top + dp(65),
            22,
            color(low ? "#ef9696" : themeValue("text")));
        systemLabel(
            c,
            "전체 " + metricBytes(total) + " · " + (low ? "저장 공간 확인 필요" : "사용 가능"),
            r,
            top + dp(89),
            10,
            muted);
        systemLabel(
            c,
            "읽기 " + metricBytes(metric(io, "readBytesPerSecond")) + "/s",
            r,
            r.bottom - dp(43),
            10,
            muted);
        systemLabel(
            c,
            "쓰기 " + metricBytes(metric(io, "writeBytesPerSecond")) + "/s",
            r,
            r.bottom - dp(24),
            10,
            muted);
      } else if (kind.equals("power")) {
        double battery = metric(power, "batteryPercent");
        systemLabel(
            c,
            Double.isFinite(battery) ? String.format(Locale.KOREA, "%.0f%%", battery) : "배터리 없음",
            r,
            top + dp(65),
            24,
            text);
        systemLabel(
            c,
            power != null && power.optBoolean("pluggedIn") ? "전원 연결됨" : "배터리 사용 중",
            r,
            top + dp(90),
            11,
            muted);
        systemLabel(
            c,
            "발열 부담 " + thermalText(power == null ? "" : power.optString("thermal")),
            r,
            r.bottom - dp(42),
            12,
            accent);
        systemLabel(
            c,
            power != null && power.optBoolean("lowPower") ? "저전력 모드 켜짐" : "저전력 모드 꺼짐",
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
          systemLabel(c, "앱 사용량 비교 중…", r, top + dp(72), 17, muted);
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
        systemLabel(c, "100% = 1코어 · 탭하여 메모리 순 보기", r, r.bottom - dp(16), 9, muted);
      } else {
        List<String> alerts = systemWarnings(data);
        systemLabel(
            c,
            alerts.isEmpty() ? "맥 상태 정상" : "확인할 상태 " + alerts.size() + "개",
            r,
            top + dp(63),
            22,
            color(alerts.isEmpty() ? "#83cbb9" : "#efbd73"));
        systemLabel(
            c,
            data.optString("model", "내 Mac") + " · " + data.optInt("logicalCores") + "코어",
            r,
            top + dp(90),
            11,
            muted);
        if (!alerts.isEmpty())
          systemLabel(c, String.join(" · ", alerts), r, top + dp(117), 12, color("#efbd73"));
        long uptime = data.optLong("uptimeSeconds");
        systemLabel(
            c,
            "가동 " + (uptime / 3600) + "시간 " + ((uptime % 3600) / 60) + "분 · 2초 갱신",
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
      int text = color(themeValue("text")), muted = color("#9bafbd");
      JSONObject style = widget.optJSONObject("style");
      float titleSize = style == null ? 18 : style.optInt("textSize", 18),
          numberSize = style == null ? 28 : Math.min(36, style.optInt("valueSize", 28));
      systemLabel(c, widget.optString("label", "내 Mac"), r, r.top + dp(27), titleSize, muted);
      JSONObject data = macSystem();
      if (data == null) {
        systemLabel(c, "맥 상태 연결 대기", r, r.top + dp(66), 24, text);
        return;
      }
      JSONObject cpu = data.optJSONObject("cpu"),
          mem = data.optJSONObject("memory"),
          disk = data.optJSONObject("disk"),
          power = data.optJSONObject("power"),
          net = data.optJSONObject("network");
      double used = metric(mem, "usedBytes"), total = metric(mem, "totalBytes");
      String[] names = {"CPU", "MEM", "저장 공간", "전원·발열", "네트워크"};
      String[] values = {
        metricPercent(metric(cpu, "percent")),
        metricPercent(total > 0 ? 100 * used / total : Double.NaN),
        metricBytes(metric(disk, "availableBytes")),
        metricPercent(metric(power, "batteryPercent")),
        "↓ " + metricBytes(metric(net, "rxBytesPerSecond")) + "/s"
      };
      String[] sub = {
        data.optInt("logicalCores") + "코어",
        metricGiB(used) + " / " + metricGiB(total),
        "여유 · 전체 " + metricBytes(metric(disk, "totalBytes")),
        "발열 " + thermalText(power == null ? "" : power.optString("thermal")),
        "↑ " + metricBytes(metric(net, "txBytesPerSecond")) + "/s"
      };
      for (int i = 0; i < 5; i++) {
        RectF cell =
            new RectF(
                r.left + r.width() * i / 5, r.top, r.left + r.width() * (i + 1) / 5, r.bottom);
        int valueColor =
            i == 0 ? monitorColor(widget, "cpu") : i == 1 ? monitorColor(widget, "memory") : text;
        systemLabel(c, names[i], cell, r.top + dp(53), 14, muted);
        systemLabel(c, values[i], cell, r.top + dp(85), numberSize, valueColor);
        systemLabel(c, sub[i], cell, r.top + dp(107), 12, muted);
      }
      List<String> warnings = systemWarnings(data);
      systemLabel(
          c,
          warnings.isEmpty() ? "정상 · 눌러서 상세 탭 보기" : String.join(" · ", warnings) + " · 상세 보기",
          r,
          r.bottom - dp(12),
          11,
          color(warnings.isEmpty() ? "#83cbb9" : "#efbd73"));
    }

    void grafanaMetric(
        Canvas c,
        JSONObject widget,
        JSONObject data,
        String key,
        String name,
        String suffix,
        RectF cell,
        float top) {
      JSONObject metric = data.optJSONObject(key);
      double value = MainActivity.this.metric(metric, "value");
      boolean percent = key.equals("cpu") || key.equals("memory");
      String number =
          percent
              ? metricPercent(value)
              : Double.isFinite(value) ? String.format(Locale.KOREA, "%,.2f", value) : "—";
      JSONObject style = widget.optJSONObject("style");
      float numberSize = style == null ? 36 : style.optInt("valueSize", 36);
      systemLabel(c, name, cell, top, 17, color("#9bafbd"));
      systemLabel(c, number, cell, top + dp(40), numberSize, monitorColor(widget, key));
      systemLabel(
          c,
          key.equals("memory")
              ? metricGiB(MainActivity.this.metric(metric, "usedBytes")) + " 사용"
              : suffix,
          cell,
          top + dp(63),
          13,
          color("#9bafbd"));
    }

    void drawGrafana(Canvas c, JSONObject widget, RectF r) {
      boolean server = widget.optString("metric").equals("system");
      int accent = color(widget.optString("color", server ? "#86b6ef" : "#83cbb9")),
          text = color(themeValue("text")),
          muted = color("#9bafbd");
      JSONObject style = widget.optJSONObject("style"), health = monitorHealth(widget);
      String level = health == null ? "unknown" : health.optString("level", "unknown");
      if (level.equals("critical") || level.equals("warning")) {
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(dp(2));
        paint.setColor(monitorColor(level));
        c.drawRoundRect(
            new RectF(r.left + dp(1), r.top + dp(1), r.right - dp(1), r.bottom - dp(1)),
            dp(16),
            dp(16),
            paint);
        paint.setStyle(Paint.Style.FILL);
      }
      systemLabel(
          c,
          template(widget.optString("label", server ? "시스템 상태" : "DB 상태")),
          r,
          r.top + dp(29),
          style == null ? 18 : style.optInt("textSize", 18),
          accent);
      JSONObject data = grafanaData(widget);
      if (data == null || !data.optString("status").equals("ready")) {
        systemLabel(
            c,
            data != null && data.optString("status").equals("error") ? "지표 연결 확인" : "지표 조회 중",
            r,
            r.top + dp(100),
            28,
            text);
        systemLabel(
            c,
            data == null ? "맥에서 Grafana 연결을 확인해 주세요" : data.optString("message", "잠시 후 자동으로 표시돼요"),
            r,
            r.top + dp(132),
            14,
            muted);
      } else if (server) {
        JSONObject system = data.optJSONObject("system"),
            collection = data.optJSONObject("collection");
        systemLabel(c, "CPU · 시스템 최대 보고값", r, r.top + dp(69), 17, muted);
        systemLabel(
            c,
            metricPercent(metric(system, "value")),
            r,
            r.top + dp(118),
            style == null ? 44 : style.optInt("valueSize", 44),
            monitorColor(widget, "cpu"));
        int healthy = collection == null ? 0 : collection.optInt("healthy"),
            total = collection == null ? 0 : collection.optInt("total");
        systemLabel(
            c,
            total > 0 ? "수집 정상 " + healthy + " / " + total : "수집 대상 없음",
            r,
            r.top + dp(151),
            16,
            monitorColor(widget, "collection"));
        JSONArray nodes = system == null ? null : system.optJSONArray("nodes");
        if (nodes != null)
          for (int i = 0; i < Math.min(4, nodes.length()); i++) {
            JSONObject row = nodes.optJSONObject(i);
            float y = r.top + dp(191 + i * 28);
            systemLabel(
                c,
                row.optString("name"),
                new RectF(r.left, r.top, r.right - dp(85), r.bottom),
                y,
                14,
                muted);
            label(
                c,
                metricPercent(metric(row, "value")),
                r.right - dp(16),
                y,
                17,
                monitorValueColor(widget, "cpu", metric(row, "value")),
                Paint.Align.RIGHT);
          }
        float chartTop = Math.max(r.top + dp(301), r.bottom - dp(118));
        systemLabel(c, "최근 1시간 · CPU", r, chartTop - dp(8), 12, muted);
        grafanaTrend(
            c,
            system == null ? null : system.optJSONArray("points"),
            new RectF(r.left + dp(16), chartTop, r.right - dp(16), r.bottom - dp(64)),
            monitorColor(widget, "cpu"),
            true);
      } else {
        JSONObject database = data.optJSONObject("database"), tps = data.optJSONObject("tps");
        String status =
            level.equals("critical")
                ? "위험"
                : level.equals("warning") ? "주의" : level.equals("normal") ? "정상" : "상태 확인 중";
        systemLabel(c, "DB " + status, r, r.top + dp(58), 15, monitorColor(level));
        RectF left = new RectF(r.left, r.top, r.centerX(), r.bottom),
            right = new RectF(r.centerX(), r.top, r.right, r.bottom);
        grafanaMetric(c, widget, data, "cpu", "CPU", "노드 최대 · 할당 한도 대비", left, r.top + dp(88));
        grafanaMetric(c, widget, data, "memory", "MEM", "", right, r.top + dp(88));
        grafanaMetric(c, widget, data, "tps", "TPS", "커밋/초 · 5분 평균", left, r.top + dp(193));
        grafanaMetric(c, widget, data, "qps", "QPS", "쿼리/초 · 전체 노드", right, r.top + dp(193));
        float chartTop = Math.max(r.top + dp(301), r.bottom - dp(118));
        double connections = metric(database, "connections");
        systemLabel(
            c,
            "연결 "
                + (Double.isFinite(connections)
                    ? String.format(Locale.KOREA, "%,.0f", connections)
                    : "—")
                + " · 최근 1시간 TPS",
            r,
            chartTop - dp(8),
            12,
            monitorColor(widget, "connections"));
        grafanaTrend(
            c,
            tps == null ? null : tps.optJSONArray("points"),
            new RectF(r.left + dp(16), chartTop, r.right - dp(16), r.bottom - dp(64)),
            monitorColor(widget, "tps"),
            false);
      }
      line(
          c,
          r.left + dp(16),
          r.bottom - dp(47),
          r.right - dp(16),
          r.bottom - dp(47),
          color("#36505e"),
          dp(1));
      systemLabel(
          c,
          grafanaProject(widget).optString("label", "프로젝트 선택") + "   변경 ▾",
          r,
          r.bottom - dp(18),
          16,
          accent);
    }

    void drawWidget(Canvas c, JSONObject w, RectF r) {
      String type = w.optString("type"), id = w.optString("id");
      int accent = color(w.optString("color", "#86b6ff"));
      JSONObject style = w.optJSONObject("style");
      if (style == null) style = new JSONObject();
      if (type.equals("spacer")) return;
      float radius = dp((drawingPage == null ? activePage() : drawingPage).optInt("radius", 13));
      paint.setColor(color(style.optString("background", themeValue("surface"))));
      paint.setStyle(Paint.Style.FILL);
      c.drawRoundRect(r, radius, radius, paint);
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
        Bitmap image = bitmap(w.optString("image"), 512);
        float size = basis * style.optInt("iconSize", 32) / 100f;
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
            "탭: 시작·일시정지   길게: 초기화",
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
              new String[] {"일", "월", "화", "수", "목", "금", "토"}[i],
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
              osData() == null ? "Jimin OS 연결 대기" : "날짜를 눌러 일정과 할 일을 확인해요",
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
            count == 0 ? "탭해서 할 일 추가" : "탭해서 목록 편집",
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
      paint.setTextSize(dp(size));
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
      float lineHeight = dp(size * 1.3f),
          y =
              position.equals("top")
                  ? r.top + dp(size + 14)
                  : position.equals("center")
                      ? r.centerY() - lineHeight * (lines.length - 1) / 2 + dp(size * .35f)
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
        paint.setTextSize(dp(size));
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

    void drawOSSummary(Canvas c, JSONObject w, RectF r, int accent) {
      String type = w.optString("type");
      float left = r.left + dp(20), top = r.top + dp(28);
      if (type.equals("notification-feed")) {
        JSONArray feed = state.optJSONArray("notifications");
        drawIcon(
            c,
            "bell",
            r.centerX(),
            r.top + r.height() * .34f,
            Math.min(r.width(), r.height()) * .28f,
            accent);
        label(
            c,
            "알림" + (feed == null || feed.length() == 0 ? "" : " · " + feed.length()),
            r.centerX(),
            r.bottom - dp(17),
            13,
            color(themeValue("text")),
            Paint.Align.CENTER);
        return;
      }
      label(c, w.optString("label"), left, top, 14, accent, Paint.Align.LEFT);
      if (osData() == null) {
        label(
            c, "Jimin OS 연결을 기다리고 있어요", left, top + dp(36), 12, color("#8ba4af"), Paint.Align.LEFT);
        return;
      }
      JSONArray rows = osRows(type.equals("inbox") ? "inbox" : "events");
      float y = top + dp(33);
      int count = 0;
      if (type.equals("inbox")) {
        JSONObject counts = osData().optJSONObject("counts");
        String summary =
            "새 요청 "
                + (counts == null ? 0 : counts.optInt("requests"))
                + "   업데이트 "
                + (counts == null ? 0 : counts.optInt("updates"));
        label(c, summary, left, y, 19, color(themeValue("text")), Paint.Align.LEFT);
        y += dp(33);
      }
      for (int i = 0; i < rows.length() && count < 3; i++) {
        JSONObject item = rows.optJSONObject(i);
        if (!type.equals("inbox") && instant(item.optString("endsAt")) < hostNow()) continue;
        if (y > r.bottom - dp(22)) break;
        String title = item.optString("title");
        if (!type.equals("inbox"))
          title = osDate(instant(item.optString("startsAt")), "M/d HH:mm") + "  " + title;
        paint.setTextSize(dp(13));
        label(
            c,
            ellipsize(title, r.width() - dp(40), 13),
            left,
            y,
            13,
            color(themeValue("text")),
            Paint.Align.LEFT);
        y += dp(30);
        count++;
      }
      if (count == 0)
        label(
            c,
            type.equals("inbox") ? "확인할 새 업무 요청이 없어요" : "다가오는 일정이 없어요",
            left,
            y,
            12,
            color("#8ba4af"),
            Paint.Align.LEFT);
      if (type.equals("inbox")) {
        JSONArray routines = osRows("routines");
        String next = "";
        for (int i = 0; i < routines.length(); i++) {
          JSONObject rule = routines.optJSONObject(i);
          if (rule.optBoolean("enabled") && instant(rule.optString("nextRunAt")) > 0) {
            next = "예약 업무 · " + osDate(instant(rule.optString("nextRunAt")), "M/d HH:mm");
            break;
          }
        }
        if (!next.isEmpty())
          label(c, next, left, r.bottom - dp(14), 10, color("#8ba4af"), Paint.Align.LEFT);
      }
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
      if (y < dp(68) || y > getHeight() - dp(46)) return -1;
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
          boolean resumeSwipe = swipeSettle != null && y > dp(68) && y < getHeight() - dp(46);
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
            tile.setScaleX(.985f);
            tile.setScaleY(.985f);
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
          else if (touchAxis == 1 && downY > dp(68) && downY < getHeight() - dp(46))
            dragPage(dragStartOffset + x - downX);
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
            if (y < dp(60) && x > getWidth() - dp(75)) {
              settings();
              return true;
            }
            if (y > getHeight() - dp(46)) {
              JSONArray ps = config.optJSONArray("pages");
              for (int i = 0; i < pageRects.size(); i++)
                if (pageRects.get(i).contains(x, y)) {
                  if (ps.length() > 6) {
                    String[] names = new String[ps.length()];
                    for (int j = 0; j < ps.length(); j++)
                      names[j] = ps.optJSONObject(j).optString("name");
                    new AlertDialog.Builder(MainActivity.this)
                        .setTitle("페이지 이동")
                        .setItems(
                            names, (d, index) -> navigate(ps.optJSONObject(index).optString("id")))
                        .setNegativeButton("닫기", null)
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
              if (y > rects.get(downIndex).bottom - dp(48)
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
        tiles.get(downIndex).animate().scaleX(1f).scaleY(1f).setDuration(90).start();
    }

    @Override
    public boolean performClick() {
      super.performClick();
      return true;
    }
  }
}
