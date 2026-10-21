package org.openwlm.dev;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

public class CallTimingTest {

    private static final long T = 1_800_000_000_000L;

    @Test
    public void dureeCalculeeDepuisLHeureDEnvoiFirebase() {
        // Téléphone en avance de 2 min : sans effet, seule compte l'heure d'envoi Firebase
        assertEquals(Long.valueOf(60_000), CallTiming.ringDurationMs(T + 60_000, T, T + 120_000));
        // Téléphone en retard de 10 min : sonnerie toujours bornée par l'appel
        assertEquals(Long.valueOf(60_000), CallTiming.ringDurationMs(T + 60_000, T, T - 600_000));
    }

    @Test
    public void sansHeureDEnvoiHorlogeDuTelephoneBornee() {
        assertEquals(Long.valueOf(45_000), CallTiming.ringDurationMs(T + 45_000, 0, T));
        // Téléphone en retard : jamais plus de 90 s
        assertEquals(Long.valueOf(CallTiming.MAX_RING_MS), CallTiming.ringDurationMs(T + 600_000, 0, T));
        // Fin dépassée de moins d'une minute (téléphone en avance) : l'appel sonne quand même
        assertEquals(Long.valueOf(CallTiming.MIN_RING_MS), CallTiming.ringDurationMs(T, 0, T + 50_000));
    }

    @Test
    public void appelPerime() {
        assertNull(CallTiming.ringDurationMs(T, 0, T + 61_000));
        assertNull(CallTiming.ringDurationMs(T, T + 61_000, 0));
    }

    @Test
    public void sansFinConnue() {
        assertEquals(Long.valueOf(CallTiming.DEFAULT_RING_MS), CallTiming.ringDurationMs(0, T, T));
    }
}
