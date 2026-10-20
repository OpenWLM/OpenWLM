package org.openwlm.dev;

import android.app.Activity;
import android.app.KeyguardManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import android.widget.TextView;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import java.lang.ref.WeakReference;

/**
 * Écran d'appel entrant, affiché par-dessus l'écran verrouillé (intention plein écran de la
 * notification d'IncomingCallService). « Répondre » demande d'abord de déverrouiller le
 * téléphone, puis ouvre l'app sur la conversation qui prend l'appel.
 */
public class IncomingCallActivity extends AppCompatActivity {

    private static WeakReference<Activity> showing = new WeakReference<>(null);

    /** La sonnerie s'est arrêtée (fin d'appel, réponse ailleurs…) : fermer l'écran d'appel. */
    static void finishIfShowing() {
        Activity activity = showing.get();
        if (activity != null) activity.runOnUiThread(activity::finish);
    }

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        int callerId = IncomingCallService.ringingCallerId();
        if (callerId <= 0) {
            finish();
            return;
        }
        showing = new WeakReference<>(this);
        setContentView(R.layout.activity_incoming_call);
        Context loc = OpenWLMNotifications.localized(this);
        ((TextView) findViewById(R.id.call_name)).setText(IncomingCallService.ringingName());
        ((TextView) findViewById(R.id.call_type)).setText(loc.getString(IncomingCallService.ringingVideo() ? R.string.notif_call_video : R.string.notif_call_audio));
        ((TextView) findViewById(R.id.call_answer)).setText(loc.getString(R.string.notif_answer));
        ((TextView) findViewById(R.id.call_decline)).setText(loc.getString(R.string.notif_decline));

        findViewById(R.id.call_decline).setOnClickListener(v -> {
            sendBroadcast(new Intent(this, CallActionReceiver.class)
                .setAction(CallActionReceiver.ACTION_DECLINE)
                .putExtra(CallActionReceiver.EXTRA_CALLER_ID, callerId));
            finish();
        });
        findViewById(R.id.call_answer).setOnClickListener(v -> answer(callerId));
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (IncomingCallService.ringingCallerId() <= 0) finish();
    }

    private void answer(int callerId) {
        KeyguardManager km = ContextCompat.getSystemService(this, KeyguardManager.class);
        if (km != null && km.isKeyguardLocked()) {
            // Déverrouillage du téléphone (empreinte, code…) avant d'ouvrir les conversations
            km.requestDismissKeyguard(this, new KeyguardManager.KeyguardDismissCallback() {
                @Override
                public void onDismissSucceeded() {
                    openApp(callerId);
                }
            });
            return;
        }
        openApp(callerId);
    }

    private void openApp(int callerId) {
        try {
            OpenWLMNotifications.openChatIntent(this, callerId, true).send();
        } catch (PendingIntent.CanceledException ignored) {
            // Ne peut pas arriver (intention créée ici)
        }
        finish();
    }

    @Override
    protected void onDestroy() {
        if (showing.get() == this) showing = new WeakReference<>(null);
        super.onDestroy();
    }

    /**
     * Le système a refusé de démarrer le service d'appel (rare : restrictions d'arrière-plan) :
     * notification d'appel simple, sans sonnerie en boucle.
     */
    static void fallbackNotification(Context context, int callerId, String name, boolean video) {
        Context loc = OpenWLMNotifications.localized(context);
        OpenWLMNotifications.ensureChannels(context);
        // Pas de CallStyle ici : Android l'exige associé à un service de premier plan
        NotificationCompat.Builder b = new NotificationCompat.Builder(context, OpenWLMNotifications.CHANNEL_MESSAGES)
            .setSmallIcon(R.drawable.ic_stat_openwlm)
            .setColor(ContextCompat.getColor(context, R.color.colorPrimary))
            .setContentTitle(name)
            .setContentText(loc.getString(video ? R.string.notif_call_video : R.string.notif_call_audio))
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setAutoCancel(true)
            .setTimeoutAfter(60_000)
            .setContentIntent(OpenWLMNotifications.openChatIntent(context, callerId, false))
            .addAction(0, loc.getString(R.string.notif_decline), CallActionReceiver.declineIntent(context, callerId))
            .addAction(0, loc.getString(R.string.notif_answer), OpenWLMNotifications.openChatIntent(context, callerId, true));
        try {
            NotificationManagerCompat.from(context).notify(OpenWLMNotifications.callTag(callerId), 1, b.build());
        } catch (SecurityException ignored) {
            // Notifications refusées
        }
    }
}
