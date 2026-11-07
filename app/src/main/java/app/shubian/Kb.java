package app.shubian;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Pattern;

/**
 * 「课程」板块的本地缓存与增量同步。
 *
 * 远端是同步管线发布的静态内容包（约定见 docs/notion-kb-contract.md）：
 * {@code KB_BASE/index.json} 目录 + {@code releases/<release>/a/<course>/<article>.html} 正文片段
 * + {@code media/<sha>.<ext>} 内容寻址图片。App 只做搬运和缓存，正文渲染交给 WebView。
 *
 * 本地布局（全在 filesDir，不受系统清缓存影响）：{@code filesDir/kb/index.json}、
 * {@code a/<course>/<article>.html}、{@code i/<sha>.<ext>}，由 {@link WebActivity#serve} 以
 * {@code /kb/} 路由返回。
 *
 * 线程：同步跑在单独的单线程 executor 上，同一时刻只允许一个（{@link #sync}）；
 * 进度通过 {@link Callback} 交给界面线程，不在这里碰 WebView。
 */
final class Kb {
    private static final String TAG = "Shubian";
    /** 支持的 index.json fmt；更高的 fmt 仍然可读（文章 HTML 自包含），只记一条日志。 */
    private static final int FMT = 1;
    private static final int CONNECT_TIMEOUT = 20000, READ_TIMEOUT = 30000;
    /** 单个文件失败后的重试间隔：失败重试 2 次（1s / 3s），不拖垮整批。 */
    private static final long[] RETRY_DELAYS = {1000L, 3000L};

    private static final Pattern ID = Pattern.compile("[a-z0-9-]{1,64}");
    private static final Pattern SHA = Pattern.compile("[a-f0-9]{8,64}");
    private static final Pattern EXT = Pattern.compile("[a-z0-9]{2,5}");
    private static final Pattern SEG = Pattern.compile("[0-9A-Za-z._-]{1,80}");
    private static final Pattern RELEASE = Pattern.compile("[0-9A-Za-z._-]{1,40}");

    /** 同步事件：type 为 "kb"（进度/结果）或 "kbIndex"（新索引就绪），data 是 JSON 值。 */
    interface Callback { void emit(String type, Object data); }

    private static Kb instance;

    static synchronized Kb get(Context c) {
        if (instance == null) instance = new Kb(c.getApplicationContext());
        return instance;
    }

    /** 本地缓存根目录 filesDir/kb。 */
    static File dir(Context c) { return new File(c.getFilesDir(), "kb"); }

    /** f 是否在 base 之内（canonical 路径校验，挡住 ../ 穿越）。 */
    static boolean under(File base, File f) {
        try {
            String b = base.getCanonicalPath();
            String p = f.getCanonicalPath();
            return p.equals(b) || p.startsWith(b + File.separator);
        } catch (Exception e) {
            return false;
        }
    }

    private final File root;
    private final ExecutorService exec = Executors.newSingleThreadExecutor();
    private final AtomicBoolean running = new AtomicBoolean(false);
    private volatile boolean cancelled;
    private volatile HttpURLConnection current;

    private Kb(Context c) { root = dir(c); }

    // ---------- 对外接口（桥） ----------

    /** 本地 index.json 原文；没有缓存时返回 ""。小文件同步读，首次进标签调一次。 */
    String index() {
        File f = new File(root, "index.json");
        if (!f.isFile() || f.length() == 0) return "";
        try {
            return readFile(f);
        } catch (Exception e) {
            Log.w(TAG, "kb: 读索引失败");
            return "";
        }
    }

    /** 同步统计：{release, fmt, articles, images, bytes, at}。 */
    JSONObject stats() {
        JSONObject o = new JSONObject();
        try {
            JSONObject idx = readIndex();
            int articles = 0;
            if (idx != null) {
                articles = idx.optInt("articles_total", -1);
                if (articles < 0) articles = countArticles(idx.optJSONArray("courses"));
                o.put("release", idx.optString("release", ""));
                o.put("fmt", idx.optInt("fmt", 0));
            } else {
                o.put("release", "");
                o.put("fmt", 0);
            }
            o.put("articles", Math.max(0, articles));
            o.put("images", countFiles(new File(root, "i")));
            o.put("bytes", sizeOf(root));
            File f = new File(root, "index.json");
            o.put("at", f.isFile() ? f.lastModified() : 0L);
        } catch (Exception e) {
            Log.w(TAG, "kb: 统计失败");
        }
        return o;
    }

