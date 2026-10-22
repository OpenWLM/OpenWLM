package org.openwlm.dev;

/**
 * Écran de changement de serveur (Options, page hors ligne). Non exporté : seule l'app peut
 * l'ouvrir, contrairement au lanceur ServerActivity qui ne sert qu'au premier choix.
 */
public class ServerSettingsActivity extends ServerActivity {

    @Override
    protected boolean isEditMode() {
        return true;
    }
}
