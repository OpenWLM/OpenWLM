package org.openwlm.dev;

import android.app.KeyguardManager;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.annotation.NonNull;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.CapConfig;
import com.getcapacitor.PluginHandle;
import com.getcapacitor.WebViewListener;

/**
 * Coquille native d'OpenWLM : charge l'interface depuis le serveur choisi (ServerConfig),
 * et la protège par le verrouillage du téléphone (empreinte, visage ou code).
 */
public class MainActivity extends BridgeActivity {

    /** Durée en arrière-plan au-delà de laquelle l'app redemande le déverrouillage. */
    private static final long RELOCK_AFTER_MS = 60_000;

    /** App à l'écran et déverrouillée : c'est alors l'interface qui affiche les alertes. */
    private static volatile boolean userVisible;
    /** URL de la page chargée (contrôle d'origine du pont natif, cf. BridgeTrust). */
    private static volatile String currentPageUrl;
    /** Micro / caméra permis jusqu'à cet instant (elapsedRealtime) après « Répondre ». */
    private static volatile long mediaAllowedUntil;

    private boolean started;
    /** Déverrouillage de l'app inutile jusqu'à cet instant (cf. handleChatIntent). */
    private long skipLockUntil;
    private View lockOverlay;
    private BiometricPrompt biometricPrompt;
    private boolean locked;
    private boolean authInProgress;
    private long backgroundSince;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        String host = ServerConfig.getHost(this);
        if (host == null) {
            host = ServerConfig.DEFAULT_HOST;
            ServerConfig.setHost(this, host);
        }
        registerPlugin(OpenWLMNativePlugin.class);
        config = new CapConfig.Builder(this)
            .setServerUrl(ServerConfig.urlFor(host))
            .setHostname(host)
            .setAndroidScheme("https")
            .setAllowNavigation(new String[] { host })
            .setErrorPath("offline.html")
            .setAllowMixedContent(false)
            .setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
            .setLoggingEnabled(BuildConfig.DEBUG)
            .create();
        super.onCreate(savedInstanceState);

        WebView webView = bridge.getWebView();
        webView.getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        webView.getSettings().setAllowFileAccess(false);
        webView.getSettings().setAllowContentAccess(false);
        // Micro / caméra filtrés (origine, app visible ou appel en cours) avant Capacitor ;
        // installé dans onCreate (BridgeWebChromeClient enregistre des lanceurs d'activité)
        webView.setWebChromeClient(new GuardedWebChromeClient(bridge));
        // Fichiers du téléphone servis par le serveur local de Capacitor : refusés (cf. BridgeTrust)
        bridge.setWebViewClient(new GuardedWebViewClient(bridge));
        // Origine de la page suivie pour le pont natif (cf. OpenWLMNativePlugin)
        bridge.addWebViewListener(new WebViewListener() {
            @Override
            public void onPageStarted(WebView view) {
                currentPageUrl = view.getUrl();
            }

            @Override
            public void onPageCommitVisible(WebView view, String url) {
                currentPageUrl = url;
            }

            @Override
            public void onPageLoaded(WebView view) {
                currentPageUrl = view.getUrl();
            }
        });
        currentPageUrl = webView.getUrl();