    /** 增量同步。knownRelease 是界面手里的 release（空串=不知道），相同就直接 done。 */
    void sync(String knownRelease, Callback cb) {
        final String known = knownRelease == null ? "" : knownRelease.trim();
        final String base = base();
        if (base.isEmpty()) {
            emit(cb, "error", 0, 0, 0, "", "未配置课程同步地址");
            return;
        }
        if (!running.compareAndSet(false, true)) return;   // 已在同步：忽略重复调用
        cancelled = false;
        exec.execute(() -> {
            try {
                run(base, known, cb);
            } catch (Throwable t) {
                Log.w(TAG, "kb: 同步失败 " + t.getClass().getSimpleName());
                emit(cb, "error", 0, 0, 0, "", "同步失败");
            } finally {
                running.set(false);
                cancelled = false;
                current = null;
            }
        });
    }

    /** 取消当前同步；已下载的文件保留，索引不写。 */
    void cancel() {
        cancelled = true;
        HttpURLConnection c = current;
        if (c != null) try { c.disconnect(); } catch (Exception ignored) { }
    }

    /** 清空课程缓存（只删 filesDir/kb），阅读进度在 SharedPreferences 里，不受影响。 */
    void clear() {
        cancel();
        wipe(root);
    }

    // ---------- 同步流程 ----------

    private void run(String base, String known, Callback cb) {
        emit(cb, "checking", 0, 0, 0, "", null);
        JSONObject remote;
        try {
            remote = readJson(base + "/index.json");
        } catch (Exception e) {
            Log.w(TAG, "kb: 拉索引失败 " + e.getClass().getSimpleName());
            emit(cb, "error", 0, 0, 0, "", "连不上课程服务器");
            return;
        }
        String release = remote.optString("release", "").trim();
        JSONArray courses = remote.optJSONArray("courses");
        if (!RELEASE.matcher(release).matches() || courses == null) {
            emit(cb, "error", 0, 0, 0, "", "课程索引格式不对");
            return;
        }
        if (remote.optInt("fmt", 0) != FMT) Log.i(TAG, "kb: index fmt " + remote.optInt("fmt", 0) + " (App 支持 " + FMT + ")");

        JSONObject local = readIndex();
        if (local != null) {
            String localRelease = local.optString("release", "");
            // 本地已经有同一版，或者界面手里的就是最新版，且缓存索引还在 → 不用动
            if (release.equals(localRelease) || release.equals(known)) {
                emit(cb, "done", 0, 0, 0, release, null);
                return;
            }
        }

        List<Item> items = new ArrayList<>();
        plan(courses, base, updatedMap(local), items);
        int total = items.size();
        emit(cb, "downloading", 0, total, 0, release, null);

        long bytes = 0;
        int finished = 0, failed = 0;
        for (Item it : items) {
            if (cancelled) break;
            try {
                bytes += fetch(it.address, it.file);
            } catch (Exception e) {
                failed++;
                Log.w(TAG, "kb: 下载失败 " + it.file.getName());
            }
            finished++;
            emit(cb, "downloading", finished, total, bytes, release, null);
        }
        if (cancelled) {
            emit(cb, "done", finished, total, bytes, release, "已取消");
            return;
        }
        if (failed > 0) {
            // 有文件没下全就保留旧索引，下次同步只补缺的部分
            emit(cb, "error", finished - failed, total, bytes, "", "有 " + failed + " 项下载失败");
            return;
        }
        try {
            writeIndex(remote.toString());
        } catch (Exception e) {
            Log.w(TAG, "kb: 写索引失败");
            emit(cb, "error", finished, total, bytes, "", "无法保存课程索引");
            return;
        }
        try { cb.emit("kbIndex", remote); } catch (Throwable ignored) { }
        emit(cb, "done", total, total, bytes, release, null);
    }

