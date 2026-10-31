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

/** Jev and chat-completions calls. Keys are added here and never pass through the page. */
final class Net {
    interface Sink { void chunk(String text); }

    static final String JEV_URL = "https://opencode.ai/zen/v1/systemone";
    static final String CHAT_URL = "https://opencode.ai/zen/go/v1/chat/completions";
    static final String CHAT_MODEL = "deepseek-v4.1-flash";
    // OpenCode Go rejects chat requests without a session id; one per app run is enough for routing.
    private static final String SESSION = "shubian-" + java.util.UUID.randomUUID();

    private static HttpURLConnection open(String url, String key, String body) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(20000);
        c.setReadTimeout(20000);
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setRequestProperty("Authorization", "Bearer " + key);
        c.setRequestProperty("Content-Type", "application/json");
        c.setRequestProperty("x-opencode-session", SESSION);
        try (OutputStream o = c.getOutputStream()) { o.write(body.getBytes(StandardCharsets.UTF_8)); }
        return c;
    }

    /** Returns [status, body]. */
    static String[] post(String url, String key, String body) throws Exception {
        HttpURLConnection c = open(url, key, body);
        int code = c.getResponseCode();
        InputStream in = code < 400 ? c.getInputStream() : c.getErrorStream();
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        if (in != null) {
            byte[] buf = new byte[8192];
            for (int n; (n = in.read(buf)) > 0; ) b.write(buf, 0, n);
            in.close();
        }
        c.disconnect();
        return new String[]{String.valueOf(code), b.toString("UTF-8")};
    }

    /** OpenAI-compatible streaming chat. Returns null on success or an error message. */
    static String chat(String key, String system, String user, Sink sink) throws Exception {
        // Thinking off: reasoning adds 1-3 s before the first translated character.
        JSONObject req = new JSONObject().put("model", CHAT_MODEL).put("stream", true)
                .put("thinking", new JSONObject().put("type", "disabled")).put("messages", new JSONArray()
                .put(new JSONObject().put("role", "system").put("content", system))
                .put(new JSONObject().put("role", "user").put("content", user)));
        HttpURLConnection c = open(CHAT_URL, key, req.toString());
        int code = c.getResponseCode();
        if (code >= 400) {
            String[] r = {String.valueOf(code)};
            c.disconnect();
            return "请求失败（" + r[0] + "）";
        }
        try (BufferedReader rd = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8))) {
            for (String line; (line = rd.readLine()) != null; ) {
                if (!line.startsWith("data:")) continue;
                String data = line.substring(5).trim();
                if (data.equals("[DONE]")) break;
                JSONObject d = new JSONObject(data).getJSONArray("choices").getJSONObject(0).optJSONObject("delta");
                if (d != null && d.has("content") && !d.isNull("content")) sink.chunk(d.getString("content"));
            }
        } finally {
            c.disconnect();
        }
        return null;
    }
}
