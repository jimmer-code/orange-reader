package app.shubian;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Build;
import android.provider.Settings;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.speech.tts.TextToSpeech;
import android.util.Base64;
import android.util.Log;
import android.view.KeyEvent;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.inputmethod.InputMethodManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.window.OnBackInvokedDispatcher;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.io.FileOutputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicReference;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * Hosts the app UI (assets/web, the prototype made real) in one WebView and exposes native
 * services to it as window.Native. Pages are served from https://app.local/ by intercepting requests.
 */
public abstract class WebActivity extends Activity {
    static final String ORIGIN = "https://app.local/";
    static final int REQ_IMPORT = 1, REQ_CAMERA = 2, REQ_ALBUM = 3;

    protected WebView web;
    protected PageCurlView curl;
    protected Store store;
    protected final Handler main = new Handler(Looper.getMainLooper());
    protected final ExecutorService io = Executors.newSingleThreadExecutor();
    private final ExecutorService net = Executors.newCachedThreadPool();
    private final AtomicReference<JSONObject> latestUpdate = new AtomicReference<>();
    private final Map<String, ZipFile> zips = new HashMap<>();
    private TextToSpeech tts;
    private volatile boolean ttsReady, ttsFailed, reading;
    private volatile boolean dead;
    private volatile String ttsPending;
    private boolean pageReady;
    private volatile String pendingImportKey;
    private volatile String pendingScanKey;
    private String insetsJs;
    protected long createdAt;