    /** 列出这轮要下的文件：新增/更新过的文章，以及本地还没有的图片（按 sha 去重）。 */
    private void plan(JSONArray courses, String base, Map<String, Meta> prev, List<Item> out) {
        Set<String> images = new HashSet<>();
        for (int i = 0; i < courses.length(); i++) {
            JSONObject c = courses.optJSONObject(i);
            if (c == null) continue;
            String cid = c.optString("id", "");
            if (!ID.matcher(cid).matches()) {
                Log.w(TAG, "kb: 跳过 id 不合法的课程 #" + i);
                continue;
            }
            JSONArray articles = c.optJSONArray("articles");
            if (articles == null) continue;
            for (int j = 0; j < articles.length(); j++) {
                JSONObject a = articles.optJSONObject(j);
                if (a == null) continue;
                String aid = a.optString("id", "");
                if (!ID.matcher(aid).matches()) {
                    Log.w(TAG, "kb: 跳过 id 不合法的文章 " + cid + "/#" + j);
                    continue;
                }
                File html = file("a/" + cid + "/" + aid + ".html");
                if (html == null) continue;
                boolean same = html.isFile() && html.length() > 0 && sameVersion(a, prev.get(cid + "/" + aid));
                if (!same) {
                    String address = articleUrl(base, a.optString("path", ""));
                    if (address == null) Log.w(TAG, "kb: 跳过 path 不合法的文章 " + cid + "/" + aid);
                    else out.add(new Item(address, html));
                }
                JSONArray imgs = a.optJSONArray("images");
                if (imgs == null) continue;
                for (int k = 0; k < imgs.length(); k++) {
                    JSONObject im = imgs.optJSONObject(k);
                    if (im == null) continue;
                    String sha = im.optString("sha", "");
                    String ext = im.optString("ext", "webp").toLowerCase(Locale.ROOT);
                    if (!SHA.matcher(sha).matches() || !EXT.matcher(ext).matches()) {
                        Log.w(TAG, "kb: 跳过图片 " + cid + "/" + aid + "#" + k);
                        continue;
                    }
                    String name = sha + "." + ext;
                    File f = file("i/" + name);
                    if (f == null || !images.add(name)) continue;
                    if (f.isFile() && f.length() > 0) continue;
                    out.add(new Item(base + "/media/" + name, f));
                }
            }
        }
    }

    private static int countArticles(JSONArray courses) {
        int n = 0;
        if (courses == null) return 0;
        for (int i = 0; i < courses.length(); i++) {
            JSONObject c = courses.optJSONObject(i);
            JSONArray a = c == null ? null : c.optJSONArray("articles");
            if (a != null) n += a.length();
        }
        return n;
    }

    private static Map<String, Meta> updatedMap(JSONObject idx) {
        Map<String, Meta> m = new HashMap<>();
        if (idx == null) return m;
        JSONArray courses = idx.optJSONArray("courses");
        if (courses == null) return m;
        for (int i = 0; i < courses.length(); i++) {
            JSONObject c = courses.optJSONObject(i);
            if (c == null) continue;
            String cid = c.optString("id", "");
            JSONArray articles = c.optJSONArray("articles");
            if (articles == null) continue;
            for (int j = 0; j < articles.length(); j++) {
                JSONObject a = articles.optJSONObject(j);
                if (a == null) continue;
                m.put(cid + "/" + a.optString("id", ""), new Meta(a.optString("sha", ""), a.optString("updated", "")));
            }
        }
        return m;
    }

    /**
     * 远端这篇文章和本地缓存是不是同一版。
     * 优先比 sha（HTML 内容的 sha256 前 16 位）：同步侧重新烘焙 HTML 时 updated 不变，只有 sha 变，所以
     * 远端有 sha 时一律以 sha 为准；远端有 sha 而本地没有（旧索引 / 首次升级）视为变了，必须重下。
     * 远端没有 sha（旧版索引）时退回比 updated。
     */
    private static boolean sameVersion(JSONObject article, Meta prev) {
        if (prev == null) return false;
        String sha = article.optString("sha", "");
        if (!sha.isEmpty()) return sha.equals(prev.sha);
        String updated = article.optString("updated", "");
        return !updated.isEmpty() && updated.equals(prev.updated);
    }

