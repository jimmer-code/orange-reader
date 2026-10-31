package app.shubian;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.graphics.Rect;
import android.media.ExifInterface;
import android.net.Uri;

import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.HashSet;
import java.util.Set;

/** Photo of a book page → OCR words with boxes → candidate hard words (frequency and known-word filter). */
final class Scan {
    interface Done { void result(JSONObject r); }

    static final int COMMON = 3000;

    static File dir(Context c) {
        File d = new File(c.getFilesDir(), "scan");
        d.mkdirs();
        return d;
    }

    static File captureFile(Context c) { return new File(dir(c), "capture.jpg"); }

    /** Decodes, rotates per EXIF and downsizes to at most 2400px; saves a copy the page can show. */
    static Bitmap prepare(Context c, Uri uri, File out) throws Exception {
        BitmapFactory.Options o = new BitmapFactory.Options();
        o.inJustDecodeBounds = true;
        try (InputStream in = c.getContentResolver().openInputStream(uri)) { BitmapFactory.decodeStream(in, null, o); }
        int s = 1;
        while (Math.max(o.outWidth, o.outHeight) / s > 2400) s *= 2;
        BitmapFactory.Options d = new BitmapFactory.Options();
        d.inSampleSize = s;
        Bitmap b;
        try (InputStream in = c.getContentResolver().openInputStream(uri)) { b = BitmapFactory.decodeStream(in, null, d); }
        if (b == null) throw new IllegalStateException("decode");
        int deg = 0;
        try (InputStream in = c.getContentResolver().openInputStream(uri)) {
            int ori = new ExifInterface(in).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
            deg = ori == ExifInterface.ORIENTATION_ROTATE_90 ? 90 : ori == ExifInterface.ORIENTATION_ROTATE_180 ? 180 : ori == ExifInterface.ORIENTATION_ROTATE_270 ? 270 : 0;
        } catch (Exception ignored) { }
        if (deg != 0) {
            Matrix m = new Matrix();
            m.postRotate(deg);
            b = Bitmap.createBitmap(b, 0, 0, b.getWidth(), b.getHeight(), m, true);
        }
        try (FileOutputStream f = new FileOutputStream(out)) { b.compress(Bitmap.CompressFormat.JPEG, 88, f); }
        return b;
    }

    static void recognize(Context c, Bitmap bmp, Set<String> known, Done done) {
        long t0 = System.currentTimeMillis();
        TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
                .process(InputImage.fromBitmap(bmp, 0))
                .addOnSuccessListener(text -> new Thread(() -> {
                    try { done.result(filter(c, text, known, System.currentTimeMillis() - t0)); }
                    catch (Exception e) { done.result(error()); }
                }).start())
                .addOnFailureListener(e -> done.result(error()));
    }

    private static JSONObject error() {
        try { return new JSONObject().put("ok", false); } catch (Exception e) { throw new IllegalStateException(e); }
    }

    private static JSONObject filter(Context c, Text text, Set<String> known, long ms) throws Exception {
        Dict dict = Dict.get(c);
        JSONArray words = new JSONArray(), cands = new JSONArray();
        Set<String> seen = new HashSet<>();
        boolean sentenceStart = true;
        for (Text.TextBlock block : text.getTextBlocks()) {
            for (Text.Line line : block.getLines()) {
                for (Text.Element el : line.getElements()) {
                    String raw = el.getText();
                    String clean = raw.replace('’', '\'').replaceAll("^[^A-Za-z]+|[^A-Za-z]+$", "");
                    boolean startHere = sentenceStart;
                    sentenceStart = raw.matches(".*[.!?][\"'”’)]?$");
                    if (clean.length() < 3 || !clean.matches("[A-Za-z][A-Za-z'\\-]*")) continue;
                    boolean proper = !startHere && Character.isUpperCase(clean.charAt(0));
                    String w = Dict.normalize(clean);
                    String[] r = dict.resolve(w);
                    if (r == null) continue;
                    Rect box = el.getBoundingBox();
                    if (box != null) words.put(new JSONObject().put("lemma", r[0]).put("x", box.left).put("y", box.top)
                            .put("w", box.width()).put("h", box.height()));
                    if (proper || known.contains(r[0]) || !seen.add(r[0])) continue;
                    Integer rank = dict.rank(r[0]);
                    if (rank != null && rank <= COMMON) continue;
                    cands.put(new JSONObject().put("w", w).put("lemma", r[0]).put("rank", rank == null ? 999999 : rank));
                }
            }
        }
        String passage = text.getText().replaceAll("-\\n", "").replaceAll("\\s+", " ").trim();
        if (passage.length() > 4000) passage = passage.substring(0, 4000);
        return new JSONObject().put("ok", !passage.isEmpty()).put("ms", ms).put("passage", passage).put("words", words).put("cands", cands);
    }
}
