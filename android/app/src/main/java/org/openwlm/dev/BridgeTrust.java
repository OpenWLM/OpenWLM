package org.openwlm.dev;

import java.net.URI;
import java.util.Locale;

/**
 * Règles d'accès au pont natif et au micro / à la caméra (sans dépendance Android, testées :
 * BridgeTrustTest).
 *
 * La navigation est déjà limitée à l'hôte choisi (setAllowNavigation), mais par défense en
 * profondeur chaque usage sensible vérifie aussi l'origine réelle de la page.
 */
final class BridgeTrust {

    /** Après « Répondre » sur l'écran d'appel natif : micro / caméra permis le temps de décrocher. */
    static final long ANSWER_MEDIA_GRACE_MS = 60_000;

    private BridgeTrust() {}

    /** La page (ou l'origine d'une demande) est-elle le serveur choisi, en HTTPS ? */
    static boolean isTrustedPage(String url, String serverHost) {
        if (url == null || serverHost == null) return false;
        try {
            URI uri = new URI(url);
            String host = uri.getHost();
            int port = uri.getPort();
            String authority = host == null ? null : (port == -1 || port == 443 ? host : host + ":" + port);
            return "https".equalsIgnoreCase(uri.getScheme())
                && authority != null
                && authority.toLowerCase(Locale.ROOT).equals(serverHost.toLowerCase(Locale.ROOT));
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Micro / caméra demandés par la page : seulement depuis le serveur choisi, et seulement si
     * l'utilisateur voit l'app déverrouillée, si un appel est en cours (service d'appel), ou
     * juste après « Répondre » (appel pris derrière l'écran de verrouillage de l'app). Une page
     * compromise ne peut donc pas écouter en arrière-plan ni derrière le verrouillage.
     */
    /**
     * Chemins du serveur local de Capacitor qui servent des fichiers du téléphone à la page
     * (/_capacitor_file_/<chemin absolu>, /_capacitor_content_/<content://…>). L'app n'en a
     * aucun usage (pas de plugin Filesystem) ; une page compromise, ou un serveur personnalisé
     * malveillant, y lirait les cookies de session et les clés E2EE de la WebView. Refusés par
     * GuardedWebViewClient.
     */
    static boolean isForbiddenLocalPath(String path) {
        if (path == null) return false;
        String p = path.toLowerCase(Locale.ROOT);
        return p.startsWith("/_capacitor_file_") || p.startsWith("/_capacitor_content_");
    }

    static boolean allowMediaCapture(String origin, String serverHost, boolean userVisible, boolean callActive, long now, long answerGraceUntil) {
        if (!isTrustedPage(origin, serverHost)) return false;
        return userVisible || callActive || now < answerGraceUntil;
    }
}