    protected abstract String startUrl();
    protected boolean transparent() { return false; }

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        createdAt = System.currentTimeMillis();
        store = new Store(this);
        // 长尾词库首次启动要写入约 17 MB SQLite；提前在后台建好，避免第一次查词时卡住页面
        io.execute(() -> {
            try { Dict.get(getApplicationContext()); }
            catch (Exception e) { Log.w("Shubian", "dictionary warm-up failed", e); }
        });
        getWindow().setDecorFitsSystemWindows(false);
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true);
        PageCurlView.ReaderFrame root = new PageCurlView.ReaderFrame(this);
        web = new WebView(this);
        web.setBackgroundColor(transparent() ? Color.TRANSPARENT : getColor(R.color.bg));
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        // 仿真翻页覆盖层：只在阅读时可见，平时不建 Surface
        curl = new PageCurlView(this, new PageCurlView.Host() {
            @Override public WebView web() { return web; }
            @Override public android.view.Window window() { return getWindow(); }
            @Override public void js(String code) { if (!dead) web.evaluateJavascript(code, null); }
            @Override public void emit(String type, Object json) { WebActivity.this.emit(type, json); }
        });
        curl.setVisibility(View.GONE);
        root.addView(curl, new FrameLayout.LayoutParams(-1, -1));
        root.curl = curl;
        setContentView(root);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setTextZoom(100);
        s.setSupportZoom(false);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.addJavascriptInterface(new Bridge(), "Native");
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                return serve(r.getUrl());
            }
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) { return true; }
            @Override public void onPageFinished(WebView v, String url) {
                pageReady = true;
                if (insetsJs != null) web.evaluateJavascript(insetsJs, null);
            }
        });
        root.setOnApplyWindowInsetsListener((v, in) -> {
            float d = getResources().getDisplayMetrics().density;
            android.graphics.Insets ime = in.getInsets(WindowInsets.Type.ime());
            android.graphics.Insets bars = in.getInsetsIgnoringVisibility(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            boolean kb = ime.bottom > 0;
            FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) web.getLayoutParams();
            if (lp.bottomMargin != ime.bottom) {
                lp.bottomMargin = ime.bottom; web.setLayoutParams(lp);
                FrameLayout.LayoutParams cl = (FrameLayout.LayoutParams) curl.getLayoutParams();
                cl.bottomMargin = ime.bottom; curl.setLayoutParams(cl);
            }
            insetsJs = String.format(Locale.ROOT, "window.setInsets&&setInsets(%.1f,%.1f,%.1f,%.1f,%b)",
                    bars.top / d, kb ? 0 : bars.bottom / d, bars.left / d, bars.right / d, kb);
            if (pageReady) web.evaluateJavascript(insetsJs, null);
            return WindowInsets.CONSUMED;
        });
        getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, () ->
                web.evaluateJavascript("window.onBack?onBack():false", r -> { if (!"true".equals(r)) onExit(); }));
        tts = new TextToSpeech(this, st -> {
            if (st == TextToSpeech.SUCCESS && tts.isLanguageAvailable(Locale.US) >= 0) {
                tts.setLanguage(Locale.US);
                ttsReady = true;
                if (ttsPending != null) { tts.speak(ttsPending, TextToSpeech.QUEUE_FLUSH, null, "w"); ttsPending = null; }
            } else {
                ttsFailed = true;
            }
        });
        applyBars(true, !isNight());
        web.loadUrl(startUrl());
    }

    protected void onExit() { moveTaskToBack(true); }

    boolean isNight() {
        return (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
    }

    @Override protected void onDestroy() {
        dead = true;
        if (tts != null) tts.shutdown();
        for (ZipFile z : zips.values()) try { z.close(); } catch (Exception ignored) { }
        web.destroy();
        super.onDestroy();
    }

    @Override public boolean dispatchKeyEvent(KeyEvent e) {
        int k = e.getKeyCode();
        if (reading && (k == KeyEvent.KEYCODE_VOLUME_DOWN || k == KeyEvent.KEYCODE_VOLUME_UP) && volumeKeys()) {
            if (e.getAction() == KeyEvent.ACTION_DOWN) emit("volume", k == KeyEvent.KEYCODE_VOLUME_DOWN ? "1" : "-1");
            return true;
        }
        return super.dispatchKeyEvent(e);
    }

    private boolean volumeKeys() {
        try { return new JSONObject(store.get("settings")).optBoolean("volume"); } catch (Exception e) { return false; }
    }

    /** Calls window.onNative(type, data) in the page; data is a JSON value. */
    void emit(String type, Object json) {
        if (dead) return;
        String js = "window.onNative&&onNative(" + JSONObject.quote(type) + "," + json + ")";
        main.post(() -> web.evaluateJavascript(js, null));
    }

    void applyBars(boolean visible, boolean darkIcons) {
        WindowInsetsController c = getWindow().getInsetsController();
        if (c == null) return;
        int light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
        c.setSystemBarsAppearance(darkIcons ? light : 0, light);
        c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        if (visible) c.show(WindowInsets.Type.systemBars()); else c.hide(WindowInsets.Type.systemBars());
    }

    protected void onPageReady() { }

    // ---------- serving ----------

    private WebResourceResponse serve(Uri u) {
        if (!"app.local".equals(u.getHost())) return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", null, null);
        String path = u.getPath() == null ? "/" : u.getPath();
        try {
            InputStream in;
            if (path.startsWith("/book/")) {
                String rest = path.substring(6);
                String id = rest.substring(0, rest.indexOf('/'));
                ZipFile z = zip(id);
                ZipEntry e = z.getEntry(rest.substring(id.length() + 1));
                if (e == null) return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", null, null);
                in = z.getInputStream(e);
            } else if (path.startsWith("/cover/")) {
                in = new FileInputStream(new File(Epub.coverDir(this), new File(path).getName()));
            } else if (path.startsWith("/scan/")) {
                in = new FileInputStream(new File(Scan.dir(this), new File(path).getName()));
            } else if (path.startsWith("/kb/")) {
                if (BuildConfig.PUBLIC_EDITION) return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", null, null);
                // 课程缓存（filesDir/kb）：文章 HTML 与图片，路径必须落在缓存目录内
                File base = Kb.dir(this);
                File f = new File(base, path.substring(4));
                if (!Kb.under(base, f)) return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", null, null);
                in = new FileInputStream(f);
            } else {
                in = getAssets().open("web" + (path.equals("/") ? "/index.html" : path));
            }
            WebResourceResponse r = new WebResourceResponse(mime(path), "utf-8", in);
            Map<String, String> h = new HashMap<>();
            h.put("Access-Control-Allow-Origin", "*");
            // /kb/ 是同步后会立刻变化的课程缓存，不能沿用 assets 的一年缓存
            h.put("Cache-Control", path.startsWith("/scan/") || path.startsWith("/kb/") ? "no-store" : "max-age=31536000");
            r.setResponseHeaders(h);
            return r;
        } catch (Exception e) {
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", null, null);
        }
    }

    private synchronized ZipFile zip(String id) throws Exception {
        ZipFile z = zips.get(id);
        if (z == null) { z = new ZipFile(new File(Epub.dir(this), id + ".epub")); zips.put(id, z); }
        return z;
    }

    private static String mime(String p) {
        String l = p.toLowerCase(Locale.ROOT);
        if (l.endsWith(".html") || l.endsWith(".htm")) return "text/html";
        if (l.endsWith(".xhtml") || l.endsWith(".xml") || l.endsWith(".opf") || l.endsWith(".ncx")) return "application/xhtml+xml";
        if (l.endsWith(".css")) return "text/css";
        if (l.endsWith(".js")) return "text/javascript";
        if (l.endsWith(".woff2")) return "font/woff2";
        if (l.endsWith(".png")) return "image/png";
        if (l.endsWith(".gif")) return "image/gif";
        if (l.endsWith(".svg")) return "image/svg+xml";
        if (l.endsWith(".webp")) return "image/webp";
        if (l.endsWith(".jpg") || l.endsWith(".jpeg")) return "image/jpeg";
        if (l.endsWith(".ttf") || l.endsWith(".otf")) return "font/ttf";
        return "application/octet-stream";
    }

    // ---------- activity results ----------

    void startCamera() { startCamera(null); }

    void startCamera(String requestKey) {
        pendingScanKey = requestKey;
        Uri capture = ImageProvider.captureUri(this);
        Intent i = new Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT, capture)
                .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        i.setClipData(ClipData.newRawUri("", capture));
        try { startActivityForResult(i, REQ_CAMERA); } catch (Exception e) { emit("toast", JSONObject.quote("没有可用的相机")); }
    }

    @Override protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (res != RESULT_OK) {
            if (req == REQ_IMPORT) emit("import", jsonQuiet("state", "cancel", "key", pendingImportKey == null ? "" : pendingImportKey));
            else emit("scanCancel", jsonQuiet("id", pendingScanKey == null ? "" : pendingScanKey));
            if (req == REQ_IMPORT) pendingImportKey = null; else pendingScanKey = null;
            return;
        }
        if (req == REQ_IMPORT && data != null) {
            String key = pendingImportKey;
            if (data.getClipData() != null) for (int i = 0; i < data.getClipData().getItemCount(); i++) importBook(data.getClipData().getItemAt(i).getUri(), key);
            else if (data.getData() != null) importBook(data.getData(), key);
            pendingImportKey = null;
        } else if (req == REQ_CAMERA) {
            scan(ImageProvider.captureUri(this), pendingScanKey);
            pendingScanKey = null;
        } else if (req == REQ_ALBUM && data != null && data.getData() != null) {
            scan(data.getData(), pendingScanKey);
            pendingScanKey = null;
        }
    }

    void importBook(Uri uri) {
        importBook(uri, "external-" + System.nanoTime());
    }

    void importBook(Uri uri, String key) {
        if (key == null || key.isEmpty()) key = "external-" + System.nanoTime();
        final String requestKey = key;
        io.execute(() -> {
            try {
                String id = Epub.copyIn(this, uri);
                JSONObject meta = Epub.parse(this, id);
                emit("import", new JSONObject().put("state", "done").put("key", requestKey).put("book", meta));
            } catch (Epub.Rejected r) {
                String msg = r.getMessage().startsWith("dup:") ? "已在书库" : r.getMessage();
                emit("import", jsonQuiet("state", "error", "msg", msg, "key", requestKey));
            } catch (Exception e) {
                Log.w("Shubian", "import failed", e);
                emit("import", jsonQuiet("state", "error", "msg", "无法读取这本书", "key", requestKey));
            }
        });
    }

    private void scan(Uri uri, String requestKey) {
        io.execute(() -> {
            try {
                File out = new File(Scan.dir(this), "page-" + System.currentTimeMillis() + ".jpg");
                File[] old = Scan.dir(this).listFiles((d, n) -> n.startsWith("page-"));
                if (old != null) for (File f : old) f.delete();
                android.graphics.Bitmap bmp = Scan.prepare(this, uri, out);
                emit("scanImage", new JSONObject().put("id", requestKey == null ? "" : requestKey).put("url", "/scan/" + out.getName()).put("w", bmp.getWidth()).put("h", bmp.getHeight()));
                Scan.recognize(this, bmp, known(), r -> { try { r.put("id", requestKey == null ? "" : requestKey); } catch (Exception ignored) { } emit("ocr", r); });
            } catch (Exception e) {
                Log.w("Shubian", "scan failed", e);
                emit("ocr", jsonQuiet("ok", "false", "id", requestKey == null ? "" : requestKey));
            }
        });
    }

    private Set<String> known() {
        Set<String> s = new HashSet<>();
        try {
            JSONArray a = new JSONArray(store.get("known"));
            for (int i = 0; i < a.length(); i++) s.add(a.getString(i));
        } catch (Exception ignored) { }
        return s;
    }

    static JSONObject jsonQuiet(String... kv) {
        JSONObject o = new JSONObject();
        try { for (int i = 0; i < kv.length; i += 2) o.put(kv[i], kv[i + 1].equals("false") ? (Object) false : kv[i + 1]); }
        catch (Exception ignored) { }
        return o;
    }

    // Built from Immersive Translate's eBook/fiction expert prompts, plus rules against Chinese translationese.
    static final String TRANSLATE_PROMPT = "你是母语为简体中文的资深译者，帮读者看懂英文书里的一段文字。把<text>里的英文译成简体中文。\n"
            + "1. 只输出译文，不加解释、注释、引号或\"译文：\"之类的前缀。\n"
            + "2. 先读懂意思和语气，再用中文本来的说法写出来，不逐词对译。英文长句按中文习惯拆短、调整语序。\n"
            + "3. 不要翻译腔：少用\"被\"\"的\"\"着\"\"一个\"\"他们\"堆叠，代词能省就省，连接词只在中文需要时才用。\n"
            + "4. 比喻、俚语、习语按意思译成中文自然的说法。人名、地名和专有名词用通行译名，没有通行译名就保留原文。\n"
            + "5. 保持原文的语气和文体：对话口语化，叙述贴着作者的风格，不拔高、不加戏，不添加原文没有的信息。\n"
            + "6. <text>可能是半句话，只译给出的部分。<context>只用来理解指代和语境，不要翻译它。";
    static final String ASK_PROMPT = "用户在读英文书时遇到一个词典里查不到的词。用简体中文简要解释它的意思；给了句子时，说明它在句中的意思。";

    String key() {
        return BuildConfig.PUBLIC_EDITION ? UserSecrets.get(this, "deepseek") : BuildConfig.OPENCODE_KEY;
    }

    /** Jev calls go through OpenRouter, which uses its own key. */
    String jevKey() {
        return BuildConfig.PUBLIC_EDITION ? UserSecrets.get(this, "openrouter") : BuildConfig.OPENROUTER_KEY;
    }

    // ---------- bridge ----------

    final class Bridge {
        @JavascriptInterface public String lookup(String w) throws Exception { return Dict.get(WebActivity.this).lookup(w).toString(); }
        @JavascriptInterface public String prefix(String q) throws Exception { return Dict.get(WebActivity.this).prefix(q).toString(); }
        @JavascriptInterface public String formsOf(String lemmas) throws Exception { return Dict.get(WebActivity.this).formsOf(new JSONArray(lemmas)).toString(); }
        @JavascriptInterface public String kvGet(String k) { return store.get(k); }
        @JavascriptInterface public void kvSet(String k, String v) { store.set(k, v); }
        @JavascriptInterface public boolean publicEdition() { return BuildConfig.PUBLIC_EDITION; }
        @JavascriptInterface public boolean hasJev() { return !jevKey().isEmpty(); }
        @JavascriptInterface public boolean hasTr() { return !key().isEmpty(); }
        @JavascriptInterface public boolean saveDeepSeekKey(String value) {
            if (!BuildConfig.PUBLIC_EDITION) return false;
            try { UserSecrets.set(WebActivity.this, "deepseek", value); return true; }
            catch (Exception e) { return false; }
        }
        @JavascriptInterface public void clearDeepSeekKey() {
            if (BuildConfig.PUBLIC_EDITION) UserSecrets.clear(WebActivity.this, "deepseek");
        }
        @JavascriptInterface public boolean saveJevKey(String value) {
            if (!BuildConfig.PUBLIC_EDITION) return false;
            try { UserSecrets.set(WebActivity.this, "openrouter", value); return true; }
            catch (Exception e) { return false; }
        }
        @JavascriptInterface public void clearJevKey() {
            if (BuildConfig.PUBLIC_EDITION) UserSecrets.clear(WebActivity.this, "openrouter");
        }
        @JavascriptInterface public void testDeepSeek(int id) {
            net.execute(() -> {
                int code = 0;
                try {
                    String value = key();
                    if (value.isEmpty()) throw new IllegalStateException("未配置 Key");
                    code = Net.testKey(value);
                    emit("aiTest", jsonQuiet("id", String.valueOf(id), "kind", "deepseek",
                            "status", code >= 200 && code < 300 ? "ok" : "error",
                            "msg", code >= 200 && code < 300 ? "连接正常" : "请求失败（" + code + "）"));
                } catch (Exception e) {
                    emit("aiTest", jsonQuiet("id", String.valueOf(id), "kind", "deepseek", "status", "error",
                            "msg", e.getMessage() == null ? "连接失败" : e.getMessage()));
                }
            });
        }
        /** True while the engine is still starting; false only when no English voice is available. */
        @JavascriptInterface public boolean canSpeak() { return !ttsFailed; }
        @JavascriptInterface public void speak(String t) {
            if (ttsReady) tts.speak(t, TextToSpeech.QUEUE_FLUSH, null, "w"); else ttsPending = t;
        }
        @JavascriptInterface public void haptic() { main.post(() -> web.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)); }
        @JavascriptInterface public String books() throws Exception { return Epub.list(WebActivity.this).toString(); }
        @JavascriptInterface public void deleteBook(String id) {
            main.post(() -> {
                ZipFile z = zips.remove(id);
                if (z != null) try { z.close(); } catch (Exception ignored) { }
                Epub.delete(WebActivity.this, id);
            });
        }
        @JavascriptInterface public void importBooks(String requestKey) {
            pendingImportKey = requestKey;
            main.post(() -> startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                    .setType("application/epub+zip").putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true), REQ_IMPORT));
        }
        @JavascriptInterface public void camera(String requestKey) { main.post(() -> startCamera(requestKey)); }
        @JavascriptInterface public void album(String requestKey) {
            pendingScanKey = requestKey;
            main.post(() -> startActivityForResult(new Intent(MediaStore.ACTION_PICK_IMAGES).setType("image/*"), REQ_ALBUM));
        }
        @JavascriptInterface public void keyboard(boolean show) {
            main.post(() -> {
                InputMethodManager imm = getSystemService(InputMethodManager.class);
                if (show) { web.requestFocus(); imm.showSoftInput(web, 0); }
                else imm.hideSoftInputFromWindow(web.getWindowToken(), 0);
            });
        }
        @JavascriptInterface public void reading(boolean on) {
            reading = on;
            main.post(() -> {
                if (!on) { curl.reset(); curl.setVisibility(View.GONE); curl.releaseBitmaps(); }
                else curl.setVisibility(View.VISIBLE);
            });
        }
        // ---- 仿真翻页（PageCurlView） ----
        @JavascriptInterface public void curlArm(boolean on, boolean prev, boolean next, boolean spread, float x, float y, float w, float h, float dpr) {
            main.post(() -> curl.arm(on, prev, next, spread, x, y, w, h, dpr));
        }
        @JavascriptInterface public void curlNavDone(int token, boolean ok) { main.post(() -> curl.navDone(token, ok)); }
        @JavascriptInterface public void curlEndDone(int token) { main.post(() -> curl.endDone(token)); }
        @JavascriptInterface public boolean curlAuto(int id, int dir, boolean fast) {
            if (curl.getVisibility() != View.VISIBLE) return false;
            java.util.concurrent.FutureTask<Boolean> f = new java.util.concurrent.FutureTask<>(() -> curl.auto(id, dir, fast));
            main.post(f);
            try { return f.get(500, java.util.concurrent.TimeUnit.MILLISECONDS); } catch (Exception e) { return false; }
        }
        @JavascriptInterface public void bars(boolean visible, boolean darkIcons) { main.post(() -> applyBars(visible, darkIcons)); }
        @JavascriptInterface public void close() { main.post(WebActivity.this::finish); }
        @JavascriptInterface public void perf(String label, long ms) { Log.i("ShubianPerf", label + " " + ms + "ms"); }
        /** 分享书摘：JS 画好 PNG 传进来，写进缓存目录，用系统分享面板发出去。 */
        @JavascriptInterface public void shareCard(String dataUrl) {
            main.post(() -> {
                try {
                    int comma = dataUrl == null ? -1 : dataUrl.indexOf(',');
                    String b64 = comma >= 0 ? dataUrl.substring(comma + 1) : dataUrl;
                    byte[] png = Base64.decode(b64, Base64.DEFAULT);
                    File dir = new File(getCacheDir(), "share");
                    dir.mkdirs();
                    long now = System.currentTimeMillis();
                    File[] olds = dir.listFiles();
                    if (olds != null) for (File f : olds) if (now - f.lastModified() > 3600_000L) f.delete();
                    File out = new File(dir, "excerpt-" + now + ".png");
                    try (FileOutputStream fos = new FileOutputStream(out)) { fos.write(png); }
                    Uri uri = Uri.parse("content://" + getPackageName() + ".images/share/" + out.getName());
                    Intent send = new Intent(Intent.ACTION_SEND).setType("image/png").putExtra(Intent.EXTRA_STREAM, uri);
                    send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    startActivity(Intent.createChooser(send, "分享书摘"));
                } catch (Exception e) {
                    Log.w("Shubian", "shareCard", e);
                    emit("toast", JSONObject.quote("分享失败：" + (e.getMessage() == null ? "未知错误" : e.getMessage())));
                }
            });
        }
        @JavascriptInterface public void ready() {
            main.post(() -> {
                Log.i("ShubianPerf", "ready " + (System.currentTimeMillis() - createdAt) + "ms");
                onPageReady();
            });
        }
        @JavascriptInterface public float animScale() {
            return android.provider.Settings.Global.getFloat(getContentResolver(), android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f);
        }
        @JavascriptInterface public String version() {
            try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { return ""; }
        }
        @JavascriptInterface public long versionCode() {
            try {
                android.content.pm.PackageInfo p = getPackageManager().getPackageInfo(getPackageName(), 0);
                return Build.VERSION.SDK_INT >= 28 ? p.getLongVersionCode() : p.versionCode;
            } catch (Exception e) { return 0; }
        }
        @JavascriptInterface public void checkUpdate(String requestKey) {
            net.execute(() -> {
                try {
                    JSONObject m = AppUpdater.check(versionCode());
                    m.put("id", requestKey == null ? "" : requestKey);
                    latestUpdate.set(m);
                    emit("update", m);
                } catch (Exception e) {
                    emit("update", jsonQuiet("state", "error", "id", requestKey == null ? "" : requestKey, "msg", e.getMessage() == null ? "检查更新失败" : e.getMessage()));
                }
            });
        }
        @JavascriptInterface public void installUpdate(String requestKey) {
            JSONObject manifest = latestUpdate.get();
            if (manifest == null || !"available".equals(manifest.optString("state"))) { checkUpdate(requestKey); return; }
            net.execute(() -> {
                try {
                    String key = requestKey == null ? "" : requestKey;
                    emit("update", jsonQuiet("state", "downloading", "id", key, "percent", "0"));
                    File apk = AppUpdater.download(WebActivity.this, manifest, (done, total) -> {
                        int percent = total > 0 ? (int) Math.min(99, done * 100 / total) : 0;
                        emit("update", jsonQuiet("state", "downloading", "id", key, "percent", String.valueOf(percent)));
                    });
                    main.post(() -> startUpdateInstaller(apk, key));
                } catch (Exception e) {
                    emit("update", jsonQuiet("state", "error", "id", requestKey == null ? "" : requestKey, "msg", e.getMessage() == null ? "下载更新失败" : e.getMessage()));
                }
            });
        }

        @JavascriptInterface public void jev(int id, String payload) {
            String key = jevKey();
            net.execute(() -> {
                long t0 = System.currentTimeMillis();
                try {
                    if (key.isEmpty()) throw new IllegalStateException("no key");
                    String[] r = Net.post(Net.JEV_URL, key, payload);
                    emit("jev", new JSONObject().put("id", id).put("status", Integer.parseInt(r[0])).put("body", r[1]));
                } catch (Exception e) {
                    emit("jev", jsonQuiet("id", String.valueOf(id), "status", "0", "body", ""));
                }
                Log.i("ShubianPerf", "jev " + (System.currentTimeMillis() - t0) + "ms");
            });
        }

        @JavascriptInterface public void warmNet() {
            String key = key();
            if (!key.isEmpty()) net.execute(() -> Net.warm(key));
        }

        @JavascriptInterface public void translate(int id, String text, boolean ask) {
            String key = key();
            String system = ask ? ASK_PROMPT : TRANSLATE_PROMPT;
            net.execute(() -> {
                long t0 = System.currentTimeMillis();
                long[] first = {0};
                try {
                    String err = Net.chat(key, system, text, t -> {
                        if (first[0] == 0) { first[0] = System.currentTimeMillis() - t0; Log.i("ShubianPerf", "tr first " + first[0] + "ms"); }
                        emit("tr", jsonQuiet("id", String.valueOf(id), "delta", t));
                    });
                    emit("tr", err == null ? jsonQuiet("id", String.valueOf(id), "done", "1") : jsonQuiet("id", String.valueOf(id), "error", err));
                } catch (Exception e) {
                    emit("tr", jsonQuiet("id", String.valueOf(id), "error", "网络不可用"));
                }
            });
        }

        @JavascriptInterface public String exportCsv(String csv) {
            String prefix = BuildConfig.PUBLIC_EDITION ? "orange-reader" : "书边译";
            String name = prefix + "-生词本-" + new SimpleDateFormat("yyyyMMdd-HHmm", Locale.ROOT).format(new Date()) + ".csv";
            ContentValues v = new ContentValues();
            v.put(MediaStore.Downloads.DISPLAY_NAME, name);
            v.put(MediaStore.Downloads.MIME_TYPE, "text/csv");
            Uri u = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
            if (u == null) return "";
            try (OutputStream o = getContentResolver().openOutputStream(u)) {
                o.write(new byte[]{(byte) 0xEF, (byte) 0xBB, (byte) 0xBF});
                o.write(csv.getBytes(StandardCharsets.UTF_8));
                return name;
            } catch (Exception e) {
                return "";
            }
        }

        // ---------- 课程（Notion 知识库内容包） ----------

        /** 本地 index.json 原文；没有缓存时 ""。首次进课程标签调一次。 */
        @JavascriptInterface public String kbIndex() { return Kb.get(WebActivity.this).index(); }

        /** 后台增量同步（knownRelease 空串=全量）；进度走 emit("kb", {state,done,total,bytes,release,msg})。 */
        @JavascriptInterface public void kbSync(String knownRelease) {
            Kb.get(WebActivity.this).sync(knownRelease, WebActivity.this::emit);
        }

        /** {release, fmt, articles, images, bytes, at}。 */
        @JavascriptInterface public String kbStats() { return Kb.get(WebActivity.this).stats().toString(); }

        @JavascriptInterface public void kbCancel() { Kb.get(WebActivity.this).cancel(); }

        /** 只删课程缓存；阅读进度在 kv 里，不受影响。 */
        @JavascriptInterface public void kbClear() { Kb.get(WebActivity.this).clear(); }

        /** 文章外链交给系统浏览器（shouldOverrideUrlLoading 恒 true，页面里点不开）；只放行 http/https。 */
        @JavascriptInterface public void openExternal(String url) {
            if (url == null) return;
            Uri u = Uri.parse(url.trim());
            String scheme = u.getScheme();
            if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) return;
            main.post(() -> {
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); }
                catch (Exception e) { emit("toast", JSONObject.quote("打不开这个链接")); }
            });
        }

        @JavascriptInterface public String clip() {
            android.content.ClipboardManager cm = getSystemService(android.content.ClipboardManager.class);
            ClipData c = cm.getPrimaryClip();
            if (c == null || c.getItemCount() == 0 || c.getItemAt(0).getText() == null) return "";
            return c.getItemAt(0).getText().toString();
        }
    }

    private void startUpdateInstaller(File apk, String requestKey) {
        String key = requestKey == null ? "" : requestKey;
        if (Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) {
            try {
                startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getPackageName())));
                emit("update", jsonQuiet("state", "permission", "id", key, "msg", "请允许安装未知应用后，再点一次更新"));
            } catch (Exception e) {
                emit("update", jsonQuiet("state", "error", "id", key, "msg", "系统不允许安装更新"));
            }
            return;
        }
        Uri u = UpdateProvider.uri(apk, getPackageName() + ".updates");
        Intent i = new Intent(Intent.ACTION_VIEW).setDataAndType(u, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            startActivity(i);
            emit("update", jsonQuiet("state", "ready", "id", key, "msg", "正在打开安装器"));
        } catch (Exception e) {
            emit("update", jsonQuiet("state", "error", "id", key, "msg", "找不到系统安装器"));
        }
    }
}
