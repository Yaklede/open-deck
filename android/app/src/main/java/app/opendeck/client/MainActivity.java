package app.opendeck.client;

import android.app.*;
import android.content.*;
import android.graphics.*;
import android.os.*;
import android.security.keystore.*;
import android.text.InputType;
import android.util.Base64;
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
import javax.crypto.*;
import javax.crypto.spec.GCMParameterSpec;
import org.json.*;

/**
 * Native Canvas renderer. No WebView, JavaScript runtime, third-party analytics or account service.
 */
public class MainActivity extends Activity {
  private final Handler ui = new Handler(Looper.getMainLooper());
  private final ExecutorService commands = Executors.newFixedThreadPool(3);
  private volatile boolean stopped = false, connected = false;
  private volatile HttpURLConnection eventConnection;
  private String token = "", base = "http://127.0.0.1:8840", pageId = "";
  private volatile JSONObject config = new JSONObject(), state = new JSONObject();
  private DeckView deck;
  private Typeface font;
  private Thread events;
  private SharedPreferences prefs;
  private final Map<String, Long> lastErrors = new HashMap<>();
  private final Runnable tick =
      new Runnable() {
        public void run() {
          if (deck != null) deck.invalidate();
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
    base = prefs.getString("host", base);
    token = readToken();
    immersive();
    if (prefs.getBoolean("awake", true))
      getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    if (token.isEmpty()) pairScreen();
    else showDeck();
    ui.post(tick);
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
    if (eventConnection != null) eventConnection.disconnect();
    if (events != null) events.interrupt();
    commands.shutdownNow();
    ui.removeCallbacks(tick);
    super.onDestroy();
  }

  @Override
  public void onConfigurationChanged(android.content.res.Configuration c) {
    super.onConfigurationChanged(c);
    if (deck != null) deck.invalidate();
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
      return Color.parseColor(s);
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
            "태블릿을 USB로 맥에 연결하고 Open Deck 앱을 실행하세요.\n맥 편집기에 표시되는 6자리 코드를 입력하면 됩니다.",
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
    HttpURLConnection c = (HttpURLConnection) new URL(base + route).openConnection();
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
    int delay = 1000;
    while (!stopped && !token.isEmpty()) {
      HttpURLConnection c = null;
      try {
        c = (HttpURLConnection) new URL(base + "/api/events").openConnection();
        eventConnection = c;
        c.setConnectTimeout(2500);
        c.setReadTimeout(15000);
        c.setRequestProperty("Authorization", "Bearer " + token);
        if (c.getResponseCode() == 401) {
          token = "";
          prefs.edit().remove("token").apply();
          ui.post(this::pairScreen);
          return;
        }
        if (c.getResponseCode() != 200) throw new IOException("Host unavailable");
        connected = true;
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
              JSONObject cfg = snapshot.getJSONObject("config"),
                  st = snapshot.getJSONObject("state");
              ui.post(
                  () -> {
                    config = cfg;
                    state = st;
                    showErrors();
                    if (deck != null) deck.invalidate();
                  });
            }
          }
        }
      } catch (Exception e) {
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
      if (!stopped)
        try {
          Thread.sleep(delay);
        } catch (InterruptedException e) {
          return;
        }
      delay = Math.min(15000, delay * 2);
    }
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

