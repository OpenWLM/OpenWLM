package org.openwlm.dev;

import android.os.SystemClock;
import android.util.Log;
import android.webkit.PermissionRequest;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebChromeClient;

/**
 * Demandes de micro / caméra de la page (getUserMedia) filtrées avant d'être accordées par
 * Capacitor : origine = serveur choisi, et app visible et déverrouillée, ou appel en cours,
 * ou juste après « Répondre » (cf. BridgeTrust). Sinon refus, sans rien demander à Android.
 */
class GuardedWebChromeClient extends BridgeWebChromeClient {

    private final Bridge bridge;

    GuardedWebChromeClient(Bridge bridge) {
        super(bridge);
        this.bridge = bridge;
    }

    @Override
    public void onPermissionRequest(final PermissionRequest request) {
        String origin = request.getOrigin() != null ? request.getOrigin().toString() : null;
        boolean allowed = BridgeTrust.allowMediaCapture(
            origin,
            ServerConfig.getHost(bridge.getContext()),
            MainActivity.isUserVisible(),
            OngoingCallService.isRunning(),
            SystemClock.elapsedRealtime(),
            MainActivity.mediaAllowedUntil()
        );
        if (!allowed) {
            Log.w("OpenWLM", "Accès micro / caméra refusé (app verrouillée ou en arrière-plan sans appel, ou origine inattendue)");
            request.deny();
            return;
        }
        super.onPermissionRequest(request);
    }
}
