package org.openwlm.dev;

import android.Manifest;
import android.app.Activity;
import android.app.KeyguardManager;
import android.app.NotificationManager;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Base64;
import android.view.WindowManager;
import androidx.activity.result.ActivityResult;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.ref.WeakReference;

/**
 * Pont minimal entre l'interface web et l'app Android. La page chargée vient du serveur :
 * ce plugin n'expose donc rien de sensible (pas d'accès aux fichiers ni aux clés).
 */
@CapacitorPlugin(
    name = "OpenWLMNative",
    permissions = {
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }),
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }),
        @Permission(alias = "camera", strings = { Manifest.permission.CAMERA })
    }
)
public class OpenWLMNativePlugin extends Plugin {

    private static WeakReference<OpenWLMNativePlugin> instance = new WeakReference<>(null);

    @Override
    public void load() {
        instance = new WeakReference<>(this);
        OpenWLMNotifications.ensureChannels(getContext());
        ChunkedFileSaver.cleanTemp(getContext());
    }

    /** Nouveau jeton FCM : l'interface le renvoie au serveur (événement « fcmToken »). */
    static void onFcmTokenRefreshed(String token) {
        OpenWLMNativePlugin plugin = instance.get();
        if (plugin == null) return; // app fermée : le jeton sera lu au prochain démarrage
        JSObject data = new JSObject();
        data.put("token", token);
        plugin.notifyListeners("fcmToken", data, true);
    }

    /**
     * Toucher d'une notification : ouvrir la conversation (événement « openChat », gardé jusqu'à
     * lecture). `answer` : l'utilisateur a choisi « Répondre », l'interface prend l'appel.
     */
    void openChat(int senderId, boolean answer) {
        JSObject data = new JSObject();
        data.put("senderId", senderId);
        data.put("answer", answer);
        notifyListeners("openChat", data, true);
    }

    /** « Raccrocher » dans la notification d'appel en cours (événement « hangUp »). */
    static void onHangUpRequested() {
        OpenWLMNativePlugin plugin = instance.get();
        if (plugin != null) plugin.notifyListeners("hangUp", new JSObject());
    }

    /** L'app affiche son écran de verrouillage (l'interface est derrière). */
    @PluginMethod
    public void isAppLocked(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("locked", MainActivity.isAppLocked());
        call.resolve(ret);
    }

    /** L'interface affiche l'appel de `callerId` : l'écran d'appel natif et sa sonnerie s'arrêtent. */
    @PluginMethod
    public void dismissIncomingCall(PluginCall call) {
        IncomingCallService.stop(getContext(), call.getInt("callerId", 0));
        call.resolve();
    }

    /** Appel établi ou en cours d'établissement : service de premier plan, audio d'appel. */
    @PluginMethod
    public void startOngoingCall(PluginCall call) {
        try {
            OngoingCallService.start(getContext(), call.getString("peerName", "OpenWLM"), Boolean.TRUE.equals(call.getBoolean("video", false)));
            call.resolve();
        } catch (RuntimeException e) {
            call.reject("call_service_unavailable");
        }
    }

    @PluginMethod
    public void updateOngoingCall(PluginCall call) {
        OngoingCallService.update(getContext(), Boolean.TRUE.equals(call.getBoolean("video", false)));
        call.resolve();
    }

    @PluginMethod
    public void stopOngoingCall(PluginCall call) {
        OngoingCallService.stop(getContext());
        call.resolve();
    }

    /** Écran allumé pendant la vidéo (remplace le Screen Wake Lock du navigateur). */
    @PluginMethod
    public void setKeepScreenOn(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
        call.resolve();
    }

    /**
     * Autorisations utiles aux appels : notifications, écran d'appel plein écran (Android 14+ :
     * à accorder dans les réglages), micro, caméra. « granted », « denied » ou « prompt ».
     */
    @PluginMethod
    public void getCallPermissions(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("notifications", notificationPermissionResult().getString("state"));
        ret.put("fullScreen", canUseFullScreen() ? "granted" : "denied");
        ret.put("microphone", permissionString("microphone"));
        ret.put("camera", permissionString("camera"));
        call.resolve(ret);
    }

