package org.openwlm.dev;

import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.KeyEvent;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ProgressBar;
import android.widget.TextView;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.splashscreen.SplashScreen;
import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/**
 * Point d'entrée de l'app : choix du serveur OpenWLM au premier lancement, ou à la demande
 * (ServerSettingsActivity, non exportée : depuis les Options ou la page hors ligne). Si un
 * serveur est déjà enregistré,
 * ouvre directement l'app.
 */
public class ServerActivity extends AppCompatActivity {

    /**
     * Changement de serveur (et non premier choix). Faux ici : cette activité est le lanceur,
     * exportée, et une autre application ne doit pas pouvoir ouvrir l'écran de changement de
     * serveur (hameçonnage). Vrai dans ServerSettingsActivity, non exportée.
     */
    protected boolean isEditMode() {
        return false;
    }

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());

    private EditText input;
    private Button connect;
    private ProgressBar progress;
    private TextView error;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        SplashScreen.installSplashScreen(this);
        super.onCreate(savedInstanceState);
        boolean edit = isEditMode();
        String saved = ServerConfig.getHost(this);
        if (saved != null && !edit) {
            openApp(false);
            return;
        }

        setContentView(R.layout.activity_server);
        input = findViewById(R.id.server_input);
        connect = findViewById(R.id.server_connect);
        progress = findViewById(R.id.server_progress);
        error = findViewById(R.id.server_error);
        Button cancel = findViewById(R.id.server_cancel);

        input.setText(saved != null ? saved : ServerConfig.DEFAULT_HOST);
        input.setOnEditorActionListener((v, actionId, event) -> {
            if (actionId == EditorInfo.IME_ACTION_GO || (event != null && event.getKeyCode() == KeyEvent.KEYCODE_ENTER)) {
                submit();
                return true;
            }
            return false;
        });
        connect.setOnClickListener(v -> submit());
        findViewById(R.id.server_default).setOnClickListener(v -> input.setText(ServerConfig.DEFAULT_HOST));
        if (saved != null) {
            cancel.setVisibility(View.VISIBLE);
            cancel.setOnClickListener(v -> finish());
        }
    }

    private void submit() {
        String host = ServerConfig.normalize(input.getText().toString());
        if (host == null) {
            showError(getString(R.string.server_error_invalid));
            return;
        }
        setBusy(true);
        executor.execute(() -> {
            boolean ok = isOpenWlmServer(host);
            main.post(() -> {
                if (isFinishing()) return;
                setBusy(false);
                if (!ok) {
                    showError(getString(R.string.server_error_unreachable, host));
                    return;
                }
                String previous = ServerConfig.getHost(this);
                // Autre serveur que celui par défaut, choisi pour la première fois : rien ne prouve
                // qui l'exploite, l'utilisateur doit confirmer qu'il lui fait confiance
                if (!host.equals(ServerConfig.DEFAULT_HOST) && !host.equals(previous)) {
                    new AlertDialog.Builder(this)
                        .setTitle(R.string.server_trust_title)
                        .setMessage(getString(R.string.server_trust_message, host))
                        .setPositiveButton(R.string.server_trust_confirm, (d, w) -> applyServer(host, previous))
                        .setNegativeButton(R.string.server_cancel, null)
                        .show();
                    return;
                }
                applyServer(host, previous);
            });
        });
    }

    private void applyServer(String host, String previous) {
        boolean changed = !host.equals(previous);
        ServerConfig.setHost(this, host);
        if (!changed && isEditMode()) {
            finish();
            return;
        }
        if (changed && previous != null) {
            leavePreviousServer(() -> openApp(true));
            return;
        }
        openApp(changed);
    }

    /**
     * Vérifie seulement que l'hôte répond comme un serveur OpenWLM (GET /api/push/status,
     * public). Ce n'est PAS une authentification : n'importe quel serveur HTTPS peut imiter
     * cette réponse. D'où l'avertissement et la confirmation pour un serveur autre que celui
     * par défaut (le serveur choisi affiche l'interface, reçoit l'identifiant et la clé de
     * connexion, et accède au pont natif).
     */
    private static boolean isOpenWlmServer(String host) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(ServerConfig.urlFor(host) + "/api/push/status").openConnection();
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(10000);
            conn.setInstanceFollowRedirects(false);
            conn.setRequestProperty("Accept", "application/json");
            if (conn.getResponseCode() != 200) return false;
            try (InputStream in = conn.getInputStream()) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[4096];
                int n;
                while ((n = in.read(buf)) != -1 && out.size() < 16384) out.write(buf, 0, n);
                JSONObject json = new JSONObject(out.toString(StandardCharsets.UTF_8.name()));
                return json.has("available") && json.has("hasVapid");
            }
        } catch (Exception e) {
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /**
     * Changement de serveur : plus rien de l'ancien ne doit arriver sur ce téléphone. Les
     * identifiants de contacts n'ont pas le même sens d'un serveur à l'autre (une notification
     * de l'ancien ouvrirait le mauvais contact sur le nouveau, « Refuser » y refuserait l'appel
     * d'un autre). L'interface a déjà retiré le jeton du compte sur l'ancien serveur ; on le
     * supprime aussi chez Firebase pour qu'il ne serve plus même si ce retrait a échoué (hors
     * ligne). Un nouveau jeton est obtenu et enregistré au prochain démarrage.
     */
    private void leavePreviousServer(Runnable then) {
        IncomingCallService.stop(this, 0);
        OngoingCallService.stop(this);
        NotificationManagerCompat.from(this).cancelAll();
        AtomicBoolean done = new AtomicBoolean(false);
        Runnable once = () -> {
            if (done.compareAndSet(false, true) && !isFinishing()) then.run();
        };
        if (FirebaseApp.getApps(this).isEmpty()) {
            once.run();
            return;
        }
        setBusy(true);
        FirebaseMessaging.getInstance().deleteToken().addOnCompleteListener(task -> main.post(once));
        main.postDelayed(once, 5_000);
    }

    private void openApp(boolean restart) {
        Intent intent = new Intent(this, MainActivity.class);
        if (restart) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        startActivity(intent);
        finish();
        overridePendingTransition(0, 0);
    }

    private void setBusy(boolean busy) {
        progress.setVisibility(busy ? View.VISIBLE : View.GONE);
        connect.setEnabled(!busy);
        input.setEnabled(!busy);
        if (busy) error.setVisibility(View.GONE);
    }

    private void showError(String message) {
        error.setText(message);
        error.setVisibility(View.VISIBLE);
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        executor.shutdownNow();
    }
}
