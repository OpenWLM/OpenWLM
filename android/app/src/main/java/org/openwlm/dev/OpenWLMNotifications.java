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
import android.net.Uri;
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
 * langue choisie dans l'app. Les appels entrants passent par IncomingCallService (écran
 * d'appel, sonnerie).
 *
 * Sons : un message reçu et un Wizz font entendre les sons de l'app (res/raw, copies de
 * public/assets/sounds/type.mp3 et nudge.mp3), portés par leur canal pour respecter le mode du
 * téléphone (silencieux, vibreur, Ne pas déranger) et rester modifiables dans les réglages
 * d'Android. Les autres sons de l'app (contact en ligne, clins d'œil…) ne sont joués que l'app
 * ouverte. Réglages Sons de l'app : cf. setSoundPrefs.
 */
final class OpenWLMNotifications {

    /** Messages, fichiers, notifications d'appel discrètes : son de message de l'app. */
    static final String CHANNEL_MESSAGES = "messages_wlm";
    /** Wizz : son du Wizz de l'app. */
    static final String CHANNEL_NUDGES = "nudges";
    /** Canal des v1 à v6 (son de notification du téléphone), remplacé par CHANNEL_MESSAGES : le son d'un canal ne peut plus changer une fois créé. */
    private static final String LEGACY_CHANNEL_MESSAGES = "messages";
    /** Appel entrant : notification plein écran, la sonnerie est jouée par IncomingCallService. */
    static final String CHANNEL_INCOMING_CALLS = "incoming_calls";
    /** Appel en cours : notification discrète du service de premier plan. */
    static final String CHANNEL_ONGOING_CALL = "ongoing_call";
    /**
     * Appel entrant quand le service d'appel n'a pas pu démarrer (rare : restrictions d'arrière-
     * plan) : notification simple, avec la SONNERIE du téléphone (et non le son de message).
     */
    static final String CHANNEL_CALL_FALLBACK = "calls_fallback";
    /** Canal de la v2 (sonnerie portée par la notification), remplacé par CHANNEL_INCOMING_CALLS. */
    private static final String LEGACY_CHANNEL_CALLS = "calls";

    static final String EXTRA_CHAT_ID = "org.openwlm.dev.CHAT_ID";
    /** Avec EXTRA_CHAT_ID : l'utilisateur a choisi « Répondre » à l'appel de ce contact. */
    static final String EXTRA_ANSWER = "org.openwlm.dev.ANSWER";
    private static final int NOTIFICATION_ID = 1;

    private static final String PREFS = "openwlm_app";
    private static final String KEY_LANG = "lang";
    private static final String KEY_SOUND_MESSAGE = "sound_message";
    private static final String KEY_SOUND_NUDGE = "sound_nudge";

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

    /**
     * Réglages Sons de l'app (Options → Sons : sons coupés, catégorie désactivée, « Occupé »),
     * transmis par l'interface : son coupé → notification silencieuse (toujours affichée).
     */
    static void setSoundPrefs(Context context, boolean message, boolean nudge) {
        prefs(context).edit().putBoolean(KEY_SOUND_MESSAGE, message).putBoolean(KEY_SOUND_NUDGE, nudge).apply();
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

        AudioAttributes sound = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_COMMUNICATION_INSTANT)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build();
        nm.deleteNotificationChannel(LEGACY_CHANNEL_MESSAGES);
        NotificationChannel messages = new NotificationChannel(CHANNEL_MESSAGES, loc.getString(R.string.channel_messages), NotificationManager.IMPORTANCE_HIGH);
        messages.setDescription(loc.getString(R.string.channel_messages_desc));
        messages.setSound(rawSound(context, "wlm_message"), sound);
        messages.enableVibration(true);
        nm.createNotificationChannel(messages);

        NotificationChannel nudges = new NotificationChannel(CHANNEL_NUDGES, loc.getString(R.string.channel_nudges), NotificationManager.IMPORTANCE_HIGH);
        nudges.setDescription(loc.getString(R.string.channel_nudges_desc));
        nudges.setSound(rawSound(context, "wlm_nudge"), sound);
        nudges.enableVibration(true);
        nm.createNotificationChannel(nudges);

        nm.deleteNotificationChannel(LEGACY_CHANNEL_CALLS);
        NotificationChannel fallback = new NotificationChannel(CHANNEL_CALL_FALLBACK, loc.getString(R.string.channel_calls), NotificationManager.IMPORTANCE_HIGH);
        fallback.setDescription(loc.getString(R.string.channel_call_fallback_desc));
        fallback.setSound(android.media.RingtoneManager.getDefaultUri(android.media.RingtoneManager.TYPE_RINGTONE),
            new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build());
        fallback.enableVibration(true);
        fallback.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(fallback);
        NotificationChannel incoming = new NotificationChannel(CHANNEL_INCOMING_CALLS, loc.getString(R.string.channel_calls), NotificationManager.IMPORTANCE_HIGH);
        incoming.setDescription(loc.getString(R.string.channel_calls_desc));
        incoming.setSound(null, null);
        incoming.enableVibration(false);
        incoming.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(incoming);

        NotificationChannel ongoing = new NotificationChannel(CHANNEL_ONGOING_CALL, loc.getString(R.string.channel_ongoing_call), NotificationManager.IMPORTANCE_LOW);
        ongoing.setDescription(loc.getString(R.string.channel_ongoing_call_desc));
        ongoing.setSound(null, null);
        ongoing.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(ongoing);
    }

    /** Affiche (ou retire) la notification correspondant à un message FCM du serveur. */
    static void handle(Context context, Map<String, String> data) {
        String type = data.containsKey("type") ? data.get("type") : "message";
        String tag = data.containsKey("tag") ? data.get("tag") : "openwlm-message";
        NotificationManagerCompat nm = NotificationManagerCompat.from(context);
        boolean appVisible = MainActivity.isUserVisible();

        if ("call".equals(type)) {
            // Toujours l'écran d'appel natif : si le serveur réveille cet appareil, l'interface
            // n'a pas confirmé l'appel. Elle l'arrêtera elle-même dès qu'elle l'affiche.
            IncomingCallService.ring(context, data);
            return;
        }

        if ("call_cancel".equals(type)) {
            // Fin d'un appel qui sonnait : la sonnerie s'arrête et la notification est remplacée
            // (manqué, pris ou refusé ailleurs)
            IncomingCallService.stop(context, parseId(data.get("senderId")));
            nm.cancel(tag, NOTIFICATION_ID);
            String reason = data.get("reason");
            if (appVisible && ("answered".equals(reason) || "declined".equals(reason))) return;
            notify(context, tag, base(context, data, CHANNEL_MESSAGES).setSilent(true).setAutoCancel(true).build());
            return;
        }

        // App au premier plan : c'est elle qui affiche ses alertes (avec le contenu déchiffré),
        // sauf la notification de test demandée depuis les Options
        if (appVisible && !"pushTest".equals(data.get("l10n"))) return;
        boolean nudge = "nudge".equals(data.get("l10n"));
        boolean soundOn = prefs(context).getBoolean(nudge ? KEY_SOUND_NUDGE : KEY_SOUND_MESSAGE, true);
        notify(context, tag, base(context, data, nudge ? CHANNEL_NUDGES : CHANNEL_MESSAGES)
            .setSilent(!soundOn)
            .setAutoCancel(true)
            .build());
    }

    /** Son embarqué (res/raw), désigné par son nom : stable d'une version de l'APK à l'autre. */
    private static Uri rawSound(Context context, String name) {
        return Uri.parse("android.resource://" + context.getPackageName() + "/raw/" + name);
    }

    /** « Appel manqué » : l'appel a expiré sans réponse sur cet appareil. */
    static void showMissedCall(Context context, String callerName, int callerId) {
        Map<String, String> data = new HashMap<>();
        data.put("title", callerName);
        data.put("l10n", "callMissed");
        data.put("senderId", String.valueOf(callerId));
        notify(context, callTag(callerId), base(context, data, CHANNEL_MESSAGES).setSilent(true).setAutoCancel(true).build());
    }

    static String callTag(int callerId) {
        return "openwlm-call-" + callerId;
    }

    /** Texte d'une clé `l10n` dans la langue de l'app. */
    static String text(Context context, String l10n) {
        Integer res = l10n != null ? TEXTS.get(l10n) : null;
        return localized(context).getString(res != null ? res : R.string.notif_message);
    }

    /** Nom de l'appelant à partir du titre envoyé par le serveur (« Nom — OpenWLM »). */
    static String callerName(String title) {
        if (title == null || title.isEmpty()) return "OpenWLM";
        return title.replaceFirst("\\s+[—-]\\s+OpenWLM$", "");
    }

    private static NotificationCompat.Builder base(Context context, Map<String, String> data, String channel) {
        String l10n = data.get("l10n");
        String body = l10n != null && TEXTS.containsKey(l10n) ? text(context, l10n) : (data.containsKey("body") ? data.get("body") : text(context, "message"));
        String title = data.containsKey("title") ? data.get("title") : "OpenWLM";
        int senderId = parseId(data.containsKey("senderId") ? data.get("senderId") : data.get("callerId"));
        return new NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_stat_openwlm)
            .setColor(ContextCompat.getColor(context, R.color.colorPrimary))
            .setContentTitle(title)
            .setContentText(body)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setContentIntent(openChatIntent(context, senderId, false));
    }

    /** Ouvre l'app sur la conversation de `senderId` (0 : simplement l'app) ; `answer` : prendre son appel. */
    static PendingIntent openChatIntent(Context context, int senderId, boolean answer) {
        Intent intent = new Intent(context, MainActivity.class)
            .setAction(answer ? "org.openwlm.dev.ANSWER_CALL" : Intent.ACTION_VIEW)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (senderId > 0) intent.putExtra(EXTRA_CHAT_ID, senderId);
        if (answer) intent.putExtra(EXTRA_ANSWER, true);
        int requestCode = senderId * 2 + (answer ? 1 : 0);
        return PendingIntent.getActivity(context, requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
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

    static int parseId(String s) {
        try {
            return s == null ? 0 : Integer.parseInt(s);
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    static long parseLong(String s) {
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
