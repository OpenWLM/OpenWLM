package org.openwlm.dev;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Notifications de l'app construites à partir des messages FCM « data » du serveur (même
 * contenu que le Web Push, cf. public/sw.js) : le serveur envoie le nom de l'expéditeur et une
 * clé de traduction (`l10n`), jamais le texte d'un message ; le texte est pris ici dans la
 * langue choisie dans l'app.
 */
final class OpenWLMNotifications {

    static final String CHANNEL_MESSAGES = "messages";
    static final String CHANNEL_CALLS = "calls";
    static final String EXTRA_CHAT_ID = "org.openwlm.dev.CHAT_ID";
    private static final int NOTIFICATION_ID = 1;

    private static final String PREFS = "openwlm_app";
    private static final String KEY_LANG = "lang";

    /** Clés `l10n` du serveur (cf. L10N dans public/sw.js). */
    private static final Map<String, Integer> TEXTS = new HashMap<>();

    static {
        TEXTS.put("message", R.string.notif_message);
        TEXTS.put("privateMessage", R.string.notif_private_message);
        TEXTS.put("voice", R.string.notif_voice);
        TEXTS.put("file", R.string.notif_file);
        TEXTS.put("encrypted", R.string.notif_encrypted);
        TEXTS.put("nudge", R.string.notif_nudge);
        TEXTS.put("callAudio", R.string.notif_call_audio);
        TEXTS.put("callVideo", R.string.notif_call_video);
        TEXTS.put("callMissed", R.string.notif_call_missed);
        TEXTS.put("callAnswered", R.string.notif_call_answered);
        TEXTS.put("callDeclined", R.string.notif_call_declined);
        TEXTS.put("pushTest", R.string.notif_push_test);
    }

    private OpenWLMNotifications() {}

    /** Langue de l'app (« fr » / « en »), transmise par l'interface web. */
    static void setLanguage(Context context, String lang) {
        if (!"fr".equals(lang) && !"en".equals(lang)) return;
        prefs(context).edit().putString(KEY_LANG, lang).apply();
    }

    /** Contexte dont les ressources sont dans la langue de l'app (sinon celle du téléphone). */
    static Context localized(Context context) {
        String lang = prefs(context).getString(KEY_LANG, null);
        if (lang == null) return context;
        Configuration config = new Configuration(context.getResources().getConfiguration());
        config.setLocale(new Locale(lang));
        return context.createConfigurationContext(config);
    }

    static void ensureChannels(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        Context loc = localized(context);
        NotificationManager nm = ContextCompat.getSystemService(context, NotificationManager.class);
        if (nm == null) return;

        NotificationChannel messages = new NotificationChannel(CHANNEL_MESSAGES, loc.getString(R.string.channel_messages), NotificationManager.IMPORTANCE_HIGH);
        messages.setDescription(loc.getString(R.string.channel_messages_desc));
        messages.enableVibration(true);
        nm.createNotificationChannel(messages);

        // Appels : sonnerie du téléphone (répétée tant que la notification sonne, FLAG_INSISTENT)
        NotificationChannel calls = new NotificationChannel(CHANNEL_CALLS, loc.getString(R.string.channel_calls), NotificationManager.IMPORTANCE_HIGH);
        calls.setDescription(loc.getString(R.string.channel_calls_desc));
        calls.setSound(
            RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
            new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
        );
        calls.enableVibration(true);
        calls.setVibrationPattern(new long[] { 0, 800, 600, 800, 600 });
        calls.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(calls);
    }

