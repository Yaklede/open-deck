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
  private Thread events;
  private SharedPreferences prefs;
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
    transport = prefs.getString("transport", "auto");
    wifiPin = prefs.getString("wifiPin", "");
    try {
      JSONArray urls = new JSONArray(prefs.getString("wifiUrls", "[]"));
      for (int i = 0; i < urls.length(); i++) wifiUrls.add(urls.getString(i));
    } catch (Exception ignored) {
    }
    token = readToken();
    immersive();
    if (prefs.getBoolean("awake", true))
      getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    if (token.isEmpty()) pairScreen();
    else showDeck();
    ui.post(tick);
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
    super.onPause();
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
    if (pages == null) return;
    for (int i = 0; i < pages.length(); i++)
      if (pages.optJSONObject(i).optString("id").equals(id)) {
        pageId = id;
        prefs.edit().putString("page", id).apply();
        deck.scroll = 0;
        deck.rebuild();
        deck.updateState();
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
      "Open Deck 0.2.0 · MIT · 무료"
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
    String headerStatus = "";
    ArrayList<RectF> rects = new ArrayList<>();
    ArrayList<JSONObject> widgets = new ArrayList<>();
    ArrayList<RectF> pageRects = new ArrayList<>();
    float scroll = 0, maxScroll = 0, downX, downY, lastY, dragVolume = -1;
    long downAt;
    int downIndex = -1;
    boolean moved = false;

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
      String theme = activePage().optString("theme", "midnight");
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

    void rebuild() {
      String nextConfig = config.toString();
      int count =
          activePage().optJSONArray("widgets") == null
              ? 0
              : activePage().optJSONArray("widgets").length();
      if (!nextConfig.equals(cachedConfig) || cachedTiles.size() + count > 256) {
        removeAllViews();
        cachedTiles.clear();
        cachedConfig = nextConfig;
      }
      for (Tile tile : cachedTiles.values()) tile.setVisibility(View.GONE);
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
              tile = new Tile(w);
              cachedTiles.put(id, tile);
              addView(tile);
            }
            tile.setVisibility(View.VISIBLE);
            tiles.add(tile);
          }
      }
      setBackgroundColor(color(activePage().optString("background", themeValue("background"))));
      requestLayout();
      invalidate();
    }

    @Override
    protected void onMeasure(int widthSpec, int heightSpec) {
      int width = MeasureSpec.getSize(widthSpec), height = MeasureSpec.getSize(heightSpec);
      setMeasuredDimension(width, height);
      JSONObject p = activePage();
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
      maxScroll = Math.max(0, rows * (cellH + gap) - gap - available);
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
      for (int i = 0; i < tiles.size(); i++) {
        RectF rect = rects.get(i);
        Tile tile = tiles.get(i);
        tile.setVisibility(
            rect.bottom > dp(68) && rect.top < b - dp(46) ? View.VISIBLE : View.INVISIBLE);
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
      for (Tile tile : tiles) if (tile.id.equals(id)) tile.invalidate();
    }

    void updateState() {
      String status = connected + base;
      if (!status.equals(headerStatus)) {
        headerStatus = status;
        invalidate();
      }
      for (Tile tile : tiles) {
        String next;
        if (tile.type.equals("gauges")) next = state.optInt("cpu") + ":" + state.optInt("memory");
        else if (tile.type.equals("volume"))
          next = state.optInt("volume") + ":" + state.optBoolean("muted");
        else if (tile.type.equals("timer")) next = String.valueOf(state.optJSONObject("timers"));
        else if (tile.type.equals("graph")) next = String.valueOf(state.optJSONObject("history"));
        else if (tile.type.equals("todo")) next = String.valueOf(state.optJSONObject("todos"));
        else next = "static";
        if (tile.widget.has("binding") || tile.widget.optString("label").contains("{{"))
          next += String.valueOf(state.optJSONObject("variables"));
        if (!next.equals(tile.signature)) {
          tile.signature = next;
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
      for (Tile tile : tiles) {
        if (tile.type.equals("clock") && hostNow() / 60000 != tile.clockMinute) tile.invalidate();
        if (tile.type.equals("timer")) {
          JSONObject all = state.optJSONObject("timers"),
              timer = all == null ? null : all.optJSONObject(tile.id);
          if (timer != null && timer.optBoolean("running")) tile.invalidate();
        }
      }
    }

    private class Tile extends View {
      final JSONObject widget;
      final String id, type;
      final RectF bounds = new RectF();
      String signature = "";
      long clockMinute = -1;

      Tile(JSONObject w) {
        super(MainActivity.this);
        widget = w;
        id = w.optString("id");
        type = w.optString("type");
        setContentDescription(w.optString("label"));
        setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_YES);
        setFocusable(true);
        if (type.equals("button")
            || type.equals("timer")
            || type.equals("page")
            || type.equals("todo")
            || type.equals("toggle"))
          setOnClickListener(
              v -> {
                try {
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
        drawWidget(c, widget, bounds);
        clockMinute = hostNow() / 60000;
      }
    }

    @Override
    protected void onDraw(Canvas c) {
      super.onDraw(c);
      JSONObject themedPage = activePage();
      if (themedPage.has("gradient")) {
        paint.setShader(
            new LinearGradient(
                0,
                0,
                getWidth(),
                getHeight(),
                color(themedPage.optString("background", themeValue("background"))),
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
      label(c, "◈  OPEN DECK", dp(18), dp(28), 12, color(themeValue("text")), Paint.Align.LEFT);
      label(
          c,
          connected
              ? (base.startsWith("https:") ? "Wi-Fi · 암호화 연결됨" : "USB · 연결됨")
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

    void drawWidget(Canvas c, JSONObject w, RectF r) {
      String type = w.optString("type"), id = w.optString("id");
      int accent = color(w.optString("color", "#86b6ff"));
      JSONObject style = w.optJSONObject("style");
      if (style == null) style = new JSONObject();
      if (type.equals("spacer")) return;
      float radius = dp(activePage().optInt("radius", 13));
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
      } else if (type.equals("calendar")) {
        Calendar date = Calendar.getInstance();
        date.setTimeInMillis(hostNow());
        int day = date.get(Calendar.DAY_OF_MONTH),
            days = date.getActualMaximum(Calendar.DAY_OF_MONTH);
        date.set(Calendar.DAY_OF_MONTH, 1);
        int offset = date.get(Calendar.DAY_OF_WEEK) - 1;
        label(
            c,
            new SimpleDateFormat("yyyy년 M월", Locale.KOREA).format(new Date(hostNow())),
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
          if (d == day) {
            paint.setColor(accent);
            c.drawCircle(x, y - dp(4), dp(10), paint);
          }
          label(
              c,
              String.valueOf(d),
              x,
              y,
              11,
              color(d == day ? themeValue("background") : themeValue("text")),
              Paint.Align.CENTER);
        }
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
          downX = x;
          downY = y;
          lastY = y;
          downAt = System.currentTimeMillis();
          moved = false;
          downIndex = hit(x, y);
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
          if (Math.abs(x - downX) + Math.abs(y - downY) > dp(10)) moved = true;
          if (dragVolume >= 0 && downIndex >= 0) dragVolume = volumeAt(x, rects.get(downIndex));
          else if (maxScroll > 0) {
            scroll = Math.max(0, Math.min(maxScroll, scroll + lastY - y));
            requestLayout();
          }
          lastY = y;
          if (downIndex >= 0 && dragVolume >= 0) tiles.get(downIndex).invalidate();
          return true;
        case MotionEvent.ACTION_CANCEL:
          releasePress();
          dragVolume = -1;
          invalidate();
          return true;
        case MotionEvent.ACTION_UP:
          releasePress();
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
            if (type.equals("button"))
              dispatchButton(w, System.currentTimeMillis() - downAt > 650 ? "long" : "tap");
            else if (type.equals("page")) navigate(w.optString("targetPage"));
            else if (type.equals("todo")) todoDialog(w);
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
