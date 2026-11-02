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
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Locale;

/** Offline ECDICT lookup. The core db ships as SQLite; the long tail ships as a TSV and is imported once per app version. */
final class Dict {
    private static final int VERSION = 5;
    private static Dict instance;
    private final SQLiteDatabase db;
    private final SQLiteDatabase extra;

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
        File ef = c.getDatabasePath("dict_extra.db");
        if (c.getSharedPreferences("dict", 0).getInt("extra_v", 0) != VERSION || !ef.exists()) {
            buildExtra(c, ef);
            c.getSharedPreferences("dict", 0).edit().putInt("extra_v", VERSION).apply();
        }
        extra = SQLiteDatabase.openDatabase(ef.getPath(), null, SQLiteDatabase.OPEN_READONLY);
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

    private static void buildExtra(Context c, File f) {
        f.getParentFile().mkdirs();
        if (f.exists() && !f.delete()) throw new IllegalStateException("无法更新离线词库");
        SQLiteDatabase d = SQLiteDatabase.openOrCreateDatabase(f, null);
        d.execSQL("PRAGMA synchronous=OFF");
        // PRAGMA journal_mode returns a row; execSQL rejects row-returning statements on Android.
        try (Cursor jm = d.rawQuery("PRAGMA journal_mode=OFF", null)) { jm.moveToFirst(); }
        d.execSQL("CREATE TABLE entry (word TEXT PRIMARY KEY, phonetic TEXT, trans TEXT NOT NULL, rank INTEGER) WITHOUT ROWID");
        android.database.sqlite.SQLiteStatement insert = d.compileStatement("INSERT INTO entry VALUES (?,?,?,?)");
        d.beginTransaction();
        try (InputStream raw = c.getAssets().open("dict_extra.tsv");
             BufferedReader in = new BufferedReader(new InputStreamReader(raw, java.nio.charset.StandardCharsets.UTF_8), 1 << 16)) {
            for (String line; (line = in.readLine()) != null; ) {
                int tab = line.indexOf('\t');
                if (tab <= 0) continue;
                insert.clearBindings();
                insert.bindString(1, line.substring(0, tab));
                insert.bindNull(2);
                insert.bindString(3, line.substring(tab + 1).replace("\\n", "\n"));
                insert.bindNull(4);
                insert.executeInsert();
            }
            d.setTransactionSuccessful();
        } catch (IOException e) {
            throw new IllegalStateException(e);
        } finally {
            d.endTransaction();
            insert.close();
            d.close();
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
        return w.replaceAll("\\s+", " ").replaceAll("^[^a-z]+|[^a-z]+$", "");
    }

    private String[] entryFrom(SQLiteDatabase source, String w) {
        try (Cursor c = source.rawQuery("SELECT phonetic, trans, rank FROM entry WHERE word=?", new String[]{w})) {
            if (!c.moveToFirst()) return null;
            return new String[]{c.getString(0), c.getString(1), c.isNull(2) ? null : String.valueOf(c.getInt(2))};
        }
    }

    private String[] entry(String w) {
        String[] e = entryFrom(db, w);
        return e != null ? e : entryFrom(extra, w);
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
        String tableFilter = q.indexOf(' ') >= 0 ? "instr(word, ' ') > 0" : "instr(word, ' ') = 0";
        prefixFrom(db, tableFilter, q, f, out);
        if (out.length() < 12) prefixFrom(extra, tableFilter, q, f, out);
        Log.i("ShubianPerf", "prefix " + (System.nanoTime() - t0) / 1000 + "us");
        return out;
    }

    private void prefixFrom(SQLiteDatabase source, String tableFilter, String q, String[] form, JSONArray out) throws JSONException {
        try (Cursor c = source.rawQuery("SELECT word, trans FROM entry WHERE " + tableFilter + " AND word >= ? AND word < ? ORDER BY word = ? DESC, rank IS NULL, rank, length(word) LIMIT 13",
                new String[]{q, q + "￿", q})) {
            while (c.moveToNext() && out.length() < 12) {
                String word = c.getString(0);
                if (form != null && word.equals(form[0])) continue;
                boolean seen = false;
                for (int i = 0; i < out.length(); i++) if (out.getJSONObject(i).optString("w").equals(word)) { seen = true; break; }
                if (!seen) out.put(new JSONObject().put("w", word).put("m", firstSense(c.getString(1))));
            }
        }
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