    /** 一篇文章的版本标识：新索引有 sha（HTML sha256 前 16 位），旧索引只有 updated。 */
    private static final class Meta {
        final String sha, updated;

        Meta(String sha, String updated) {
            this.sha = sha;
            this.updated = updated;
        }
    }

    /** 文章 path 是相对 KB_BASE 的 releases/<release>/a/<course>/<article>.html。 */
    private static String articleUrl(String base, String path) {
        String p = path == null ? "" : path.trim();
        while (p.startsWith("/")) p = p.substring(1);
        String[] seg = p.split("/", -1);
        if (seg.length < 5 || !"releases".equals(seg[0]) || !"a".equals(seg[2])) return null;
        for (String s : seg) {
            if (!SEG.matcher(s).matches() || ".".equals(s) || "..".equals(s)) return null;
        }
        if (!seg[seg.length - 1].endsWith(".html")) return null;
        return base + "/" + p;
    }

    // ---------- 网络 ----------

    private JSONObject readJson(String address) throws Exception {
        Exception last = null;
        for (int attempt = 0; attempt <= 1; attempt++) {
            if (cancelled) throw new Exception("已取消");
            if (attempt > 0) Thread.sleep(1000);
            try {
                return new JSONObject(text(address));
            } catch (Exception e) {
                last = e;
                Log.w(TAG, "kb: 索引请求失败 " + (attempt + 1) + "/2 " + e.getClass().getSimpleName());
            }
        }
        throw last == null ? new Exception("读取失败") : last;
    }

