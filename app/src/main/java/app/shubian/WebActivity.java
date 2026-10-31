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
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.speech.tts.TextToSpeech;
import android.util.Log;
import android.view.KeyEvent;
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
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
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
    protected Store store;
    protected final Handler main = new Handler(Looper.getMainLooper());
    protected final ExecutorService io = Executors.newSingleThreadExecutor();
    private final ExecutorService net = Executors.newCachedThreadPool();
    private final Map<String, ZipFile> zips = new HashMap<>();
    private TextToSpeech tts;
    private volatile boolean ttsReady, ttsFailed, reading;
    private volatile String ttsPending;
    private boolean pageReady;
    private String insetsJs;
    protected long createdAt;

    protected abstract String startUrl();
    protected boolean transparent() { return false; }

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        createdAt = System.currentTimeMillis();
        store = new Store(this);
        getWindow().setDecorFitsSystemWindows(false);
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true);
        FrameLayout root = new FrameLayout(this);
        web = new WebView(this);
        web.setBackgroundColor(transparent() ? Color.TRANSPARENT : getColor(R.color.bg));
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
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
            if (lp.bottomMargin != ime.bottom) { lp.bottomMargin = ime.bottom; web.setLayoutParams(lp); }
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
            } else {
                in = getAssets().open("web" + (path.equals("/") ? "/index.html" : path));
            }
            WebResourceResponse r = new WebResourceResponse(mime(path), "utf-8", in);
            Map<String, String> h = new HashMap<>();
            h.put("Access-Control-Allow-Origin", "*");
            h.put("Cache-Control", path.startsWith("/scan/") ? "no-store" : "max-age=31536000");
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

    void startCamera() {
        Intent i = new Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT, ImageProvider.CAPTURE)
                .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        i.setClipData(ClipData.newRawUri("", ImageProvider.CAPTURE));
        try { startActivityForResult(i, REQ_CAMERA); } catch (Exception e) { emit("toast", JSONObject.quote("没有可用的相机")); }
    }

    @Override protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (res != RESULT_OK) { if (req != REQ_IMPORT) emit("scanCancel", "0"); return; }
        if (req == REQ_IMPORT && data != null) {
            if (data.getClipData() != null) for (int i = 0; i < data.getClipData().getItemCount(); i++) importBook(data.getClipData().getItemAt(i).getUri());
            else if (data.getData() != null) importBook(data.getData());
        } else if (req == REQ_CAMERA) {
            scan(ImageProvider.CAPTURE);
        } else if (req == REQ_ALBUM && data != null && data.getData() != null) {
            scan(data.getData());
        }
    }

    void importBook(Uri uri) {
        String key = String.valueOf(System.nanoTime());
        io.execute(() -> {
            try {
                String id = Epub.copyIn(this, uri);
                JSONObject meta = Epub.parse(this, id);
                emit("import", new JSONObject().put("state", "done").put("key", key).put("book", meta));
            } catch (Epub.Rejected r) {
                String msg = r.getMessage().startsWith("dup:") ? "已在书库" : r.getMessage();
                emit("import", jsonQuiet("state", "error", "msg", msg));
            } catch (Exception e) {
                Log.w("Shubian", "import failed", e);
                emit("import", jsonQuiet("state", "error", "msg", "无法读取这本书"));
            }
        });
    }

    private void scan(Uri uri) {
        io.execute(() -> {
            try {
                File out = new File(Scan.dir(this), "page-" + System.currentTimeMillis() + ".jpg");
                File[] old = Scan.dir(this).listFiles((d, n) -> n.startsWith("page-"));
                if (old != null) for (File f : old) f.delete();
                android.graphics.Bitmap bmp = Scan.prepare(this, uri, out);
                emit("scanImage", new JSONObject().put("url", "/scan/" + out.getName()).put("w", bmp.getWidth()).put("h", bmp.getHeight()));
                Scan.recognize(this, bmp, known(), r -> emit("ocr", r));
            } catch (Exception e) {
                Log.w("Shubian", "scan failed", e);
                emit("ocr", jsonQuiet("ok", "false"));
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

    String key() {
        return BuildConfig.OPENCODE_KEY;
    }

    // ---------- bridge ----------

    final class Bridge {
        @JavascriptInterface public String lookup(String w) throws Exception { return Dict.get(WebActivity.this).lookup(w).toString(); }
        @JavascriptInterface public String prefix(String q) throws Exception { return Dict.get(WebActivity.this).prefix(q).toString(); }
        @JavascriptInterface public String formsOf(String lemmas) throws Exception { return Dict.get(WebActivity.this).formsOf(new JSONArray(lemmas)).toString(); }
        @JavascriptInterface public String kvGet(String k) { return store.get(k); }
        @JavascriptInterface public void kvSet(String k, String v) { store.set(k, v); }
        @JavascriptInterface public boolean hasJev() { return !key().isEmpty(); }
        @JavascriptInterface public boolean hasTr() { return !key().isEmpty(); }
        /** True while the engine is still starting; false only when no English voice is available. */
        @JavascriptInterface public boolean canSpeak() { return !ttsFailed; }
        @JavascriptInterface public void speak(String t) {
            if (ttsReady) tts.speak(t, TextToSpeech.QUEUE_FLUSH, null, "w"); else ttsPending = t;
        }
        @JavascriptInterface public String books() throws Exception { return Epub.list(WebActivity.this).toString(); }
        @JavascriptInterface public void deleteBook(String id) {
            main.post(() -> {
                ZipFile z = zips.remove(id);
                if (z != null) try { z.close(); } catch (Exception ignored) { }
                Epub.delete(WebActivity.this, id);
            });
        }
        @JavascriptInterface public void importBooks() {
            main.post(() -> startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                    .setType("application/epub+zip").putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true), REQ_IMPORT));
        }
        @JavascriptInterface public void camera() { main.post(WebActivity.this::startCamera); }
        @JavascriptInterface public void album() {
            main.post(() -> startActivityForResult(new Intent(MediaStore.ACTION_PICK_IMAGES).setType("image/*"), REQ_ALBUM));
        }
        @JavascriptInterface public void keyboard(boolean show) {
            main.post(() -> {
                InputMethodManager imm = getSystemService(InputMethodManager.class);
                if (show) { web.requestFocus(); imm.showSoftInput(web, 0); }
                else imm.hideSoftInputFromWindow(web.getWindowToken(), 0);
            });
        }
        @JavascriptInterface public void reading(boolean on) { reading = on; }
        @JavascriptInterface public void bars(boolean visible, boolean darkIcons) { main.post(() -> applyBars(visible, darkIcons)); }
        @JavascriptInterface public void close() { main.post(WebActivity.this::finish); }
        @JavascriptInterface public void perf(String label, long ms) { Log.i("ShubianPerf", label + " " + ms + "ms"); }
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

        @JavascriptInterface public void jev(int id, String payload) {
            String key = key();
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

        @JavascriptInterface public void translate(int id, String text, boolean ask) {
            String key = key();
            String system = ask ? "用户在读英文书时遇到一个词典里查不到的词。用简体中文简要解释它的意思；给了句子时，说明它在句中的意思。"
                    : "把用户给出的英文译成自然的简体中文，只输出译文";
            net.execute(() -> {
                try {
                    String err = Net.chat(key, system, text, t -> emit("tr", jsonQuiet("id", String.valueOf(id), "delta", t)));
                    emit("tr", err == null ? jsonQuiet("id", String.valueOf(id), "done", "1") : jsonQuiet("id", String.valueOf(id), "error", err));
                } catch (Exception e) {
                    emit("tr", jsonQuiet("id", String.valueOf(id), "error", "网络不可用"));
                }
            });
        }

        @JavascriptInterface public String exportCsv(String csv) {
            String name = "书边译-生词本-" + new SimpleDateFormat("yyyyMMdd-HHmm", Locale.ROOT).format(new Date()) + ".csv";
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

        @JavascriptInterface public String clip() {
            android.content.ClipboardManager cm = getSystemService(android.content.ClipboardManager.class);
            ClipData c = cm.getPrimaryClip();
            if (c == null || c.getItemCount() == 0 || c.getItemAt(0).getText() == null) return "";
            return c.getItemAt(0).getText().toString();
        }
    }
}