    /** Affiche (ou retire) la notification correspondant à un message FCM du serveur. */
    static void handle(Context context, Map<String, String> data) {
        String type = data.containsKey("type") ? data.get("type") : "message";
        String tag = data.containsKey("tag") ? data.get("tag") : "openwlm-message";
        NotificationManagerCompat nm = NotificationManagerCompat.from(context);
        boolean appVisible = MainActivity.isUserVisible();

        if ("call_cancel".equals(type)) {
            // Fin d'un appel qui sonnait : la sonnerie est remplacée (manqué, pris ou refusé ailleurs)
            nm.cancel(tag, NOTIFICATION_ID);
            String reason = data.get("reason");
            if (appVisible && ("answered".equals(reason) || "declined".equals(reason))) return;
            notify(context, tag, base(context, data, CHANNEL_MESSAGES).setSilent(true).setAutoCancel(true).build());
            return;
        }

        // App au premier plan : c'est elle qui affiche ses alertes (avec le contenu déchiffré),
        // sauf la notification de test demandée depuis les Options
        if (appVisible && !"pushTest".equals(data.get("l10n"))) return;

        if ("call".equals(type)) {
            notify(context, tag, buildCall(context, data, tag));
            return;
        }
        notify(context, tag, base(context, data, CHANNEL_MESSAGES).setAutoCancel(true).build());
    }

    private static Notification buildCall(Context context, Map<String, String> data, String tag) {
        Context loc = localized(context);
        int callerId = parseId(data.get("callerId"));
        long expiresAt = parseLong(data.get("expiresAt"));
        long remaining = expiresAt > 0 ? expiresAt - System.currentTimeMillis() : 60_000;

        Intent decline = new Intent(context, CallActionReceiver.class)
            .setAction(CallActionReceiver.ACTION_DECLINE)
            .putExtra(CallActionReceiver.EXTRA_CALLER_ID, callerId)
            .putExtra(CallActionReceiver.EXTRA_TAG, tag);
        PendingIntent declinePi = PendingIntent.getBroadcast(context, callerId, decline, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder b = base(context, data, CHANNEL_CALLS)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(true)
            .setTimeoutAfter(Math.max(5_000, remaining))
            .addAction(0, loc.getString(R.string.notif_decline), declinePi)
            .addAction(0, loc.getString(R.string.notif_answer), openChatIntent(context, callerId));
        Notification n = b.build();
        n.flags |= Notification.FLAG_INSISTENT;
        return n;
    }

    private static NotificationCompat.Builder base(Context context, Map<String, String> data, String channel) {
        Context loc = localized(context);
        String l10n = data.get("l10n");
        Integer res = l10n != null ? TEXTS.get(l10n) : null;
        String body = res != null ? loc.getString(res) : (data.containsKey("body") ? data.get("body") : loc.getString(R.string.notif_message));
        String title = data.containsKey("title") ? data.get("title") : "OpenWLM";
        int senderId = parseId(data.containsKey("senderId") ? data.get("senderId") : data.get("callerId"));
        return new NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_stat_openwlm)
            .setColor(ContextCompat.getColor(context, R.color.colorPrimary))
            .setContentTitle(title)
            .setContentText(body)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setContentIntent(openChatIntent(context, senderId));
    }

    /** Ouvre l'app sur la conversation de `senderId` (0 : simplement l'app). */
    static PendingIntent openChatIntent(Context context, int senderId) {
        Intent intent = new Intent(context, MainActivity.class)
            .setAction(Intent.ACTION_VIEW)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (senderId > 0) intent.putExtra(EXTRA_CHAT_ID, senderId);
        return PendingIntent.getActivity(context, senderId, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static void cancel(Context context, String tag) {
        NotificationManagerCompat.from(context).cancel(tag, NOTIFICATION_ID);
    }

    private static void notify(Context context, String tag, Notification notification) {
        ensureChannels(context);
        try {
            NotificationManagerCompat.from(context).notify(tag, NOTIFICATION_ID, notification);
        } catch (SecurityException e) {
            // Notifications refusées (Android 13+) : rien à afficher
        }
    }

    private static int parseId(String s) {
        try {
            return s == null ? 0 : Integer.parseInt(s);
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    private static long parseLong(String s) {
        try {
            return s == null ? 0 : Long.parseLong(s);
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