  private void action(JSONObject body) {
    if (!connected) {
      Toast.makeText(this, "맥 연결을 기다리는 중입니다.", Toast.LENGTH_SHORT).show();
      return;
    }
    commands.execute(
        () -> {
          try {
            request("/api/action", "POST", body, true);
          } catch (Exception e) {
            ui.post(() -> Toast.makeText(this, e.getMessage(), Toast.LENGTH_SHORT).show());
          }
        });
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
      "연결 초기화",
      "Open Deck 0.1.0 · MIT · 무료"
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
              if (index == 1)
                new AlertDialog.Builder(this)
                    .setMessage("저장된 맥 연결을 초기화할까요?")
                    .setNegativeButton("취소", null)
                    .setPositiveButton(
                        "초기화",
                        (x, y) -> {
                          token = "";
                          prefs.edit().remove("token").apply();
                          if (eventConnection != null) eventConnection.disconnect();
                          pairScreen();
                        })
                    .show();
            })
        .setNegativeButton("닫기", null)
        .show();
  }

  private class DeckView extends View {
    Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    ArrayList<RectF> rects = new ArrayList<>();
    ArrayList<JSONObject> widgets = new ArrayList<>();
    ArrayList<RectF> pageRects = new ArrayList<>();
    float scroll = 0, maxScroll = 0, downX, downY, lastY, dragVolume = -1;
    long downAt;
    int downIndex = -1;
    boolean moved = false;

    DeckView() {
      super(MainActivity.this);
      setLayerType(View.LAYER_TYPE_HARDWARE, null);
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

    @Override
    protected void onDraw(Canvas c) {
      super.onDraw(c);
      int width = getWidth(), height = getHeight();
      float margin = dp(18), gap = dp(12), header = dp(68), bottom = dp(46);
      JSONArray pages = config.optJSONArray("pages");
      label(c, "◈  OPEN DECK", margin, dp(28), 12, color("#c4cfff"), Paint.Align.LEFT);
      label(
          c,
          connected ? "USB · 연결됨" : "맥에 다시 연결하는 중…",
          margin,
          dp(49),
          10,
          color(connected ? "#70c9a8" : "#e7b16c"),
          Paint.Align.LEFT);
      label(c, "⚙", width - margin, dp(40), 24, color("#879dbd"), Paint.Align.RIGHT);
      if (pages == null || pages.length() == 0) {
        label(
            c,
            "맥에서 Open Deck을 실행하고 USB 연결을 확인하세요.",
            width / 2f,
            height / 2f,
            16,
            color("#9bacc6"),
            Paint.Align.CENTER);
        return;
      }
      JSONObject page = pages.optJSONObject(0);
      for (int i = 0; i < pages.length(); i++)
        if (pages.optJSONObject(i).optString("id").equals(pageId)) page = pages.optJSONObject(i);
      pageId = page.optString("id");
      JSONArray items = page.optJSONArray("widgets");
      if (items == null) return;
      int cols =
          width < height ? Math.min(2, config.optInt("columns", 4)) : config.optInt("columns", 4);
      cols = Math.max(2, Math.min(8, cols));
      int rows = Math.max(1, (items.length() + cols - 1) / cols);
      float cellW = (width - margin * 2 - gap * (cols - 1)) / cols,
          available = height - header - bottom - margin,
          cellH = Math.max(dp(145), (available - gap * (rows - 1)) / rows);
      maxScroll = Math.max(0, rows * (cellH + gap) - gap - available);
      scroll = Math.min(scroll, maxScroll);
      rects.clear();
      widgets.clear();
      c.save();
      c.clipRect(0, header, width, height - bottom);
      for (int i = 0; i < items.length(); i++) {
        JSONObject w = items.optJSONObject(i);
        if (w == null) continue;
        float left = margin + (i % cols) * (cellW + gap),
            top = header + (i / cols) * (cellH + gap) - scroll;
        RectF r = new RectF(left, top, left + cellW, top + cellH);
        rects.add(r);
        widgets.add(w);
        drawWidget(c, w, r);
      }
      c.restore();
      pageRects.clear();
      float total = pages.length() * dp(140), start = (width - total) / 2;
      for (int i = 0; i < pages.length(); i++) {
        JSONObject p = pages.optJSONObject(i);
        RectF r =
            new RectF(start + i * dp(140), height - bottom, start + (i + 1) * dp(140), height);
        pageRects.add(r);
        label(
            c,
            p.optString("name"),
            r.centerX(),
            height - dp(17),
            11,
            color(p.optString("id").equals(pageId) ? "#b5c4ff" : "#536c91"),
            Paint.Align.CENTER);
      }
    }

    void drawWidget(Canvas c, JSONObject w, RectF r) {
      String type = w.optString("type"), id = w.optString("id");
      int accent = color(w.optString("color", "#86b6ff"));
      paint.setColor(color("#172436"));
      paint.setStyle(Paint.Style.FILL);
      c.drawRoundRect(r, dp(13), dp(13), paint);
      boolean running =
          state.optJSONArray("running") != null
              && state.optJSONArray("running").toString().contains('"' + id + '"');
      if (type.equals("button")) {
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(dp(running ? 3 : 1.3f));
        paint.setColor(running ? Color.WHITE : accent);
        c.drawRoundRect(r, dp(13), dp(13), paint);
        paint.setStyle(Paint.Style.FILL);
        JSONObject results = state.optJSONObject("results"),
            result = results == null ? null : results.optJSONObject(id);
        if (result != null && System.currentTimeMillis() - result.optLong("at") < 1800 && !running)
          label(
              c,
              "ok".equals(result.optString("status")) ? "✓" : "!",
              r.right - dp(15),
              r.top + dp(23),
              13,
              color("ok".equals(result.optString("status")) ? "#7ce3b5" : "#ff9a9a"),
              Paint.Align.RIGHT);
      }
      float cx = r.centerX(), cy = r.centerY(), basis = Math.min(r.width(), r.height());
      if (type.equals("button")) {
        drawIcon(
            c, w.optString("icon", "monitor"), cx, r.top + r.height() * .37f, basis * .32f, accent);
        String[] lines = w.optString("label").split("\n");
        float y = r.bottom - dp(lines.length > 1 ? 38 : 23);
        for (String l : lines) {
          float textSize =
              Math.min(
                  17, Math.max(10, (r.width() / dp(1) - 25) / (Math.max(1, l.length()) * .75f)));
          label(c, l, cx, y, textSize, color("#e0e9fa"), Paint.Align.CENTER);
          y += dp(21);
        }
        if (running)
          label(c, "실행 중", r.right - dp(15), r.top + dp(23), 9, Color.WHITE, Paint.Align.RIGHT);
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
            new SimpleDateFormat("HH:mm", Locale.KOREA).format(new Date()),
            cx,
            r.top + r.height() * .60f,
            Math.min(48, basis / dp(1) * .24f),
            color("#e5edff"),
            Paint.Align.CENTER);
        label(
            c,
            new SimpleDateFormat("M월 d일 EEEE", Locale.KOREA).format(new Date()),
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
          arc(
              c,
              new RectF(gx - rad, gy - rad, gx + rad, gy + rad),
              val / 100f,
              color(k == 0 ? "#7cbaff" : "#ad9bff"));
          label(
              c,
              val + "%",
              gx,
              r.top + r.height() * .80f,
              20,
              color("#e3edff"),
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
                        ? Math.max(0, t.optLong("end") - System.currentTimeMillis())
                        : t.optLong("remaining", duration);
        float rad = basis * .34f;
        arc(
            c,
            new RectF(cx - rad, cy - rad - dp(8), cx + rad, cy + rad - dp(8)),
            remaining / (float) duration,
            accent);
        long sec = (remaining + 999) / 1000;
        label(
            c,
            String.format(Locale.ROOT, "%02d:%02d", sec / 60, sec % 60),
            cx,
            cy,
            Math.min(34, basis / dp(1) * .17f),
            color("#ecf2ff"),
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
      } else if (type.equals("volume")) {
        int value = dragVolume >= 0 ? (int) dragVolume : state.optInt("volume", 50);
        label(
            c,
            w.optString("label"),
            r.left + dp(16),
            r.top + dp(29),
            14,
            color("#dae5f8"),
            Paint.Align.LEFT);
        label(
            c,
            value + "%",
            r.right - dp(16),
            r.top + dp(29),
            17,
            color("#dae5f8"),
            Paint.Align.RIGHT);
        float x1 = r.left + dp(25),
            x2 = r.right - dp(25),
            y = r.centerY() + dp(15),
            x = x1 + (x2 - x1) * value / 100f;
        line(c, x1, y, x2, y, color("#29334a"), 12);
        line(c, x1, y, x, y, accent, 12);
        paint.setColor(color("#e6efff"));
        c.drawCircle(x, y, dp(13), paint);
      } else {
        String[] lines = w.optString("label").split("\n");
        float y = cy - (lines.length - 1) * dp(10);
        for (String l : lines) {
          label(c, l, cx, y, 16, color("#b9cbe4"), Paint.Align.CENTER);
          y += dp(23);
        }
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
      Path p = new Path();
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
          if (downIndex >= 0 && widgets.get(downIndex).optString("type").equals("volume")) {
            dragVolume = volumeAt(x, rects.get(downIndex));
            invalidate();
          }
          return true;
        case MotionEvent.ACTION_MOVE:
          if (Math.abs(x - downX) + Math.abs(y - downY) > dp(10)) moved = true;
          if (dragVolume >= 0 && downIndex >= 0) dragVolume = volumeAt(x, rects.get(downIndex));
          else scroll = Math.max(0, Math.min(maxScroll, scroll + lastY - y));
          lastY = y;
          invalidate();
          return true;
        case MotionEvent.ACTION_CANCEL:
          dragVolume = -1;
          invalidate();
          return true;
        case MotionEvent.ACTION_UP:
          try {
            if (dragVolume >= 0) {
              int value = Math.round(dragVolume);
              dragVolume = -1;
              state.put("volume", value);
              action(new JSONObject().put("kind", "volume").put("value", value));
              invalidate();
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
                  pageId = ps.getJSONObject(i).getString("id");
                  prefs.edit().putString("page", pageId).apply();
                  scroll = 0;
                  invalidate();
                }
              return true;
            }
            if (downIndex < 0 || downIndex != hit(x, y)) return true;
            JSONObject w = widgets.get(downIndex);
            String type = w.optString("type");
            if (type.equals("button")) action(new JSONObject().put("id", w.getString("id")));
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

    @Override
    public boolean performClick() {
      super.performClick();
      return true;
    }
  }
}
