package com.yiqikan.room;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

public class PlaybackForegroundService extends Service {
    public static final String EXTRA_TITLE = "title";
    private static final String CHANNEL_ID = "yiqikan_playback";
    private static final int NOTIFICATION_ID = 1107;

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager manager = getSystemService(NotificationManager.class);
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "同频播放",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("保持电影播放、信令和连麦在后台稳定运行");
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String title = intent == null
            ? null
            : intent.getStringExtra(EXTRA_TITLE);
        Notification notification = buildNotification(
            title == null || title.trim().isEmpty() ? "正在观看频道" : title.trim()
        );
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
            );
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private Notification buildNotification(String title) {
        Intent openApp = new Intent(this, MainActivity.class);
        openApp.setFlags(
            Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP
        );
        PendingIntent pendingIntent = PendingIntent.getActivity(
            this,
            0,
            openApp,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        return new Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_synced)
            .setContentTitle("同频")
            .setContentText(title)
            .setCategory(Notification.CATEGORY_TRANSPORT)
            .setContentIntent(pendingIntent)
            .setOnlyAlertOnce(true)
            .setOngoing(true)
            .build();
    }
}
