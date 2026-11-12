package app.shubian;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Jev and chat-completions calls. Provider keys are consumed only by this native network layer.
 * Connections are never disconnect()ed: on Android that closes the socket, and a fresh TLS handshake
 * costs several hundred ms. Closing the fully read stream returns it to the pool.
 */
final class Net {
    interface Sink { void chunk(String text); }

    // Jev via OpenRouter (opencode.ai Zen is unreachable where the app runs).
    // Models: jev-latest or jev-1.13 (not the OpenRouter chat-router typesafe/jev-router).
    static final String JEV_URL = "https://openrouter.ai/api/v1/systemone";
    static final String CHAT_URL = BuildConfig.PUBLIC_EDITION
            ? "https://api.deepseek.com/chat/completions"
            : "https://opencode.ai/zen/go/v1/chat/completions";
    // Official DeepSeek calls use the API id deepseek-flash for DeepSeek V4.1 Flash.
    static final String CHAT_MODEL = BuildConfig.PUBLIC_EDITION ? "deepseek-flash" : "deepseek-v4.1-flash";
    static final String MODELS_URL = BuildConfig.PUBLIC_EDITION
            ? "https://api.deepseek.com/models"
            : "https://opencode.ai/zen/go/v1/models";
    // One session id per app run is enough for OpenCode Go routing.
    private static final String SESSION = "shubian-" + java.util.UUID.randomUUID();
    private static volatile long lastUse;

    private static HttpURLConnection open(String url, String key, String body) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(20000);
        c.setReadTimeout(20000);
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setRequestProperty("Authorization", "Bearer " + key);
        c.setRequestProperty("Content-Type", "application/json");
        if (!BuildConfig.PUBLIC_EDITION) c.setRequestProperty("x-opencode-session", SESSION);
        try (OutputStream o = c.getOutputStream()) { o.write(body.getBytes(StandardCharsets.UTF_8)); }
        lastUse = System.currentTimeMillis();
        return c;
    }

    private static String drain(InputStream in) throws Exception {
        if (in == null) return "";
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        try (InputStream i = in) {
            byte[] buf = new byte[8192];
            for (int n; (n = i.read(buf)) > 0; ) b.write(buf, 0, n);
        }
        return b.toString("UTF-8");
    }

    /** Opens a pooled connection ahead of a likely translation. Skipped if one was used recently. */
    static void warm(String key) {
        if (System.currentTimeMillis() - lastUse < 30000) return;
        lastUse = System.currentTimeMillis();
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(MODELS_URL).openConnection();
            c.setConnectTimeout(10000);
            c.setReadTimeout(10000);
            c.setRequestProperty("Authorization", "Bearer " + key);
            int code = c.getResponseCode();
            drain(code < 400 ? c.getInputStream() : c.getErrorStream());
        } catch (Exception ignored) { }
    }

    /** Checks a provider key without generating a billable translation. */
    static int testKey(String key) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(MODELS_URL).openConnection();
        c.setConnectTimeout(10000);
        c.setReadTimeout(10000);
        c.setRequestMethod("GET");
        c.setRequestProperty("Authorization", "Bearer " + key);
        int code = c.getResponseCode();
        drain(code < 400 ? c.getInputStream() : c.getErrorStream());
        return code;
    }

    /** Returns [status, body]. */
    static String[] post(String url, String key, String body) throws Exception {
        HttpURLConnection c = open(url, key, body);
        int code = c.getResponseCode();
        return new String[]{String.valueOf(code), drain(code < 400 ? c.getInputStream() : c.getErrorStream())};
    }

    /** OpenAI-compatible streaming chat. Returns null on success or an error message. */
    static String chat(String key, String system, String user, Sink sink) throws Exception {
        // Thinking off: reasoning adds 1-3 s before the first translated character.
        // Translation cards contain short excerpts. Keep the output budget bounded so the
        // provider can finish quickly while retaining the disabled-thinking fast path.
        JSONObject req = new JSONObject().put("model", CHAT_MODEL).put("stream", true).put("temperature", 0.2).put("max_tokens", 800)
                .put("thinking", new JSONObject().put("type", "disabled")).put("messages", new JSONArray()
                .put(new JSONObject().put("role", "system").put("content", system))
                .put(new JSONObject().put("role", "user").put("content", user)));
        HttpURLConnection c = open(CHAT_URL, key, req.toString());
        int code = c.getResponseCode();
        if (code >= 400) {
            drain(c.getErrorStream());
            return "请求失败（" + code + "）";
        }
        try (BufferedReader rd = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8))) {
            for (String line; (line = rd.readLine()) != null; ) {
                if (!line.startsWith("data:")) continue;
                String data = line.substring(5).trim();
                if (data.equals("[DONE]")) break;
                JSONObject d = new JSONObject(data).getJSONArray("choices").getJSONObject(0).optJSONObject("delta");
                if (d != null && d.has("content") && !d.isNull("content")) sink.chunk(d.getString("content"));
            }
        }
        return null;
    }
}
