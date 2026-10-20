package org.openwlm.dev;

import android.app.KeyguardManager;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
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

/**
 * Coquille native d'OpenWLM : charge l'interface depuis le serveur choisi (ServerConfig),
 * et la protège par le verrouillage du téléphone (empreinte, visage ou code).
 */
public class MainActivity extends BridgeActivity {

    /** Durée en arrière-plan au-delà de laquelle l'app redemande le déverrouillage. */
    private static final long RELOCK_AFTER_MS = 60_000;

    /** App à l'écran et déverrouillée : c'est alors l'interface qui affiche les alertes. */
    private static volatile boolean userVisible;

    private boolean started;
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

    private void updateVisibility() {
        userVisible = started && !locked;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleChatIntent(intent);
    }

    /** Notification touchée : ouvrir la conversation de l'expéditeur. */
    private void handleChatIntent(Intent intent) {
        int chatId = intent != null ? intent.getIntExtra(OpenWLMNotifications.EXTRA_CHAT_ID, 0) : 0;
        if (chatId <= 0 || bridge == null) return;
        intent.removeExtra(OpenWLMNotifications.EXTRA_CHAT_ID);
        PluginHandle handle = bridge.getPlugin("OpenWLMNative");
        if (handle != null && handle.getInstance() instanceof OpenWLMNativePlugin) {
            ((OpenWLMNativePlugin) handle.getInstance()).openChat(chatId);
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
        locked = true;
        if (lockOverlay == null) {
            lockOverlay = LayoutInflater.from(this).inflate(R.layout.lock_overlay, null);
            lockOverlay.findViewById(R.id.lock_unlock).setOnClickListener(v -> authenticate());
            addContentView(lockOverlay, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        }
        lockOverlay.setVisibility(View.VISIBLE);
        lockOverlay.bringToFront();
        updateVisibility();
    }

    private void unlock() {
        locked = false;
        if (lockOverlay != null) lockOverlay.setVisibility(View.GONE);
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
