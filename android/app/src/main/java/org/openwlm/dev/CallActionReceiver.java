package org.openwlm.dev;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.webkit.CookieManager;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Bouton « Refuser » de la notification d'appel : refuse l'appel sans ouvrir l'app
 * (POST /api/calls/decline, avec le cookie de session de la WebView), comme public/sw.js.
 */
public class CallActionReceiver extends BroadcastReceiver {

    static final String ACTION_DECLINE = "org.openwlm.dev.DECLINE_CALL";
    static final String EXTRA_CALLER_ID = "callerId";
    static final String EXTRA_TAG = "tag";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!ACTION_DECLINE.equals(intent.getAction())) return;
        int callerId = intent.getIntExtra(EXTRA_CALLER_ID, 0);
        String tag = intent.getStringExtra(EXTRA_TAG);
        if (tag != null) OpenWLMNotifications.cancel(context, tag);
        if (callerId <= 0) return;

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
                try (OutputStream out = conn.getOutputStream()) {
                    out.write(("{\"callerId\":" + callerId + "}").getBytes(StandardCharsets.UTF_8));
                }
                conn.getResponseCode();
            } catch (Exception ignored) {
                // Hors ligne : l'appel expirera de lui-même
            } finally {
                if (conn != null) conn.disconnect();
                pending.finish();
            }
        }).start();
    }
}
