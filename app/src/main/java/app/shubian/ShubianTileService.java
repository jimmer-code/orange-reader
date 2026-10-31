package app.shubian;
import android.service.quicksettings.TileService;import android.annotation.SuppressLint;import android.content.*;import android.app.PendingIntent;
public class ShubianTileService extends TileService { @SuppressLint("NewApi") @Override public void onClick(){super.onClick(); Intent i=new Intent(this,MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); PendingIntent p=PendingIntent.getActivity(this,0,i,PendingIntent.FLAG_IMMUTABLE); startActivityAndCollapse(p);} }
