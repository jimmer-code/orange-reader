package app.shubian;

import android.content.Context;
import android.content.SharedPreferences;

/** App state as JSON strings. */
final class Store {
    private final SharedPreferences kv;

    Store(Context c) {
        kv = c.getSharedPreferences("kv", Context.MODE_PRIVATE);
    }

    String get(String k) { return kv.getString(k, null); }
    void set(String k, String v) { kv.edit().putString(k, v).apply(); }
    void commit(String k, String v) { kv.edit().putString(k, v).commit(); }
}
