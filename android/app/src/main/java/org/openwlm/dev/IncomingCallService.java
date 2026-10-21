package org.openwlm.dev;

import android.app.KeyguardManager;
import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.Person;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;
import java.util.Map;

/**
 * Appel entrant reçu par FCM : service de premier plan (type « phoneCall ») qui affiche l'écran
 * d'appel (notification CallStyle plein écran, même téléphone verrouillé) et fait sonner le
 * téléphone en boucle selon son mode (sonnerie, vibreur, silencieux, Ne pas déranger).
 *
 * Arrêt : Répondre, Refuser, fin d'appel reçue du serveur (call_cancel), appel affiché par
 * l'interface (elle a repris la main), ou expiration de l'appel (« Appel manqué »).
 */
public class IncomingCallService extends Service {

    private static final String ACTION_RING = "org.openwlm.dev.RING";
    private static final String ACTION_STOP = "org.openwlm.dev.STOP_RING";
    private static final String EXTRA_CALLER_ID = "callerId";
    private static final String EXTRA_NAME = "name";
    private static final String EXTRA_VIDEO = "video";
    private static final String EXTRA_RING_MS = "ringMs";
    static final int NOTIFICATION_ID = 1001;
    /** Champ ajouté aux données FCM : heure d'envoi par les serveurs de Firebase. */
    static final String DATA_SENT_TIME = "_sentTime";
    private static final long[] VIBRATION = { 0, 1000, 1000 };

    /** Appelant qui sonne (0 : aucun). */
    private static volatile int ringingCallerId;
    /**
     * Le téléphone exigeait un code ou une empreinte quand l'appel a sonné : isDeviceLocked, qui
     * est faux pendant le délai de grâce ou en Smart Lock (contrairement à isKeyguardLocked).
     * Consommé une seule fois par MainActivity (consumeAnswerUnlock), remis à zéro à la fin de
     * la sonnerie.
     */
    private static volatile boolean deviceLockedWhenRang;
    private static volatile String ringingName;
    private static volatile boolean ringingVideo;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private Ringtone ringtone;
    private Vibrator vibrator;
    private final Runnable timeout = this::onTimeout;
    private final Runnable ringtoneLoop = new Runnable() {
        @Override
        public void run() {
            // Android 8 : pas de Ringtone.setLooping, on relance la sonnerie quand elle s'arrête
            if (ringtone != null && !ringtone.isPlaying()) ringtone.play();
            handler.postDelayed(this, 1000);
        }
    };

    /** Appel entrant (message FCM « call »). Ignoré s'il est périmé. */
    static void ring(Context context, Map<String, String> data) {
        int callerId = OpenWLMNotifications.parseId(data.containsKey("callerId") ? data.get("callerId") : data.get("senderId"));
        Long ringMs = CallTiming.ringDurationMs(
            OpenWLMNotifications.parseLong(data.get("expiresAt")),
            OpenWLMNotifications.parseLong(data.get(DATA_SENT_TIME)),
            System.currentTimeMillis()
        );
        if (callerId <= 0 || ringMs == null) return;
        Intent intent = new Intent(context, IncomingCallService.class)
            .setAction(ACTION_RING)
            .putExtra(EXTRA_CALLER_ID, callerId)
            .putExtra(EXTRA_NAME, OpenWLMNotifications.callerName(data.get("title")))
            .putExtra(EXTRA_VIDEO, "callVideo".equals(data.get("l10n")))
            .putExtra(EXTRA_RING_MS, ringMs.longValue());
        try {
            ContextCompat.startForegroundService(context, intent);
        } catch (RuntimeException e) {
            // Démarrage refusé par le système (restrictions d'arrière-plan) : notification simple
            IncomingCallActivity.fallbackNotification(context, callerId, OpenWLMNotifications.callerName(data.get("title")), "callVideo".equals(data.get("l10n")));
        }
    }

    /** Arrête la sonnerie de `callerId` (0 : quel que soit l'appelant). */
    static void stop(Context context, int callerId) {
        if (ringingCallerId == 0 || (callerId != 0 && callerId != ringingCallerId)) return;
        try {
            context.startService(new Intent(context, IncomingCallService.class).setAction(ACTION_STOP));
        } catch (RuntimeException e) {
            // Service déjà arrêté par le système : plus rien ne sonne
            ringingCallerId = 0;
        }
    }

    static int ringingCallerId() {
        return ringingCallerId;
    }

    static String ringingName() {
        return ringingName;
    }

    static boolean ringingVideo() {
        return ringingVideo;
    }

