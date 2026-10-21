package org.openwlm.dev;

/** Durée de sonnerie d'un appel entrant (sans dépendance Android, testée : CallTimingTest). */
final class CallTiming {

    static final long DEFAULT_RING_MS = 60_000;
    /** Bornes de la sonnerie, quelle que soit l'horloge du téléphone. */
    static final long MIN_RING_MS = 5_000;
    static final long MAX_RING_MS = 90_000;
    /** Au-delà, l'appel est périmé : rien n'est affiché. */
    static final long STALE_AFTER_MS = 60_000;

    private CallTiming() {}

    /**
     * `expiresAt` vient de l'horloge du serveur : comparé à l'heure d'envoi Firebase
     * (`sentTime`, horloge des serveurs Google), il ne dépend pas de celle du téléphone. Sans
     * heure d'envoi, comparaison avec l'horloge du téléphone. Résultat borné (5 à 90 s) ; null :
     * appel périmé (fin dépassée de plus d'une minute). Le TTL FCM de 45 s écarte déjà les
     * appels livrés trop tard.
     */
    static Long ringDurationMs(long expiresAt, long sentTime, long now) {
        if (expiresAt <= 0) return DEFAULT_RING_MS;
        long remaining = sentTime > 0 ? expiresAt - sentTime : expiresAt - now;
        if (remaining < -STALE_AFTER_MS) return null;
        return Math.min(Math.max(remaining, MIN_RING_MS), MAX_RING_MS);
    }
}
