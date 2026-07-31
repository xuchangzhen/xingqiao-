package com.xingqiao.android;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

/**
 * Keeps an in-progress, user-initiated transfer alive when the Activity goes
 * to the background. The WebView continues owning WebRTC; this service only
 * gives that work the Android-supported foreground execution and radio/CPU
 * lifetime while a transfer is actually active.
 */
public final class TransferService extends Service {
    private static final String CHANNEL_ID = "xingqiao-transfer";
    private static final int NOTIFICATION_ID = 42;
    private static final String ACTION_START = "com.xingqiao.android.START_TRANSFER";
    private static final String ACTION_STOP = "com.xingqiao.android.STOP_TRANSFER";

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;

    public static void start(Context context) {
        Intent intent = new Intent(context, TransferService.class).setAction(ACTION_START);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent);
        else context.startService(intent);
    }

    public static void stop(Context context) {
        context.stopService(new Intent(context, TransferService.class).setAction(ACTION_STOP));
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (ACTION_STOP.equals(intent == null ? null : intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        promoteToForeground();
        acquireTransferLocks();
        // A page or transfer that the user closes must not be resurrected by
        // Android without its WebRTC state, so do not request a restart.
        return START_NOT_STICKY;
    }

    private void promoteToForeground() {
        NotificationManager notifications = getSystemService(NotificationManager.class);
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "星桥文件传输", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("传输进行时保持连接，完成后自动结束");
        notifications.createNotificationChannel(channel);
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pending = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentTitle("星桥正在传输")
            .setContentText("可切换到其他应用；完成后会自动结束")
            .setContentIntent(pending)
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_PROGRESS)
            .build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else startForeground(NOTIFICATION_ID, notification);
    }

    private void acquireTransferLocks() {
        PowerManager power = (PowerManager) getSystemService(POWER_SERVICE);
        if (wakeLock == null) {
            wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "xingqiao:transfer-cpu");
            wakeLock.setReferenceCounted(false);
        }
        if (!wakeLock.isHeld()) wakeLock.acquire();

        WifiManager wifi = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
        if (wifi != null && wifiLock == null) {
            wifiLock = wifi.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "xingqiao:transfer-wifi");
            wifiLock.setReferenceCounted(false);
        }
        if (wifiLock != null && !wifiLock.isHeld()) wifiLock.acquire();
    }

    private void releaseTransferLocks() {
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
    }

    @Override public void onDestroy() {
        releaseTransferLocks();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE);
        else stopForeground(true);
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
