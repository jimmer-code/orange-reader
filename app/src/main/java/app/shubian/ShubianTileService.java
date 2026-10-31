package app.shubian;

import android.app.PendingIntent;
import android.content.Intent;
import android.service.quicksettings.TileService;

/** Opens the lookup card for the first English word on the clipboard (read once the card has focus). */
public class ShubianTileService extends TileService {
    @android.annotation.SuppressLint("StartActivityAndCollapseDeprecated") // 只在 API 33 走旧接口
    @Override public void onClick() {
        super.onClick();
        Intent i = new Intent(this, LookupActivity.class).putExtra("clip", true).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (android.os.Build.VERSION.SDK_INT >= 34)
            startActivityAndCollapse(PendingIntent.getActivity(this, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        else startActivityAndCollapse(i);
    }
}
