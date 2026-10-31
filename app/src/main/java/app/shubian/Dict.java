package app.shubian;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Locale;

/** Offline ECDICT lookup. The db ships in assets and is copied once per app version. */
final class Dict {
    private static final int VERSION = 3;
    private static Dict instance;
    private final SQLiteDatabase db;

    static synchronized Dict get(Context c) {
        if (instance == null) instance = new Dict(c.getApplicationContext());
        return instance;
    }

    private Dict(Context c) {
        File f = c.getDatabasePath("dict.db");
        if (c.getSharedPreferences("dict", 0).getInt("v", 0) != VERSION || !f.exists()) {
            copy(c, f);
            c.getSharedPreferences("dict", 0).edit().putInt("v", VERSION).apply();
        }
        db = SQLiteDatabase.openDatabase(f.getPath(), null, SQLiteDatabase.OPEN_READONLY);
    }

    private static void copy(Context c, File f) {
        f.getParentFile().mkdirs();
        try (InputStream in = c.getAssets().open("dict.db"); OutputStream out = new FileOutputStream(f)) {
            byte[] b = new byte[1 << 16];
            for (int n; (n = in.read(b)) > 0; ) out.write(b, 0, n);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    static String kindLabel(String k) {
        switch (k) {
            case "p": return "过去式";
            case "d": return "过去分词";
            case "i": return "现在分词";
            case "3": return "第三人称单数";
            case "r": return "比较级";
            case "t": return "最高级";
            default: return "复数";
        }
    }

    static String normalize(String raw) {
        String w = raw.trim().replace('’', '\'').toLowerCase(Locale.ROOT);
        if (w.endsWith("'s")) w = w.substring(0, w.length() - 2);
        return w.replaceAll("^[^a-z]+|[^a-z]+$", "");
    }

    private String[] entry(String w) {
        try (Cursor c = db.rawQuery("SELECT phonetic, trans, rank FROM entry WHERE word=?", new String[]{w})) {
            if (!c.moveToFirst()) return null;
            return new String[]{c.getString(0), c.getString(1), c.isNull(2) ? null : String.valueOf(c.getInt(2))};
        }
    }

    private String[] form(String w) {
        try (Cursor c = db.rawQuery("SELECT lemma, kind FROM form WHERE form=?", new String[]{w})) {
            return c.moveToFirst() ? new String[]{c.getString(0), c.getString(1)} : null;
        }
    }

    /** [lemma, kind or null] for a cleaned lowercase word, or null when nothing matches. */
    String[] resolve(String w) {
        if (w.isEmpty()) return null;
        String[] f = form(w);
        if (f != null) return f;
        if (entry(w) != null) return new String[]{w, null};
        String[][] rules = {{"ies", "y", "s"}, {"es", "", "s"}, {"s", "", "s"}, {"ied", "y", "p"}, {"ed", "", "p"}, {"ed", "e", "p"},
                {"ing", "", "i"}, {"ing", "e", "i"}, {"ly", "", null}};
        for (String[] r : rules) {
            if (!w.endsWith(r[0]) || w.length() - r[0].length() < 2) continue;
            String stem = w.substring(0, w.length() - r[0].length());
            if (entry(stem + r[1]) != null) return new String[]{stem + r[1], r[2]};
            int n = stem.length();
            if (r[1].isEmpty() && n > 2 && stem.charAt(n - 1) == stem.charAt(n - 2) && entry(stem.substring(0, n - 1)) != null)
                return new String[]{stem.substring(0, n - 1), r[2]};
        }
        return null;
    }

    Integer rank(String lemma) {
        String[] e = entry(lemma);
        return e == null || e[2] == null ? null : Integer.valueOf(e[2]);
    }

    JSONObject lookup(String raw) throws JSONException {
        String w = normalize(raw);
        JSONObject o = new JSONObject().put("word", w);
        String[] r = resolve(w);
        if (r == null) return o.put("lemma", w).put("found", false);
        String[] e = entry(r[0]);
        o.put("lemma", r[0]).put("found", true).put("phonetic", e[0]).put("trans", e[1]);
        if (r[1] != null && !r[0].equals(w)) {
            o.put("form", kindLabel(r[1]));
            String[] own = entry(w);
            if (own != null) o.put("own", own[1]);
        }
        return o;
    }

    JSONArray prefix(String raw) throws JSONException {
        long t0 = System.nanoTime();
        String q = normalize(raw);
        JSONArray out = new JSONArray();
        if (q.isEmpty()) return out;
        String[] f = form(q);
        if (f != null) out.put(new JSONObject().put("w", f[0]).put("m", q + " 的" + kindLabel(f[1])).put("q", q));
        try (Cursor c = db.rawQuery("SELECT word, trans FROM entry WHERE word >= ? AND word < ? ORDER BY word = ? DESC, rank IS NULL, rank, length(word) LIMIT 13",
                new String[]{q, q + "￿", q})) {
            while (c.moveToNext() && out.length() < 12) {
                if (f != null && c.getString(0).equals(f[0])) continue;
                out.put(new JSONObject().put("w", c.getString(0)).put("m", firstSense(c.getString(1))));
            }
        }
        Log.i("ShubianPerf", "prefix " + (System.nanoTime() - t0) / 1000 + "us");
        return out;
    }

    /** Every surface form of the given lemmas, for marking saved words in book text. */
    JSONArray formsOf(JSONArray lemmas) throws JSONException {
        JSONArray out = new JSONArray();
        for (int i = 0; i < lemmas.length(); i++) {
            String l = lemmas.getString(i);
            out.put(l);
            try (Cursor c = db.rawQuery("SELECT form FROM form WHERE lemma=?", new String[]{l})) {
                while (c.moveToNext()) out.put(c.getString(0));
            }
        }
        return out;
    }

    static String firstSense(String trans) {
        for (String line : trans.split("\n")) {
            if (line.startsWith("[网络]")) continue;
            return line.replaceFirst("^([a-z]+\\.|\\[[^]]+])\\s*", "").replace(", ", "，").replace("; ", "；");
        }
        return "";
    }
}
