package org.openwlm.dev;

import android.Manifest;
import android.app.Notification;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.Person;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

/**
 * Appel en cours : service de premier plan (types « phoneCall » et « microphone », plus
 * « camera » en vidéo) qui garde l'app et l'audio de l'appel actifs écran éteint, à la place des
 * contournements web (piste quasi silencieuse, Screen Wake Lock).
 *
 * Audio en mode communication : écouteur avec capteur de proximité (écran éteint contre
 * l'oreille) en appel audio, haut-parleur en vidéo ; bascule depuis la notification.
 */
public class OngoingCallService extends Service {

    private static final String ACTION_START = "org.openwlm.dev.CALL_START";
    private static final String ACTION_UPDATE = "org.openwlm.dev.CALL_UPDATE";
    static final String ACTION_TOGGLE_SPEAKER = "org.openwlm.dev.CALL_SPEAKER";
    private static final String ACTION_STOP = "org.openwlm.dev.CALL_STOP";
    private static final String EXTRA_NAME = "name";
    private static final String EXTRA_VIDEO = "video";
    private static final int NOTIFICATION_ID = 1002;

    private static volatile boolean running;

    private String peerName = "OpenWLM";
    /** Début de l'appel (chronomètre de la notification, inchangé quand elle est mise à jour). */
    private long startedAt;
    private boolean video;
    private boolean speaker;
    private boolean speakerChosen;
    private AudioManager audio;
    private int previousAudioMode = AudioManager.MODE_NORMAL;
    private PowerManager.WakeLock cpuLock;
    private PowerManager.WakeLock proximityLock;

    static void start(Context context, String peerName, boolean video) {
        Intent intent = new Intent(context, OngoingCallService.class)
            .setAction(ACTION_START)
            .putExtra(EXTRA_NAME, peerName)
            .putExtra(EXTRA_VIDEO, video);
        ContextCompat.startForegroundService(context, intent);
    }

    /** Vidéo active ou non (caméra, partage d'écran ou vidéo du correspondant). */
    static void update(Context context, boolean video) {
        if (!running) return;
        context.startService(new Intent(context, OngoingCallService.class).setAction(ACTION_UPDATE).putExtra(EXTRA_VIDEO, video));
    }

    static void stop(Context context) {
        if (!running) return;
        try {
            context.startService(new Intent(context, OngoingCallService.class).setAction(ACTION_STOP));
        } catch (RuntimeException e) {
            running = false;
        }
    }

    static boolean isRunning() {
        return running;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        audio = ContextCompat.getSystemService(this, AudioManager.class);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_START.equals(action)) {
            String name = intent.getStringExtra(EXTRA_NAME);
            peerName = name != null && !name.isEmpty() ? name : "OpenWLM";
            video = intent.getBooleanExtra(EXTRA_VIDEO, false);
            if (!running) {
                speakerChosen = false;
                startedAt = System.currentTimeMillis();
                if (!goForeground()) {
                    stopSelf();
                    return START_NOT_STICKY;
                }
                startAudio();
            }
            running = true;
            applyRouting();
        } else if (ACTION_UPDATE.equals(action) && running) {
            boolean v = intent.getBooleanExtra(EXTRA_VIDEO, false);
            if (v != video) {
                video = v;
                goForeground();
                applyRouting();
            }
        } else if (ACTION_TOGGLE_SPEAKER.equals(action) && running) {
            speakerChosen = true;
            speaker = !speaker;
            applyRouting();
        } else {
            stopCall();
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    private boolean goForeground() {
        int type = 0;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            type = ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            if (granted(Manifest.permission.RECORD_AUDIO)) type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
            if (video && granted(Manifest.permission.CAMERA)) type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
        }
        try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(), type);
            return true;
        } catch (RuntimeException e) {
            // Refusé (app pas au premier plan au démarrage de l'appel) : l'appel continue sans
            return false;
        }
    }

    private boolean granted(String permission) {
        return ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED;
    }

    private Notification buildNotification() {
        Context loc = OpenWLMNotifications.localized(this);
        OpenWLMNotifications.ensureChannels(this);
        Person peer = new Person.Builder().setName(peerName).setImportant(true).build();
        return new NotificationCompat.Builder(this, OpenWLMNotifications.CHANNEL_ONGOING_CALL)
            .setSmallIcon(R.drawable.ic_stat_openwlm)
            .setColor(ContextCompat.getColor(this, R.color.colorPrimary))
            .setContentTitle(peerName)
            .setContentText(loc.getString(video ? R.string.call_ongoing_video : R.string.call_ongoing_audio))
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setOngoing(true)
            .setUsesChronometer(true)
            .setWhen(startedAt)
            .setContentIntent(OpenWLMNotifications.openChatIntent(this, 0, false))
            .setStyle(NotificationCompat.CallStyle.forOngoingCall(peer, CallActionReceiver.hangUpIntent(this)).setIsVideo(video))
            .addAction(0, loc.getString(speaker ? R.string.call_earpiece : R.string.call_speaker), CallActionReceiver.speakerIntent(this))
            .build();
    }

    private void startAudio() {
        PowerManager pm = ContextCompat.getSystemService(this, PowerManager.class);
        if (pm != null) {
            cpuLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "OpenWLM:call");
            cpuLock.setReferenceCounted(false);
            cpuLock.acquire(4 * 60 * 60 * 1000L);
            if (pm.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) {
                proximityLock = pm.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "OpenWLM:proximity");
                proximityLock.setReferenceCounted(false);
            }
        }
        if (audio != null) {
            previousAudioMode = audio.getMode();
            audio.setMode(AudioManager.MODE_IN_COMMUNICATION);
        }
    }

    /** Écouteur ou haut-parleur ; capteur de proximité seulement à l'écouteur. */
    private void applyRouting() {
        if (!speakerChosen) speaker = video;
        if (audio != null) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                if (speaker) {
                    for (AudioDeviceInfo device : audio.getAvailableCommunicationDevices()) {
                        if (device.getType() == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) {
                            audio.setCommunicationDevice(device);
                            break;
                        }
                    }
                } else {
                    // Choix du système : casque ou Bluetooth s'il y en a un, sinon l'écouteur
                    audio.clearCommunicationDevice();
                }
            } else {
                audio.setSpeakerphoneOn(speaker);
            }
        }
        if (proximityLock != null) {
            if (!speaker && !video) proximityLock.acquire(4 * 60 * 60 * 1000L);
            else if (proximityLock.isHeld()) proximityLock.release();
        }
        if (running) {
            try {
                ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(), currentType());
            } catch (RuntimeException ignored) {
                // Notification inchangée
            }
        }
    }

    private int currentType() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? getForegroundServiceType() : 0;
    }

    private void stopCall() {
        running = false;
        if (proximityLock != null && proximityLock.isHeld()) proximityLock.release();
        if (cpuLock != null && cpuLock.isHeld()) cpuLock.release();
        proximityLock = null;
        cpuLock = null;
        if (audio != null) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) audio.clearCommunicationDevice();
            else audio.setSpeakerphoneOn(false);
            audio.setMode(previousAudioMode == AudioManager.MODE_IN_COMMUNICATION ? AudioManager.MODE_NORMAL : previousAudioMode);
        }
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
    }

    @Override
    public void onDestroy() {
        if (running) stopCall();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
