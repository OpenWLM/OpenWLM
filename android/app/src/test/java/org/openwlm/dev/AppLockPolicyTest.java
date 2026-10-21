package org.openwlm.dev;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class AppLockPolicyTest {

    @Test
    public void telephoneVerrouilleParCodePuisDeverrouillePourRepondre() {
        assertTrue(AppLockPolicy.skipLockForAnswer(true, 7, 7, true, false));
    }

    @Test
    public void delaiDeGraceOuSmartLockNeContournePasLeVerrouillage() {
        // Écran de verrouillage levable sans code : isDeviceLocked() était faux à la sonnerie
        assertFalse(AppLockPolicy.skipLockForAnswer(true, 7, 7, false, false));
    }

    @Test
    public void telephoneEncoreVerrouille() {
        assertFalse(AppLockPolicy.skipLockForAnswer(true, 7, 7, true, true));
    }

    @Test
    public void appelQuiNeSonnePlusOuAutreContact() {
        assertFalse(AppLockPolicy.skipLockForAnswer(true, 7, 0, true, false));
        assertFalse(AppLockPolicy.skipLockForAnswer(true, 7, 9, true, false));
        assertFalse(AppLockPolicy.skipLockForAnswer(true, 0, 0, true, false));
    }

    @Test
    public void simpleOuvertureDeConversation() {
        assertFalse(AppLockPolicy.skipLockForAnswer(false, 7, 7, true, false));
    }
}