        // Pas d'aperçu de la conversation dans l'écran des applications récentes
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            setRecentsScreenshotEnabled(false);
        }

        // Retour : revenir en arrière dans l'app si possible, sinon la passer en arrière-plan
        // (sans la fermer, pour garder la connexion temps réel).
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView wv = bridge != null ? bridge.getWebView() : null;
                if (!locked && wv != null && wv.canGoBack()) {
                    wv.goBack();
                } else {
                    moveTaskToBack(true);
                }
            }
        });

        biometricPrompt = new BiometricPrompt(this, ContextCompat.getMainExecutor(this), new BiometricPrompt.AuthenticationCallback() {
            @Override
            public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
                authInProgress = false;
                unlock();
            }

            @Override
            public void onAuthenticationError(int errorCode, @NonNull CharSequence errString) {
                // Annulé ou trop d'essais : l'écran reste verrouillé, bouton « Déverrouiller » pour réessayer.
                authInProgress = false;
            }
        });

        if (isDeviceSecure()) lock();
        handleChatIntent(getIntent());
    }

    static boolean isUserVisible() {
        return userVisible;
    }

    static String currentPageUrl() {
        return currentPageUrl;
    }

    static long mediaAllowedUntil() {
        return mediaAllowedUntil;
    }

    /** Écran de verrouillage de l'app affiché. */
    private static volatile boolean appLocked;

    static boolean isAppLocked() {
        return appLocked;
    }

    private void updateVisibility() {
        userVisible = started && !locked;
        appLocked = locked;
        updateSecureFlag();
    }

    /**
     * Contenu masqué (captures d'écran, aperçu des applications récentes) quand l'app est
     * verrouillée, et en arrière-plan sur Android < 13 (setRecentsScreenshotEnabled n'existe
     * pas). App ouverte et déverrouillée : captures permises (partage d'écran en appel).
     */
    private boolean paused;

    private void updateSecureFlag() {
        boolean secure = locked || (paused && Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU);
        if (secure) getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
    }

    @Override
    public void onPause() {
        paused = true;
        updateSecureFlag();
        super.onPause();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleChatIntent(intent);
    }

    /** Notification touchée : ouvrir la conversation de l'expéditeur (et prendre son appel : « Répondre »). */
    private void handleChatIntent(Intent intent) {
        int chatId = intent != null ? intent.getIntExtra(OpenWLMNotifications.EXTRA_CHAT_ID, 0) : 0;
        if (chatId <= 0 || bridge == null) return;
        boolean answer = intent.getBooleanExtra(OpenWLMNotifications.EXTRA_ANSWER, false);
        intent.removeExtra(OpenWLMNotifications.EXTRA_CHAT_ID);
        intent.removeExtra(OpenWLMNotifications.EXTRA_ANSWER);
        if (answer) {
            // Micro / caméra permis le temps de décrocher, même derrière l'écran de verrouillage
            mediaAllowedUntil = SystemClock.elapsedRealtime() + BridgeTrust.ANSWER_MEDIA_GRACE_MS;
            // Téléphone verrouillé par code pendant la sonnerie, déverrouillé par son propriétaire
            // pour répondre à CET appel : pas de second déverrouillage de l'app (AppLockPolicy)
            if (IncomingCallService.consumeAnswerUnlock(this, chatId)) {
                skipLockUntil = SystemClock.elapsedRealtime() + AppLockPolicy.SKIP_LOCK_MS;
                if (locked) unlock();
            }
            IncomingCallService.stop(this, chatId);
        }
        PluginHandle handle = bridge.getPlugin("OpenWLMNative");
        if (handle != null && handle.getInstance() instanceof OpenWLMNativePlugin) {
            ((OpenWLMNativePlugin) handle.getInstance()).openChat(chatId, answer);
        }
    }

    @Override
    public void onStart() {
        super.onStart();
        started = true;
        if (!locked && backgroundSince > 0 && SystemClock.elapsedRealtime() - backgroundSince >= RELOCK_AFTER_MS && isDeviceSecure()) {
            lock();
        }
        backgroundSince = 0;
        updateVisibility();
    }

    @Override
    public void onResume() {
        super.onResume();
        paused = false;
        updateSecureFlag();
        if (locked && !authInProgress) authenticate();
    }

    @Override
    public void onStop() {
        super.onStop();
        started = false;
        updateVisibility();
        // La saisie du code du téléphone ouvre un écran système : ce n'est pas une sortie de l'app.
        if (!authInProgress && !isChangingConfigurations()) {
            backgroundSince = SystemClock.elapsedRealtime();
        }
    }

    private boolean isDeviceSecure() {
        KeyguardManager km = ContextCompat.getSystemService(this, KeyguardManager.class);
        return km != null && km.isDeviceSecure();
    }

    private void lock() {
        if (SystemClock.elapsedRealtime() < skipLockUntil) return;
        locked = true;
        if (lockOverlay == null) {
            lockOverlay = LayoutInflater.from(this).inflate(R.layout.lock_overlay, null);
            lockOverlay.findViewById(R.id.lock_unlock).setOnClickListener(v -> authenticate());
            addContentView(lockOverlay, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        }
        lockOverlay.setVisibility(View.VISIBLE);
        lockOverlay.bringToFront();
        // L'écran de verrouillage bloque les touches, mais la WebView restait focalisable (un
        // clavier physique tapait dans le champ de saisie caché) et lisible par les services
        // d'accessibilité (TalkBack, ou une app malveillante disposant de ce droit)
        WebView wv = bridge != null ? bridge.getWebView() : null;
        if (wv != null) {
            wv.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
            wv.clearFocus();
            wv.setFocusable(false);
        }
        lockOverlay.requestFocus();
        updateVisibility();
    }

    private void unlock() {
        locked = false;
        if (lockOverlay != null) lockOverlay.setVisibility(View.GONE);
        WebView wv = bridge != null ? bridge.getWebView() : null;
        if (wv != null) {
            wv.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_AUTO);
            wv.setFocusable(true);
            wv.setFocusableInTouchMode(true);
        }
        updateVisibility();
    }

    private void authenticate() {
        if (authInProgress) return;
        int authenticators = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
            ? BiometricManager.Authenticators.BIOMETRIC_STRONG | BiometricManager.Authenticators.DEVICE_CREDENTIAL
            : BiometricManager.Authenticators.BIOMETRIC_WEAK | BiometricManager.Authenticators.DEVICE_CREDENTIAL;
        if (!isDeviceSecure()) {
            // Plus aucun verrouillage configuré sur le téléphone : rien pour vérifier l'identité.
            unlock();
            return;
        }
        BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
            .setTitle(getString(R.string.lock_prompt_title))
            .setSubtitle(getString(R.string.lock_prompt_subtitle))
            .setAllowedAuthenticators(authenticators)
            .build();
        authInProgress = true;
        biometricPrompt.authenticate(info);
    }
}
