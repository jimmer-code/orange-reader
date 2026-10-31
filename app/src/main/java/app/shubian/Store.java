package app.shubian;

import android.content.Context;
import android.content.SharedPreferences;

/** App state as JSON strings, plus API keys kept apart from anything the page can read back. */
final class Store {
    private final SharedPreferences kv, secret;

    Store(Context c) {
        kv = c.getSharedPreferences("kv", Context.MODE_PRIVATE);
        secret = c.getSharedPreferences("secret", Context.MODE_PRIVATE);
    }

    String get(String k) { return kv.getString(k, null); }
    void set(String k, String v) { kv.edit().putString(k, v).apply(); }

    String secret(String k) { return secret.getString(k, ""); }
    void setSecret(String k, String v) { secret.edit().putString(k, v == null ? "" : v.trim()).apply(); }
    boolean hasSecret(String k) { return !secret(k).isEmpty(); }
}
