package org.openwlm.dev;

/**
 * Règle du passe-droit de verrouillage de l'app après « Répondre » (sans dépendance Android,
 * testée sur la JVM : AppLockPolicyTest).
 *
 * L'app ne redemande pas son déverrouillage seulement si le téléphone exigeait réellement un
 * code ou une empreinte quand l'appel a sonné (KeyguardManager.isDeviceLocked, faux pendant le
 * délai de grâce ou en Smart Lock), qu'il n'en exige plus (son propriétaire vient de le
 * déverrouiller pour répondre), et que la réponse concerne l'appel qui sonne encore.
 */
final class AppLockPolicy {

    /** Durée du passe-droit, le temps que l'app s'ouvre. */
    static final long SKIP_LOCK_MS = 10_000;

    private AppLockPolicy() {}

    static boolean skipLockForAnswer(boolean answer, int chatId, int ringingCallerId, boolean deviceLockedWhenRang, boolean deviceLockedNow) {
        return answer
            && chatId > 0
            && chatId == ringingCallerId
            && deviceLockedWhenRang
            && !deviceLockedNow;
    }
}
