package org.openwlm.dev;

import android.app.Activity;
import android.app.Dialog;
import android.os.Build;
import android.view.View;
import android.view.Window;

/**
 * Protection contre le « tapjacking » : une app qui recouvre l'écran (fenêtre par-dessus les
 * autres) ne peut pas faire valider une décision de sécurité à l'insu de l'utilisateur.
 * - Les touches reçues pendant qu'une autre fenêtre recouvre la nôtre sont ignorées
 *   (filterTouchesWhenObscured sur toute la fenêtre, dialogues compris) ;
 * - Android 12+ : les fenêtres superposées d'autres apps sont masquées tant que la nôtre est
 *   affichée (HIDE_OVERLAY_WINDOWS).
 */
final class OverlayGuard {

    private OverlayGuard() {}

    static void protect(Window window) {
        if (window == null) return;
        View decor = window.getDecorView();
        decor.setFilterTouchesWhenObscured(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) window.setHideOverlayWindows(true);
    }

    static void protect(Activity activity) {
        if (activity != null) protect(activity.getWindow());
    }

    /** À appeler après show() : la fenêtre du dialogue existe alors. */
    static <T extends Dialog> T protect(T dialog) {
        if (dialog != null) protect(dialog.getWindow());
        return dialog;
    }
}
