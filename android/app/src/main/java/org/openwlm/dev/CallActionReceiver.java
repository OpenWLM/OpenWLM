package org.openwlm.dev;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Boutons des notifications d'appel :
 * - « Refuser » (appel entrant) : refuse l'appel sans ouvrir l'app (POST /api/calls/decline,
 *   avec le cookie de session de la WebView), comme public/sw.js ;
 * - « Raccrocher » (appel en cours) : transmis à l'interface, qui termine l'appel ;
 * - « Haut-parleur » / « Écouteur » (appel en cours).
 */
public class CallActionReceiver extends BroadcastReceiver {

    static final String ACTION_DECLINE = "org.openwlm.dev.DECLINE_CALL";
    static final String ACTION_HANGUP = "org.openwlm.dev.HANGUP_CALL";
    static final String EXTRA_CALLER_ID = "callerId";
    private static final String TAG = "OpenWLM";

    static PendingIntent declineIntent(Context context, int callerId) {
        Intent intent = new Intent(context, CallActionReceiver.class)
            .setAction(ACTION_DECLINE)
            .putExtra(EXTRA_CALLER_ID, callerId);
        return PendingIntent.getBroadcast(context, callerId, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static PendingIntent hangUpIntent(Context context) {
        Intent intent = new Intent(context, CallActionReceiver.class).setAction(ACTION_HANGUP);
        return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static PendingIntent speakerIntent(Context context) {
        Intent intent = new Intent(context, OngoingCallService.class).setAction(OngoingCallService.ACTION_TOGGLE_SPEAKER);
        return PendingIntent.getService(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (ACTION_HANGUP.equals(action)) {
            OpenWLMNativePlugin.onHangUpRequested();
            OngoingCallService.stop(context);
            return;
        }
        if (!ACTION_DECLINE.equals(action)) return;
        int callerId = intent.getIntExtra(EXTRA_CALLER_ID, 0);
        IncomingCallService.stop(context, callerId);
        if (callerId <= 0) return;
        OpenWLMNotifications.cancel(context, OpenWLMNotifications.callTag(callerId));

        String host = ServerConfig.getHost(context);
        if (host == null) return;
        String url = ServerConfig.urlFor(host) + "/api/calls/decline";
        PendingResult pending = goAsync();
        new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                String cookie = CookieManager.getInstance().getCookie(url);
                conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setRequestMethod("POST");
                conn.setConnectTimeout(10_000);
                conn.setReadTimeout(10_000);
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/json");
                if (cookie != null) conn.setRequestProperty("Cookie", cookie);
                // Même agent que la WebView : la requête ressemble à celles de l'app (Cloudflare)
                conn.setRequestProperty("User-Agent", WebSettings.getDefaultUserAgent(context));
                try (OutputStream out = conn.getOutputStream()) {
                    out.write(("{\"callerId\":" + callerId + "}").getBytes(StandardCharsets.UTF_8));
                }
                // Diagnostic (ni cookie ni identité) : 200 refusé, 404 plus d'appel en attente,
                // 401/403 session ou Cloudflare
                Log.i(TAG, "Refus d'appel : HTTP " + conn.getResponseCode());
            } catch (Exception e) {
                // Hors ligne : l'appel expirera de lui-même
                Log.w(TAG, "Refus d'appel impossible : " + e.getClass().getSimpleName());
            } finally {
                if (conn != null) conn.disconnect();
                pending.finish();
            }
        }).start();
    }
}
