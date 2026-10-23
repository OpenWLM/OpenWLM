package org.openwlm.dev;

import android.net.Uri;
import android.util.Log;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import java.io.ByteArrayInputStream;
import java.util.Collections;

/**
 * Requêtes de la page filtrées avant le serveur local de Capacitor : les chemins qui servent des
 * fichiers du téléphone (cf. BridgeTrust.isForbiddenLocalPath) reçoivent une réponse 404 vide.
 * Sans cela, `fetch('/_capacitor_file_/data/data/<app>/app_webview/Default/Cookies')` renvoyait
 * le fichier, malgré setAllowFileAccess(false) et la CSP (`connect-src 'self'` : même origine).
 */
class GuardedWebViewClient extends BridgeWebViewClient {

    GuardedWebViewClient(Bridge bridge) {
        super(bridge);
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri url = request.getUrl();
        // Chemin décodé ET brut, chacun normalisé (segments « .. », barres multiples, %xx)
        if (url != null && (BridgeTrust.isForbiddenLocalPath(url.getPath()) || BridgeTrust.isForbiddenLocalPath(url.getEncodedPath()))) {
            Log.w("OpenWLM", "Accès à un fichier local refusé : " + url.getPath());
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
        }
        return super.shouldInterceptRequest(view, request);
    }
}