    /** `kind` : « microphone », « camera » (demande Android) ou « fullScreen » (réglages). */
    @PluginMethod
    public void requestCallPermission(PluginCall call) {
        String kind = call.getString("kind", "");
        if ("fullScreen".equals(kind)) {
            if (Build.VERSION.SDK_INT >= 34 && !canUseFullScreen()) {
                Intent intent = new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + getContext().getPackageName()))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try {
                    getContext().startActivity(intent);
                } catch (RuntimeException e) {
                    openNotificationSettings(call);
                    return;
                }
            }
            call.resolve();
            return;
        }
        if (!"microphone".equals(kind) && !"camera".equals(kind)) {
            call.reject("unknown_permission");
            return;
        }
        PermissionState state = getPermissionState(kind);
        if (state == PermissionState.GRANTED) {
            call.resolve();
            return;
        }
        if (state == PermissionState.DENIED) {
            // Refusée définitivement : Android ne la redemande plus, ouvrir les autorisations de l'app
            getContext().startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            call.resolve();
            return;
        }
        requestPermissionForAlias(kind, call, "onCallPermission");
    }

    @PermissionCallback
    private void onCallPermission(PluginCall call) {
        call.resolve();
    }

    private String permissionString(String alias) {
        PermissionState state = getPermissionState(alias);
        if (state == PermissionState.GRANTED) return "granted";
        if (state == PermissionState.DENIED) return "denied";
        return "prompt";
    }

    private boolean canUseFullScreen() {
        if (Build.VERSION.SDK_INT < 34) return true;
        NotificationManager nm = ContextCompat.getSystemService(getContext(), NotificationManager.class);
        return nm != null && nm.canUseFullScreenIntent();
    }

    private final ChunkedFileSaver saver = new ChunkedFileSaver();

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
        ret.put("push", isFirebaseAvailable());
        call.resolve(ret);
    }

    private boolean isFirebaseAvailable() {
        return !FirebaseApp.getApps(getContext()).isEmpty();
    }

    /** Jeton FCM de cette installation (null si Firebase n'est pas configuré dans l'APK). */
    @PluginMethod
    public void getFcmToken(PluginCall call) {
        if (!isFirebaseAvailable()) {
            JSObject ret = new JSObject();
            ret.put("token", null);
            call.resolve(ret);
            return;
        }
        FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
            if (!task.isSuccessful()) {
                call.reject("fcm_token_unavailable");
                return;
            }
            JSObject ret = new JSObject();
            ret.put("token", task.getResult());
            call.resolve(ret);
        });
    }

    /** « granted », « denied » ou « prompt » (Android 13+ : autorisation pas encore demandée). */
    @PluginMethod
    public void getNotificationPermission(PluginCall call) {
        call.resolve(notificationPermissionResult());
    }

    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "onNotificationPermission");
            return;
        }
        call.resolve(notificationPermissionResult());
    }

    @PermissionCallback
    private void onNotificationPermission(PluginCall call) {
        call.resolve(notificationPermissionResult());
    }

    private JSObject notificationPermissionResult() {
        String state;
        if (NotificationManagerCompat.from(getContext()).areNotificationsEnabled()) {
            state = "granted";
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && getPermissionState("notifications") == PermissionState.PROMPT) {
            state = "prompt";
        } else {
            state = "denied";
        }
        JSObject ret = new JSObject();
        ret.put("state", state);
        return ret;
    }

    /** Réglages Android des notifications de l'app (autorisation refusée définitivement). */
    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName())
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    /** Langue de l'app, pour les textes des notifications. */
    @PluginMethod
    public void setLanguage(PluginCall call) {
        OpenWLMNotifications.setLanguage(getContext(), call.getString("lang"));
        OpenWLMNotifications.ensureChannels(getContext());
        call.resolve();
    }

    /** L'écran de choix du serveur est ouvert (cf. handleOnResume). */
    private boolean serverChangeOpen;

    /**
     * Retour dans l'app sans changement de serveur (annulé, ou même serveur) : l'interface, qui
     * avait retiré le jeton FCM avant d'ouvrir l'écran, le réenregistre (« serverChangeCancelled »).
     * Un vrai changement relance l'app, sans revenir ici.
     */
    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        if (serverChangeOpen) {
            serverChangeOpen = false;
            notifyListeners("serverChangeCancelled", new JSObject());
        }
    }

    /** Ouvre l'écran de choix du serveur. */
    @PluginMethod
    public void changeServer(PluginCall call) {
        serverChangeOpen = true;
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
     * Enregistrement d'un fichier déchiffré par l'interface (la WebView ignore les liens
     * « download » vers un blob), par morceaux : beginSave → appendChunk… → finishSave
     * (ou abortSave). Android 10+ : dossier Téléchargements, sans permission ; Android 8-9 :
     * l'utilisateur choisit l'emplacement à la fin.
     */
    /**
     * Ancienne interface web (avant l'enregistrement par morceaux) : fichier entier en base64.
     * Gardé pour qu'une interface en cache plus ancienne que l'APK fonctionne encore ; taille
     * contrôlée AVANT décodage.
     */
    @PluginMethod
    public void saveFile(PluginCall call) {
        String data = call.getString("data");
        if (data == null || data.length() > (ChunkedFileSaver.MAX_BYTES / 3 + 1) * 4) {
            call.reject(data == null ? "missing_data" : "too_large");
            return;
        }
        String id;
        try {
            id = saver.begin(getContext(), FileNames.sanitize(call.getString("fileName", "fichier")), call.getString("mimeType", "application/octet-stream"));
        } catch (ChunkedFileSaver.TooManyException e) {
            call.reject("too_many_saves");
            return;
        } catch (IOException e) {
            call.reject("save_failed");
            return;
        }
        try {
            saver.append(getContext(), id, Base64.decode(data, Base64.DEFAULT));
        } catch (IllegalArgumentException e) {
            saver.abort(getContext(), id);
            call.reject("invalid_data");
            return;
        } catch (IOException e) {
            call.reject("save_failed");
            return;
        }
        call.getData().put("id", id);
        finishSave(call);
    }

    /** Session révoquée : jeton FCM supprimé chez Firebase (un nouveau sera créé à la connexion). */
    @PluginMethod
    public void resetPushToken(PluginCall call) {
        if (!isFirebaseAvailable()) {
            call.resolve();
            return;
        }
        FirebaseMessaging.getInstance().deleteToken().addOnCompleteListener(task -> call.resolve());
    }

    @PluginMethod
    public void beginSave(PluginCall call) {
        String name = FileNames.sanitize(call.getString("fileName", "fichier"));
        String mime = call.getString("mimeType", "application/octet-stream");
        Long size = call.getLong("size");
        if (size != null && size > ChunkedFileSaver.MAX_BYTES) {
            call.reject("too_large");
            return;
        }
        try {
            JSObject ret = new JSObject();
            ret.put("id", saver.begin(getContext(), name, mime));
            ret.put("maxChunkBytes", ChunkedFileSaver.MAX_CHUNK_BYTES);
            call.resolve(ret);
        } catch (ChunkedFileSaver.TooManyException e) {
            call.reject("too_many_saves");
        } catch (IOException e) {
            call.reject("save_failed");
        }
    }

    @PluginMethod
    public void appendChunk(PluginCall call) {
        String id = call.getString("id");
        String data = call.getString("data");
        // Contrôle avant décodage : un morceau trop gros n'est jamais décodé en mémoire
        if (id == null || data == null || data.length() > (ChunkedFileSaver.MAX_CHUNK_BYTES / 3 + 1) * 4) {
            if (id != null) saver.abort(getContext(), id);
            call.reject("invalid_chunk");
            return;
        }
        byte[] bytes;
        try {
            bytes = Base64.decode(data, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            saver.abort(getContext(), id);
            call.reject("invalid_chunk");
            return;
        }
        try {
            saver.append(getContext(), id, bytes);
            call.resolve();
        } catch (ChunkedFileSaver.TooLargeException e) {
            call.reject("too_large");
        } catch (IOException e) {
            call.reject("save_failed");
        }
    }

    @PluginMethod
    public void finishSave(PluginCall call) {
        ChunkedFileSaver.Session session;
        try {
            session = saver.finish(getContext(), call.getString("id", ""));
        } catch (IOException e) {
            call.reject("save_failed");
            return;
        }
        if (session.uri != null) {
            JSObject ret = new JSObject();
            ret.put("saved", true);
            ret.put("location", "downloads");
            call.resolve(ret);
            return;
        }
        // Android 8-9 : choix de l'emplacement, puis copie du fichier temporaire
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(session.mimeType);
        intent.putExtra(Intent.EXTRA_TITLE, session.fileName);
        pendingTemp = session.temp;
        startActivityForResult(call, intent, "onSaveDocumentResult");
    }

    @PluginMethod
    public void abortSave(PluginCall call) {
        saver.abort(getContext(), call.getString("id", ""));
        call.resolve();
    }

    private File pendingTemp;

    @ActivityCallback
    private void onSaveDocumentResult(PluginCall call, ActivityResult result) {
        File temp = pendingTemp;
        pendingTemp = null;
        if (temp == null || result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            if (temp != null) {
                // noinspection ResultOfMethodCallIgnored
                temp.delete();
            }
            JSObject ret = new JSObject();
            ret.put("saved", false);
            call.resolve(ret);
            return;
        }
        Uri target = result.getData().getData();
        // Copie (jusqu'à 100 Mo) hors du thread d'interface
        new Thread(() -> {
            try (InputStream in = new FileInputStream(temp); OutputStream out = getContext().getContentResolver().openOutputStream(target)) {
                if (out == null) throw new IOException("no_stream");
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
                JSObject ret = new JSObject();
                ret.put("saved", true);
                ret.put("location", "picker");
                call.resolve(ret);
            } catch (IOException e) {
                call.reject("save_failed");
            } finally {
                // noinspection ResultOfMethodCallIgnored
                temp.delete();
            }
        }, "openwlm-save").start();
    }

    @Override
    protected void handleOnDestroy() {
        saver.abortAll(getContext());
        super.handleOnDestroy();
    }
}
