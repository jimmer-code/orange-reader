package app.shubian;

import android.content.Intent;
import android.net.Uri;

public class MainActivity extends WebActivity {
    static final String ACTION_SCAN = "app.shubian.SCAN";
    private Intent pending;

    @Override protected String startUrl() { return ORIGIN + "index.html"; }

    @Override protected void onCreate(android.os.Bundle b) {
        pending = getIntent();
        super.onCreate(b);
    }

    @Override protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        pending = i;
        onPageReady();
    }

    @Override protected void onPageReady() {
        Intent i = pending;
        pending = null;
        if (i == null) return;
        Uri data = i.getData();
        if (ACTION_SCAN.equals(i.getAction())) startCamera();
        else if (Intent.ACTION_VIEW.equals(i.getAction()) && data != null && "content".equals(data.getScheme())) {
            emit("tab", "\"library\"");
            importBook(data);
        } else emit("tab", "\"physical\"");
    }
}
