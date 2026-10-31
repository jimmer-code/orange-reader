package app.shubian;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;

import java.io.FileNotFoundException;

/** Gives the system camera a writable output file (replaces AndroidX FileProvider). */
public class ImageProvider extends ContentProvider {
    static final Uri CAPTURE = Uri.parse("content://app.shubian.images/capture.jpg");

    @Override public boolean onCreate() { return true; }

    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        return ParcelFileDescriptor.open(Scan.captureFile(getContext()), ParcelFileDescriptor.parseMode(mode)
                | ParcelFileDescriptor.MODE_CREATE);
    }

    @Override public String getType(Uri uri) { return "image/jpeg"; }
    @Override public Cursor query(Uri u, String[] p, String s, String[] a, String o) { return null; }
    @Override public Uri insert(Uri u, ContentValues v) { return null; }
    @Override public int delete(Uri u, String s, String[] a) { return 0; }
    @Override public int update(Uri u, ContentValues v, String s, String[] a) { return 0; }
}
