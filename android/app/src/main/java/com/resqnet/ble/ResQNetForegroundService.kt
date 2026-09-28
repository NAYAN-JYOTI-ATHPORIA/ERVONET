package com.resqnet.ble

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat

/**
 * ResQNetForegroundService
 * Inspired by BitChat's MeshForegroundService:
 * Keeps the BLE GATT Server, BLE Scanner, and node-to-node relaying active
 * in the background, preventing Android Doze mode and OS battery killers
 * from killing offline mesh connectivity when screen locks or app is backgrounded.
 */
class ResQNetForegroundService : Service() {

    companion object {
        private const val TAG = "ResQNetFgService"
        private const val NOTIFICATION_ID = 8820
        private const val CHANNEL_ID = "resqnet_mesh_channel"
        private const val CHANNEL_NAME = "ERVONET Mesh Network"

        const val ACTION_START = "com.resqnet.ble.ACTION_START"
        const val ACTION_STOP = "com.resqnet.ble.ACTION_STOP"
        const val ACTION_UPDATE_STATUS = "com.resqnet.ble.ACTION_UPDATE_STATUS"
        const val EXTRA_STATUS_TEXT = "extra_status_text"

        fun startService(context: Context, statusText: String = "ERVONET BLE Mesh Active") {
            val intent = Intent(context, ResQNetForegroundService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_STATUS_TEXT, statusText)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stopService(context: Context) {
            val intent = Intent(context, ResQNetForegroundService::class.java).apply {
                action = ACTION_STOP
            }
            context.stopService(intent)
        }
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        Log.d(TAG, "ResQNetForegroundService created")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action ?: ACTION_START
        if (action == ACTION_STOP) {
            stopForeground(true)
            stopSelf()
            return START_NOT_STICKY
        }

        val statusText = intent?.getStringExtra(EXTRA_STATUS_TEXT) ?: "Offline BLE Mesh Active • Monitoring Peers"
        val notification = buildNotification(statusText)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                // Android 14+ requires connectedDevice foreground service type
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
                )
            } else {
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
                )
            }
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                CHANNEL_NAME,
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Keeps ResQNet Bluetooth Low Energy mesh active for emergency communication"
                setShowBadge(false)
            }
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            manager?.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(statusText: String): Notification {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val pendingIntent = if (launchIntent != null) {
            PendingIntent.getActivity(
                this,
                0,
                launchIntent,
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0
            )
        } else {
            null
        }

        val iconRes = applicationInfo.icon

        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("ERVONET Offline Mesh")
            .setContentText(statusText)
            .setSmallIcon(iconRes)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)

        if (pendingIntent != null) {
            builder.setContentIntent(pendingIntent)
        }

        return builder.build()
    }
}

