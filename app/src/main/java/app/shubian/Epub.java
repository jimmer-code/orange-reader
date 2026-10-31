package app.shubian;

import android.content.Context;
import android.net.Uri;
import android.util.Xml;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.xmlpull.v1.XmlPullParser;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/** ePub import: copy into files/books/<id>.epub, read OPF, spine, table of contents and cover. */
final class Epub {
    static final class Rejected extends Exception {
        Rejected(String msg) { super(msg); }
    }

    static File dir(Context c) {
        File d = new File(c.getFilesDir(), "books");
        d.mkdirs();
        return d;
    }

    static File coverDir(Context c) {
        File d = new File(c.getFilesDir(), "covers");
        d.mkdirs();
        return d;
    }

    /** Copies the document and returns its id (SHA-1 prefix); throws Rejected("dup:<id>") if already imported. */
    static String copyIn(Context c, Uri uri) throws Exception {
        File tmp = new File(dir(c), "import-" + System.nanoTime() + ".tmp");
        MessageDigest sha = MessageDigest.getInstance("SHA-1");
        try (InputStream in = c.getContentResolver().openInputStream(uri); OutputStream out = new FileOutputStream(tmp)) {
            byte[] b = new byte[1 << 16];
            for (int n; (n = in.read(b)) > 0; ) { sha.update(b, 0, n); out.write(b, 0, n); }
        }
        StringBuilder id = new StringBuilder();
        byte[] d = sha.digest();
        for (int i = 0; i < 8; i++) id.append(String.format("%02x", d[i]));
        File dest = new File(dir(c), id + ".epub");
        if (new File(dir(c), id + ".json").exists()) {
            tmp.delete();
            throw new Rejected("dup:" + id);
        }
        if (!tmp.renameTo(dest)) throw new IOException("rename failed");
        return id.toString();
    }

    static JSONObject parse(Context c, String id) throws Exception {
        File file = new File(dir(c), id + ".epub");
        try (ZipFile zip = new ZipFile(file)) {
            checkDrm(zip);
            String opfPath = rootfile(zip);
            String base = opfPath.contains("/") ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : "";
            Opf opf = readOpf(zip, opfPath);
            JSONArray spine = new JSONArray();
            Map<String, Integer> spineIndex = new HashMap<>();
            for (String idref : opf.spine) {
                String[] item = opf.items.get(idref);
                if (item == null) continue;
                String path = resolve(base, item[0]);
                spineIndex.put(path, spine.length());
                spine.put(path);
            }
            if (spine.length() == 0) throw new Rejected("无法读取这本书");
            JSONArray toc = new JSONArray();
            String nav = opf.navId != null ? opf.items.get(opf.navId)[0] : null;
            String ncx = opf.ncxId != null && opf.items.get(opf.ncxId) != null ? opf.items.get(opf.ncxId)[0] : null;
            if (nav != null) readToc(zip, resolve(base, nav), spineIndex, toc, true);
            if (toc.length() == 0 && ncx != null) readToc(zip, resolve(base, ncx), spineIndex, toc, false);
            JSONObject meta = new JSONObject()
                    .put("id", id)
                    .put("title", opf.title.isEmpty() ? "未命名" : opf.title)
                    .put("author", opf.author)
                    .put("lang", opf.lang.isEmpty() ? "en" : opf.lang)
                    .put("spine", spine)
                    .put("toc", toc)
                    .put("added", System.currentTimeMillis());
            String cover = opf.coverHref != null ? resolve(base, opf.coverHref) : null;
            if (cover != null && zip.getEntry(cover) != null) {
                String ext = cover.toLowerCase(java.util.Locale.ROOT).endsWith(".png") ? ".png" : ".jpg";
                File out = new File(coverDir(c), id + ext);
                try (InputStream in = zip.getInputStream(zip.getEntry(cover))) {
                    Files.copy(in, out.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                }
                meta.put("cover", "/cover/" + out.getName());
            }
            Files.write(new File(dir(c), id + ".json").toPath(), meta.toString().getBytes(StandardCharsets.UTF_8));
            return meta;
        } catch (Exception e) {
            file.delete();
            throw e;
        }
    }

    static JSONArray list(Context c) throws Exception {
        List<JSONObject> books = new ArrayList<>();
        File[] fs = dir(c).listFiles((d, n) -> n.endsWith(".json"));
        if (fs != null) for (File f : fs) books.add(new JSONObject(new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8)));
        books.sort((a, b) -> Long.compare(b.optLong("added"), a.optLong("added")));
        JSONArray out = new JSONArray();
        for (JSONObject b : books) out.put(b);
        return out;
    }

    static void delete(Context c, String id) {
        new File(dir(c), id + ".epub").delete();
        new File(dir(c), id + ".json").delete();
        new File(coverDir(c), id + ".jpg").delete();
        new File(coverDir(c), id + ".png").delete();
    }

    private static void checkDrm(ZipFile zip) throws Exception {
        if (zip.getEntry("META-INF/rights.xml") != null) throw new Rejected("这本书有加密，无法打开");
        ZipEntry enc = zip.getEntry("META-INF/encryption.xml");
        if (enc == null) return;
        String xml = read(zip, enc);
        Matcher m = Pattern.compile("Algorithm=\"([^\"]+)\"").matcher(xml);
        while (m.find()) {
            String alg = m.group(1);
            // Font obfuscation is not DRM; anything else (AES etc.) is.
            if (!alg.contains("embedding") && !alg.contains("adobe.com/pdf")) throw new Rejected("这本书有加密，无法打开");
        }
    }

