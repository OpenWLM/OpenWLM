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
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.splashscreen.SplashScreen;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/**
 * Point d'entrée de l'app : choix du serveur OpenWLM au premier lancement, ou à la demande
 * (EXTRA_EDIT, depuis les Options ou la page hors ligne). Si un serveur est déjà enregistré,
 * ouvre directement l'app.
 */
public class ServerActivity extends AppCompatActivity {

    static final String EXTRA_EDIT = "org.openwlm.dev.EDIT_SERVER";

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
        boolean edit = getIntent().getBooleanExtra(EXTRA_EDIT, false);
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
                boolean changed = !host.equals(ServerConfig.getHost(this));
                ServerConfig.setHost(this, host);
                if (!changed && getIntent().getBooleanExtra(EXTRA_EDIT, false)) {
                    finish();
                    return;
                }
                openApp(changed);
            });
        });
    }

    /** Vérifie que l'hôte répond comme un serveur OpenWLM (GET /api/push/status, public). */
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

    private void openApp(boolean restart) {
        Intent intent = new Intent(this, MainActivity.class);
        if (getIntent().getData() != null) intent.setData(getIntent().getData());
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
