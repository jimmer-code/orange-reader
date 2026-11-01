package app.shubian;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;

/** Exposes the downloaded APK to the system package installer without a file:// URI. */
public final class UpdateProvider extends ContentProvider {
    static Uri uri(File file, String authority) {
        return new Uri.Builder().scheme("content").authority(authority).path(file.getAbsolutePath()).build();
    }

    @Override public boolean onCreate() { return true; }

    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        return ParcelFileDescriptor.open(file(uri), ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override public String getType(Uri uri) { return "application/vnd.android.package-archive"; }

    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        File f;
        try { f = file(uri); } catch (FileNotFoundException e) { return null; }
        MatrixCursor c = new MatrixCursor(new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE});
        c.addRow(new Object[]{f.getName(), f.length()});
        return c;
    }

    @Override public int delete(Uri uri, String selection, String[] selectionArgs) { return 0; }
    @Override public Uri insert(Uri uri, ContentValues values) { return null; }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) { return 0; }

    private File file(Uri uri) throws FileNotFoundException {
        if (getContext() == null || uri.getPath() == null) throw new FileNotFoundException();
        try {
            File f = new File(uri.getPath()).getCanonicalFile();
            File external = getContext().getExternalFilesDir(null);
            File internal = getContext().getFilesDir();
            boolean allowed = (external != null && isInside(f, external.getCanonicalFile()))
                    || isInside(f, internal.getCanonicalFile());
            if (!allowed || !f.isFile()) throw new FileNotFoundException();
            return f;
        } catch (FileNotFoundException e) {
            throw e;
        } catch (Exception e) {
            throw new FileNotFoundException();
        }
    }

    private static boolean isInside(File child, File parent) {
        String p = parent.getPath();
        String c = child.getPath();
        return c.equals(p) || c.startsWith(p + File.separator);
    }
}
