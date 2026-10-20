package org.openwlm.dev;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.OutputStream;

/**
 * Pont minimal entre l'interface web et l'app Android. La page chargée vient du serveur :
 * ce plugin n'expose donc rien de sensible (pas d'accès aux fichiers ni aux clés).
 */
@CapacitorPlugin(name = "OpenWLMNative")
public class OpenWLMNativePlugin extends Plugin {

    /** Taille maximale d'un fichier enregistré (données base64 décodées). */
    private static final int MAX_SAVE_BYTES = 100 * 1024 * 1024;

    @PluginMethod
    public void getInfo(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("server", ServerConfig.getHost(getContext()));
        ret.put("defaultServer", ServerConfig.DEFAULT_HOST);
        try {
            PackageInfo info = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            ret.put("versionName", info.versionName);
            ret.put("versionCode", Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? info.getLongVersionCode() : info.versionCode);
        } catch (Exception ignored) {
            // Infos de version facultatives
        }
        KeyguardManager km = ContextCompat.getSystemService(getContext(), KeyguardManager.class);
        ret.put("appLock", km != null && km.isDeviceSecure());
        call.resolve(ret);
    }

    /** Ouvre l'écran de choix du serveur. */
    @PluginMethod
    public void changeServer(PluginCall call) {
        Intent intent = new Intent(getContext(), ServerActivity.class);
        intent.putExtra(ServerActivity.EXTRA_EDIT, true);
        getActivity().startActivity(intent);
        call.resolve();
    }

    /** Recharge l'app depuis le serveur (bouton « Réessayer » de la page hors ligne). */
    @PluginMethod
    public void retry(PluginCall call) {
        String host = ServerConfig.getHost(getContext());
        String url = ServerConfig.urlFor(host != null ? host : ServerConfig.DEFAULT_HOST) + "/";
        getActivity().runOnUiThread(() -> bridge.getWebView().loadUrl(url));
        call.resolve();
    }

    /**
     * Enregistre un fichier déchiffré par l'interface (la WebView ignore les liens
     * « download » vers un blob). Android 10+ : dossier Téléchargements, sans permission ;
     * avant : l'utilisateur choisit l'emplacement.
     */
    @PluginMethod
    public void saveFile(PluginCall call) {
        String name = sanitizeFileName(call.getString("fileName", "fichier"));
        String mime = call.getString("mimeType", "application/octet-stream");
        String data = call.getString("data");
        if (data == null) {
            call.reject("missing_data");
            return;
        }
        byte[] bytes;
        try {
            bytes = Base64.decode(data, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            call.reject("invalid_data");
            return;
        }
        if (bytes.length > MAX_SAVE_BYTES) {
            call.reject("too_large");
            return;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentResolver resolver = getContext().getContentResolver();
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, name);
            values.put(MediaStore.Downloads.MIME_TYPE, mime);
            values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
            values.put(MediaStore.Downloads.IS_PENDING, 1);
            Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) {
                call.reject("save_failed");
                return;
            }
            try (OutputStream out = resolver.openOutputStream(uri)) {
                if (out == null) throw new IllegalStateException("no stream");
                out.write(bytes);
            } catch (Exception e) {
                resolver.delete(uri, null, null);
                call.reject("save_failed");
                return;
            }
            values.clear();
            values.put(MediaStore.Downloads.IS_PENDING, 0);
            resolver.update(uri, values, null, null);
            JSObject ret = new JSObject();
            ret.put("saved", true);
            ret.put("location", "downloads");
            call.resolve(ret);
            return;
        }

        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mime);
        intent.putExtra(Intent.EXTRA_TITLE, name);
        pendingBytes = bytes;
        startActivityForResult(call, intent, "onSaveDocumentResult");
    }

    private byte[] pendingBytes;

    @ActivityCallback
    private void onSaveDocumentResult(PluginCall call, ActivityResult result) {
        byte[] bytes = pendingBytes;
        pendingBytes = null;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null || bytes == null) {
            JSObject ret = new JSObject();
            ret.put("saved", false);
            call.resolve(ret);
            return;
        }
        try (OutputStream out = getContext().getContentResolver().openOutputStream(result.getData().getData())) {
            if (out == null) throw new IllegalStateException("no stream");
            out.write(bytes);
            JSObject ret = new JSObject();
            ret.put("saved", true);
            ret.put("location", "picker");
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("save_failed");
        }
    }

    private static String sanitizeFileName(String name) {
        String s = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (s.isEmpty() || s.equals(".") || s.equals("..")) s = "fichier";
        return s.length() > 120 ? s.substring(0, 120) : s;
    }
}
