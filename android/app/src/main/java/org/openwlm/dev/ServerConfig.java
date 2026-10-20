package org.openwlm.dev;

import android.content.Context;
import android.content.SharedPreferences;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Serveur OpenWLM choisi par l'utilisateur (nom d'hôte, HTTPS uniquement).
 * L'app charge l'interface depuis ce serveur : la session (cookie HttpOnly SameSite=Strict)
 * reste ainsi sur la même origine que l'API, comme dans un navigateur.
 */
final class ServerConfig {

    static final String DEFAULT_HOST = "messenger.guifort.ovh";

    private static final String PREFS = "openwlm_server";
    private static final String KEY_HOST = "host";
    // Nom d'hôte DNS, avec port facultatif. Pas d'IP brute ni de chemin.
    private static final Pattern HOST_PATTERN = Pattern.compile(
        "^(?=.{1,253}(:\\d{1,5})?$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}(:\\d{1,5})?$"
    );

    private ServerConfig() {}

    /** Hôte enregistré, ou null au premier lancement. */
    static String getHost(Context context) {
        return prefs(context).getString(KEY_HOST, null);
    }

    static void setHost(Context context, String host) {
        prefs(context).edit().putString(KEY_HOST, host).apply();
    }

    static String urlFor(String host) {
        return "https://" + host;
    }

    /**
     * Normalise une saisie (« https://exemple.org/ », « Exemple.org ») en nom d'hôte.
     * Renvoie null si la saisie n'est pas un hôte HTTPS valide (http:// refusé).
     */
    static String normalize(String input) {
        if (input == null) return null;
        String s = input.trim().toLowerCase(Locale.ROOT);
        if (s.startsWith("http://")) return null;
        if (s.startsWith("https://")) s = s.substring("https://".length());
        int slash = s.indexOf('/');
        if (slash >= 0) {
            if (!s.substring(slash).matches("/*")) return null;
            s = s.substring(0, slash);
        }
        if (s.endsWith(":443")) s = s.substring(0, s.length() - 4);
        return HOST_PATTERN.matcher(s).matches() ? s : null;
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