    private String text(String address) throws Exception {
        HttpURLConnection c = open(address);
        current = c;
        try {
            int code = c.getResponseCode();
            if (code < 200 || code >= 300) throw new Exception("服务器返回 " + code);
            try (InputStream in = new BufferedInputStream(c.getInputStream())) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[16 * 1024];
                for (int n; (n = in.read(buf)) != -1; ) out.write(buf, 0, n);
                return out.toString(StandardCharsets.UTF_8.name());
            }
        } finally {
            current = null;
            c.disconnect();
        }
    }

    /** 下载单个文件，先写 .part 再 rename，失败重试 2 次（1s/3s）。 */
    private long fetch(String address, File target) throws Exception {
        Exception last = null;
        for (int attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
            if (cancelled) throw new Exception("已取消");
            if (attempt > 0) Thread.sleep(RETRY_DELAYS[attempt - 1]);
            try {
                return download(address, target);
            } catch (Exception e) {
                last = e;
                Log.w(TAG, "kb: " + target.getName() + " 第 " + (attempt + 1) + " 次失败");
            }
        }
        throw last == null ? new Exception("下载失败") : last;
    }

    private long download(String address, File target) throws Exception {
        File parent = target.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new Exception("无法创建缓存目录");
        File part = new File(parent, target.getName() + ".part");
        HttpURLConnection c = open(address);
        current = c;
        try {
            int code = c.getResponseCode();
            if (code < 200 || code >= 300) throw new Exception("服务器返回 " + code);
            long n = 0;
            try (InputStream in = new BufferedInputStream(c.getInputStream());
                 BufferedOutputStream out = new BufferedOutputStream(new FileOutputStream(part))) {
                byte[] buf = new byte[64 * 1024];
                for (int r; (r = in.read(buf)) != -1; ) {
                    if (cancelled) throw new Exception("已取消");
                    out.write(buf, 0, r);
                    n += r;
                }
            }
            if (n == 0) throw new Exception("内容为空");
            if (target.exists() && !target.delete()) throw new Exception("无法覆盖旧文件");
            if (!part.renameTo(target)) throw new Exception("无法保存文件");
            return n;
        } finally {
            current = null;
            c.disconnect();
            if (part.exists()) part.delete();
        }
    }

    /** 只信任 https + KB_BASE 前缀；debug 包额外放行模拟器/本机回环的 http（本地联调用）。 */
    private HttpURLConnection open(String address) throws Exception {
        String base = base();
        if (base.isEmpty()) throw new Exception("未配置课程同步地址");
        URL u = new URL(address);
        String proto = u.getProtocol() == null ? "" : u.getProtocol().toLowerCase(Locale.ROOT);
        boolean https = "https".equals(proto);
        boolean dev = BuildConfig.DEBUG && "http".equals(proto) && localHost(u.getHost());
        if (!https && !dev) throw new Exception("课程地址不受信任");
        if (!u.toString().startsWith(base + "/")) throw new Exception("课程地址不受信任");
        HttpURLConnection c = (HttpURLConnection) u.openConnection();
        c.setConnectTimeout(CONNECT_TIMEOUT);
        c.setReadTimeout(READ_TIMEOUT);
        c.setInstanceFollowRedirects(false);
        c.setRequestProperty("Accept-Encoding", "identity");
        String token = token();
        if (!token.isEmpty()) c.setRequestProperty("X-KB-Token", token);
        return c;
    }

    private static String base() {
        String b = BuildConfig.KB_BASE == null ? "" : BuildConfig.KB_BASE.trim();
        while (b.endsWith("/")) b = b.substring(0, b.length() - 1);
        return b;
    }

    private static String token() {
        return BuildConfig.KB_TOKEN == null ? "" : BuildConfig.KB_TOKEN.trim();
    }

    private static boolean localHost(String host) {
        if (host == null) return false;
        return "127.0.0.1".equals(host) || "localhost".equals(host) || "10.0.2.2".equals(host) || "::1".equals(host);
    }

    // ---------- 本地文件 ----------

    private File file(String rel) {
        File f = new File(root, rel);
        return under(root, f) ? f : null;
    }

    private JSONObject readIndex() {
        File f = new File(root, "index.json");
        if (!f.isFile() || f.length() == 0) return null;
        try {
            return new JSONObject(readFile(f));
        } catch (Exception e) {
            return null;
        }
    }

    private void writeIndex(String text) throws Exception {
        if (!root.isDirectory() && !root.mkdirs()) throw new Exception("无法创建缓存目录");
        File target = new File(root, "index.json");
        File part = new File(root, "index.json.part");
        try (FileOutputStream out = new FileOutputStream(part)) {
            out.write(text.getBytes(StandardCharsets.UTF_8));
        }
        if (target.exists() && !target.delete()) throw new Exception("无法替换索引");
        if (!part.renameTo(target)) throw new Exception("无法保存索引");
    }

    private static String readFile(File f) throws Exception {
        try (InputStream in = new BufferedInputStream(new FileInputStream(f))) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16 * 1024];
            for (int n; (n = in.read(buf)) != -1; ) out.write(buf, 0, n);
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }

    private static void wipe(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) wipe(k);
        f.delete();
    }

    private static int countFiles(File dir) {
        File[] kids = dir.listFiles();
        if (kids == null) return 0;
        int n = 0;
        for (File k : kids) n += k.isDirectory() ? countFiles(k) : 1;
        return n;
    }

    private static long sizeOf(File dir) {
        File[] kids = dir.listFiles();
        if (kids == null) return 0;
        long n = 0;
        for (File k : kids) n += k.isDirectory() ? sizeOf(k) : k.length();
        return n;
    }

    // ---------- 事件 ----------

    private static void emit(Callback cb, String state, long done, long total, long bytes, String release, String msg) {
        if (cb == null) return;
        JSONObject o = new JSONObject();
        try {
            o.put("state", state);
            o.put("done", done);
            o.put("total", total);
            o.put("bytes", bytes);
            o.put("release", release == null ? "" : release);
            if (msg != null) o.put("msg", msg);
        } catch (Exception ignored) { }
        try {
            cb.emit("kb", o);
        } catch (Throwable ignored) { }
    }

    private static final class Item {
        final String address;
        final File file;

        Item(String address, File file) {
            this.address = address;
            this.file = file;
        }
    }
}
