package org.openwlm.dev;

import androidx.annotation.NonNull;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

/**
 * Réception des messages FCM du serveur (messages, appels, fin d'appel), même app fermée ou
 * téléphone en veille. L'enregistrement du jeton auprès du serveur est fait par l'interface
 * web (session du compte connecté) : un nouveau jeton lui est signalé.
 */
public class OpenWLMMessagingService extends FirebaseMessagingService {

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        if (message.getData().isEmpty()) return;
        OpenWLMNotifications.handle(this, message.getData());
    }

    @Override
    public void onNewToken(@NonNull String token) {
        OpenWLMNativePlugin.onFcmTokenRefreshed(token);
    }
}