    /**
     * « Répondre » à l'appel de `chatId` : vrai si l'app peut s'ouvrir sans redemander son
     * déverrouillage (cf. AppLockPolicy). À usage unique : l'indicateur est remis à zéro.
     */
    static synchronized boolean consumeAnswerUnlock(Context context, int chatId) {
        KeyguardManager km = ContextCompat.getSystemService(context, KeyguardManager.class);
        boolean lockedNow = km == null || km.isDeviceLocked();
        boolean skip = AppLockPolicy.skipLockForAnswer(true, chatId, ringingCallerId, deviceLockedWhenRang, lockedNow);
        deviceLockedWhenRang = false;
        return skip;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_RING.equals(action)) {
            startRinging(intent);
        } else {
            stopRinging();
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    private void startRinging(Intent intent) {
        int callerId = intent.getIntExtra(EXTRA_CALLER_ID, 0);
        String name = intent.getStringExtra(EXTRA_NAME);
        boolean video = intent.getBooleanExtra(EXTRA_VIDEO, false);
        long ringMs = intent.getLongExtra(EXTRA_RING_MS, CallTiming.DEFAULT_RING_MS);

        stopSounds();
        ringingCallerId = callerId;
        ringingName = name;
        ringingVideo = video;
        KeyguardManager km = ContextCompat.getSystemService(this, KeyguardManager.class);
        deviceLockedWhenRang = km != null && km.isDeviceLocked();

        OpenWLMNotifications.ensureChannels(this);
        Notification notification = buildNotification(callerId, name, video);
        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL : 0;
        try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type);
        } catch (RuntimeException e) {
            IncomingCallActivity.fallbackNotification(this, callerId, name, video);
            ringingCallerId = 0;
            stopSelf();
            return;
        }
        // Une notification d'appel de la v2 ou un « Appel manqué » précédent du même contact
        OpenWLMNotifications.cancel(this, OpenWLMNotifications.callTag(callerId));
        startSounds();
        handler.removeCallbacks(timeout);
        handler.postDelayed(timeout, ringMs);
    }

    private Notification buildNotification(int callerId, String name, boolean video) {
        Context loc = OpenWLMNotifications.localized(this);
        Intent full = new Intent(this, IncomingCallActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_USER_ACTION);
        PendingIntent fullPi = PendingIntent.getActivity(this, callerId, full, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent answerPi = OpenWLMNotifications.openChatIntent(this, callerId, true);
        PendingIntent declinePi = CallActionReceiver.declineIntent(this, callerId);
        Person caller = new Person.Builder().setName(name).setImportant(true).build();

        return new NotificationCompat.Builder(this, OpenWLMNotifications.CHANNEL_INCOMING_CALLS)
            .setSmallIcon(R.drawable.ic_stat_openwlm)
            .setColor(ContextCompat.getColor(this, R.color.colorPrimary))
            .setContentTitle(name)
            .setContentText(loc.getString(video ? R.string.notif_call_video : R.string.notif_call_audio))
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setContentIntent(fullPi)
            .setFullScreenIntent(fullPi, true)
            .setStyle(NotificationCompat.CallStyle.forIncomingCall(caller, declinePi, answerPi).setIsVideo(video))
            .build();
    }

    /** Sonnerie et vibration selon le mode du téléphone (comme un appel téléphonique). */
    private void startSounds() {
        AudioManager audio = ContextCompat.getSystemService(this, AudioManager.class);
        NotificationManager nm = ContextCompat.getSystemService(this, NotificationManager.class);
        int mode = audio != null ? audio.getRingerMode() : AudioManager.RINGER_MODE_NORMAL;
        // « Ne pas déranger » actif : écran d'appel sans son ni vibration
        boolean dnd = nm != null && nm.getCurrentInterruptionFilter() > NotificationManager.INTERRUPTION_FILTER_ALL;
        if (dnd || mode == AudioManager.RINGER_MODE_SILENT) return;

        vibrator = ContextCompat.getSystemService(this, Vibrator.class);
        if (vibrator != null && vibrator.hasVibrator()) {
            AudioAttributes attrs = new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).build();
            vibrator.vibrate(VibrationEffect.createWaveform(VIBRATION, 0), attrs);
        }
        if (mode != AudioManager.RINGER_MODE_NORMAL) return;

        Uri uri = RingtoneManager.getActualDefaultRingtoneUri(this, RingtoneManager.TYPE_RINGTONE);
        if (uri == null) uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
        ringtone = RingtoneManager.getRingtone(this, uri);
        if (ringtone == null) return;
        ringtone.setAudioAttributes(new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build());
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            ringtone.setLooping(true);
            ringtone.play();
        } else {
            ringtone.play();
            handler.postDelayed(ringtoneLoop, 1000);
        }
    }

    private void stopSounds() {
        handler.removeCallbacks(ringtoneLoop);
        if (ringtone != null) {
            ringtone.stop();
            ringtone = null;
        }
        if (vibrator != null) {
            vibrator.cancel();
            vibrator = null;
        }
    }

    private void onTimeout() {
        int callerId = ringingCallerId;
        String name = ringingName;
        stopRinging();
        if (callerId > 0) OpenWLMNotifications.showMissedCall(this, name, callerId);
        stopSelf();
    }

    private void stopRinging() {
        handler.removeCallbacks(timeout);
        stopSounds();
        ringingCallerId = 0;
        deviceLockedWhenRang = false;
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        IncomingCallActivity.finishIfShowing();
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        stopSounds();
        ringingCallerId = 0;
        deviceLockedWhenRang = false;
        IncomingCallActivity.finishIfShowing();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
