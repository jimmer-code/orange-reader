package app.shubian;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;

import java.io.File;
import java.io.FileNotFoundException;

/** Gives the system camera a writable output file and hands share images to other apps (replaces AndroidX FileProvider). */
public class ImageProvider extends ContentProvider {
    static Uri captureUri(Context context) {
        return Uri.parse("content://" + context.getPackageName() + ".images/capture.jpg");
    }

    @Override public boolean onCreate() { return true; }

    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        File file = resolve(uri);
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.parseMode(mode)
                | ParcelFileDescriptor.MODE_CREATE);
    }

    /** capture.jpg 是相机输出；share/<文件名> 是分享书摘的临时 PNG（在缓存目录里）。 */
    private File resolve(Uri uri) throws FileNotFoundException {
        if (uri.getPathSegments().size() < 2) return Scan.captureFile(getContext());
        String name = uri.getPathSegments().get(1);
        if (!name.matches("excerpt-[0-9]+\\.png")) throw new FileNotFoundException(uri.toString());
        File dir = new File(getContext().getCacheDir(), "share");
        File file = new File(dir, name);
        try {
            if (!file.getCanonicalPath().startsWith(dir.getCanonicalPath() + File.separator)) throw new FileNotFoundException(uri.toString());
        } catch (java.io.IOException e) {
            throw new FileNotFoundException(uri.toString());
        }
        return file;
    }

    @Override public String getType(Uri uri) {
        return uri.getPathSegments().size() < 2 ? "image/jpeg" : "image/png";
    }
    @Override public Cursor query(Uri u, String[] p, String s, String[] a, String o) { return null; }
    @Override public Uri insert(Uri u, ContentValues v) { return null; }
    @Override public int delete(Uri u, String s, String[] a) { return 0; }
    @Override public int update(Uri u, ContentValues v, String s, String[] a) { return 0; }
}