    private static String rootfile(ZipFile zip) throws Exception {
        ZipEntry e = zip.getEntry("META-INF/container.xml");
        if (e == null) throw new Rejected("无法读取这本书");
        Matcher m = Pattern.compile("full-path=\"([^\"]+)\"").matcher(read(zip, e));
        if (!m.find()) throw new Rejected("无法读取这本书");
        return m.group(1);
    }

    private static final class Opf {
        String title = "", author = "", lang = "", coverId, coverHref, navId, ncxId;
        final Map<String, String[]> items = new HashMap<>();
        final List<String> spine = new ArrayList<>();
    }

    private static Opf readOpf(ZipFile zip, String path) throws Exception {
        ZipEntry e = zip.getEntry(path);
        if (e == null) throw new Rejected("无法读取这本书");
        Opf o = new Opf();
        XmlPullParser p = Xml.newPullParser();
        p.setFeature(XmlPullParser.FEATURE_PROCESS_NAMESPACES, true);
        try (InputStream in = zip.getInputStream(e)) {
            p.setInput(in, null);
            for (int t = p.getEventType(); t != XmlPullParser.END_DOCUMENT; t = p.next()) {
                if (t != XmlPullParser.START_TAG) continue;
                switch (p.getName()) {
                    case "title": if (o.title.isEmpty()) o.title = p.nextText().trim(); break;
                    case "creator": if (o.author.isEmpty()) o.author = p.nextText().trim(); break;
                    case "language": if (o.lang.isEmpty()) o.lang = p.nextText().trim(); break;
                    case "meta":
                        if ("cover".equals(p.getAttributeValue(null, "name"))) o.coverId = p.getAttributeValue(null, "content");
                        break;
                    case "item": {
                        String id = p.getAttributeValue(null, "id"), href = p.getAttributeValue(null, "href");
                        String type = p.getAttributeValue(null, "media-type"), props = p.getAttributeValue(null, "properties");
                        if (id == null || href == null) break;
                        o.items.put(id, new String[]{href, type});
                        if (props != null && props.contains("cover-image")) o.coverHref = href;
                        if (props != null && props.contains("nav")) o.navId = id;
                        if ("application/x-dtbncx+xml".equals(type)) o.ncxId = id;
                        break;
                    }
                    case "spine": {
                        String toc = p.getAttributeValue(null, "toc");
                        if (toc != null) o.ncxId = toc;
                        break;
                    }
                    case "itemref": o.spine.add(p.getAttributeValue(null, "idref")); break;
                }
            }
        }
        if (o.coverHref == null && o.coverId != null && o.items.containsKey(o.coverId)) o.coverHref = o.items.get(o.coverId)[0];
        if (o.coverHref == null) {
            for (String[] item : o.items.values()) {
                if (item[1] != null && item[1].startsWith("image/") && item[0].toLowerCase(java.util.Locale.ROOT).contains("cover")) { o.coverHref = item[0]; break; }
            }
        }
        return o;
    }

    /** Reads an EPUB3 nav document or EPUB2 NCX with regexes, which tolerate HTML entities that strict XML parsing rejects. */
    private static void readToc(ZipFile zip, String path, Map<String, Integer> spineIndex, JSONArray toc, boolean nav) throws IOException, JSONException {
        ZipEntry e = zip.getEntry(path);
        if (e == null) return;
        String xml = read(zip, e), base = path.contains("/") ? path.substring(0, path.lastIndexOf('/') + 1) : "";
        Pattern p;
        if (nav) {
            Matcher tocNav = Pattern.compile("<nav[^>]*toc[^>]*>(.*?)</nav>", Pattern.DOTALL).matcher(xml);
            if (tocNav.find()) xml = tocNav.group(1);
            p = Pattern.compile("<a[^>]*href=\"([^\"]+)\"[^>]*>(.*?)</a>", Pattern.DOTALL);
        } else {
            p = Pattern.compile("<navLabel>\\s*<text>(.*?)</text>\\s*</navLabel>\\s*<content[^>]*src=\"([^\"]+)\"", Pattern.DOTALL);
        }
        Matcher m = p.matcher(xml);
        while (m.find()) {
            String href = nav ? m.group(1) : m.group(2), text = nav ? m.group(2) : m.group(1);
            text = text.replaceAll("<[^>]+>", "").replaceAll("\\s+", " ").replace("&amp;", "&").replace("&#160;", " ").replace("&nbsp;", " ").trim();
            String file = href.contains("#") ? href.substring(0, href.indexOf('#')) : href;
            String frag = href.contains("#") ? href.substring(href.indexOf('#') + 1) : "";
            Integer ch = spineIndex.get(resolve(base, file));
            if (ch == null || text.isEmpty()) continue;
            toc.put(new JSONObject().put("t", text).put("ch", ch).put("frag", frag));
        }
    }

    static String resolve(String base, String href) {
        String path = base + URLDecoder.decode(href.replace("+", "%2B"), StandardCharsets.UTF_8);
        List<String> parts = new ArrayList<>();
        for (String s : path.split("/")) {
            if (s.isEmpty() || s.equals(".")) continue;
            if (s.equals("..")) { if (!parts.isEmpty()) parts.remove(parts.size() - 1); } else parts.add(s);
        }
        return String.join("/", parts);
    }

    private static String read(ZipFile zip, ZipEntry e) throws IOException {
        try (InputStream in = zip.getInputStream(e)) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }
}
