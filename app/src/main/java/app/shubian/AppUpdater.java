package app.shubian;

import android.content.Context;
import android.os.Environment;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/** Fetches and verifies the small update manifest and its APK. */
final class AppUpdater {
    private static final String CHANNEL = BuildConfig.PUBLIC_EDITION ? "shubian-translate-public" : "shubian-translate";
    static final String CHECK_URL = "https://update.lemonation.cloud/" + CHANNEL + "/latest.json";
    private static final String HOST = "update.lemonation.cloud";
    private static final String PATH_PREFIX = "/" + CHANNEL + "/";

    interface Progress { void onProgress(long downloaded, long total); }

    static JSONObject check(long currentVersionCode) throws Exception {
        HttpURLConnection c = connection(CHECK_URL);
        c.setRequestMethod("GET");
        int code = c.getResponseCode();
        if (code < 200 || code >= 300) throw new Exception("服务器返回 " + code);
        String body;
        try (InputStream in = c.getInputStream()) { body = readText(in); }
        JSONObject m = new JSONObject(body);
        validateManifest(m);
        m.put("state", m.getLong("versionCode") > currentVersionCode ? "available" : "current");
        return m;
    }

    static File download(Context context, JSONObject manifest, Progress progress) throws Exception {
        validateManifest(manifest);
        File dir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (dir == null) dir = new File(context.getFilesDir(), "updates");
        if (!dir.isDirectory() && !dir.mkdirs()) throw new Exception("无法创建更新目录");
        String version = manifest.getString("version").replaceAll("[^0-9A-Za-z._-]", "_");
        File target = new File(dir, "orange-reader-" + version + ".apk");
        File part = new File(dir, target.getName() + ".part");
        if (part.exists() && !part.delete()) throw new Exception("无法覆盖旧的下载");

        HttpURLConnection c = connection(manifest.getString("apkUrl"));
        c.setRequestMethod("GET");
        int code = c.getResponseCode();
        if (code < 200 || code >= 300) throw new Exception("下载失败（" + code + "）");
        long expected = manifest.optLong("size", -1);
        long total = c.getContentLengthLong() > 0 ? c.getContentLengthLong() : expected;
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        long done = 0;
        try (InputStream in = new BufferedInputStream(c.getInputStream());
             BufferedOutputStream out = new BufferedOutputStream(new FileOutputStream(part))) {
            byte[] buf = new byte[64 * 1024];
            for (int n; (n = in.read(buf)) != -1; ) {
                if (n == 0) continue;
                out.write(buf, 0, n);
                digest.update(buf, 0, n);
                done += n;
                progress.onProgress(done, total);
            }
        }
        if (expected > 0 && done != expected) throw new Exception("文件大小校验失败");
        String actual = hex(digest.digest());
        if (!actual.equalsIgnoreCase(manifest.getString("sha256"))) throw new Exception("文件校验失败");
        if (target.exists() && !target.delete()) throw new Exception("无法替换旧版本");
        if (!part.renameTo(target)) throw new Exception("无法保存更新文件");
        return target;
    }

    private static HttpURLConnection connection(String address) throws Exception {
        URL u = new URL(address);
        if (!"https".equals(u.getProtocol()) || !HOST.equals(u.getHost()) || !u.getPath().startsWith(PATH_PREFIX))
            throw new Exception("更新地址不受信任");
        HttpURLConnection c = (HttpURLConnection) u.openConnection();
        c.setConnectTimeout(20000);
        c.setReadTimeout(30000);
        c.setInstanceFollowRedirects(false);
        c.setRequestProperty("Accept-Encoding", "identity");
        return c;
    }

    private static void validateManifest(JSONObject m) throws Exception {
        long code = m.optLong("versionCode", 0);
        String version = m.optString("version", "");
        String url = m.optString("apkUrl", "");
        String sha = m.optString("sha256", "");
        if (code <= 0 || !version.matches("[0-9]+\\.[0-9]+(?:\\.[0-9]+)?") || sha.length() != 64)
            throw new Exception("更新清单格式不对");
        if (!url.startsWith("https://" + HOST + PATH_PREFIX) || !url.endsWith(".apk"))
            throw new Exception("更新地址不受信任");
    }

    private static String readText(InputStream in) throws Exception {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] b = new byte[8192];
        for (int n; (n = in.read(b)) != -1; ) out.write(b, 0, n);
        return out.toString(StandardCharsets.UTF_8.name());
    }

    private static String hex(byte[] bytes) {
        StringBuilder s = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) s.append(String.format("%02x", b & 0xff));
        return s.toString();
    }
}
