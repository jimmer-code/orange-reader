package app.shubian;

import android.content.Intent;
import android.net.Uri;

/** Transparent card over another app: PROCESS_TEXT, ColorDict SEARCH and the quick settings tile. */
public class LookupActivity extends WebActivity {
    @Override protected boolean transparent() { return true; }

    @Override protected String startUrl() {
        Intent i = getIntent();
        CharSequence t = i.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT);
        String q = t != null ? t.toString() : i.getStringExtra("EXTRA_QUERY");
        if (q == null) q = i.getStringExtra("query");
        return ORIGIN + "index.html?mode=card&t=" + System.currentTimeMillis()
                + (q != null ? "&q=" + Uri.encode(q) : "") + (i.getBooleanExtra("clip", false) ? "&clip=1" : "");
    }

    @Override protected void onExit() { finish(); }

    @Override public void finish() {
        super.finish();
        if (android.os.Build.VERSION.SDK_INT >= 34) overrideActivityTransition(OVERRIDE_TRANSITION_CLOSE, 0, 0);
        else overridePendingTransition(0, 0);
    }
}
