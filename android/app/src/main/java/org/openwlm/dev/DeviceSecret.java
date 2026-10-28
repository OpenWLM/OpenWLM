package org.openwlm.dev;

import android.app.KeyguardManager;
import android.content.Context;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.security.keystore.UserNotAuthenticatedException;
import androidx.core.content.ContextCompat;
import java.io.IOException;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.security.SecureRandom;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Secret de verrouillage des clés (étape 4, APK v11+, cf. src/utils/DeviceLock.ts).
 *
 * L'interface scelle la clé privée E2EE avec un secret aléatoire de 32 octets. Ce secret est
 * lui-même chiffré par une clé AES-256-GCM du Keystore Android (matérielle quand le téléphone
 * en a une) qui exige une AUTHENTIFICATION DE L'UTILISATEUR récente (empreinte, visage ou code,
 * dans les AUTH_VALID_S dernières secondes) : sans le propriétaire du téléphone, le secret est
 * illisible, et donc la clé privée aussi. La suppression du verrouillage d'écran invalide la clé
 * du Keystore : il faut alors se reconnecter avec le mot de passe.
 *
 * La clé est liée au DÉLAI (et non à chaque opération) pour que le déverrouillage de l'app
 * (MainActivity, empreinte ou code) suffise aussi au Keystore : une seule demande à l'ouverture.
 */
final class DeviceSecret {

    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String ALIAS = "openwlm_device_secret_v1";
    private static final int GCM_IV_BYTES = 12;
    private static final int GCM_TAG_BITS = 128;
    private static final int SECRET_BYTES = 32;
    /** Authentification valable pour le Keystore (secondes) : le temps que la page se charge. */
    static final int AUTH_VALID_S = 30;

    private DeviceSecret() {}

    /** Un verrouillage d'écran est configuré : le Keystore peut exiger l'utilisateur. */
    static boolean isAvailable(Context context) {
        KeyguardManager km = ContextCompat.getSystemService(context, KeyguardManager.class);
        return km != null && km.isDeviceSecure();
    }

    private static KeyStore keyStore() throws GeneralSecurityException, IOException {
        KeyStore ks = KeyStore.getInstance(KEYSTORE);
        ks.load(null);
        return ks;
    }

    private static SecretKey getOrCreateKey() throws GeneralSecurityException, IOException {
        KeyStore ks = keyStore();
        if (ks.containsAlias(ALIAS)) {
            KeyStore.Entry entry = ks.getEntry(ALIAS, null);
            if (entry instanceof KeyStore.SecretKeyEntry) return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
            ks.deleteEntry(ALIAS);
        }
        KeyGenParameterSpec.Builder builder = new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
            .setUserAuthenticationRequired(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            builder.setUserAuthenticationParameters(AUTH_VALID_S, KeyProperties.AUTH_BIOMETRIC_STRONG | KeyProperties.AUTH_DEVICE_CREDENTIAL);
        } else {
            builder.setUserAuthenticationValidityDurationSeconds(AUTH_VALID_S);
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        generator.init(builder.build());
        return generator.generateKey();
    }

    /** Clé invalidée (verrouillage d'écran retiré…) : supprimée, une nouvelle sera créée. */
    static void deleteKey() {
        try {
            keyStore().deleteEntry(ALIAS);
        } catch (GeneralSecurityException | IOException ignored) {
            // Rien à supprimer
        }
    }

    static byte[] newSecret() {
        byte[] secret = new byte[SECRET_BYTES];
        new SecureRandom().nextBytes(secret);
        return secret;
    }

    /**
     * Chiffre le secret : IV (12 octets) + texte chiffré + étiquette. Lève
     * UserNotAuthenticatedException si l'utilisateur ne s'est pas authentifié récemment.
     */
    static byte[] seal(byte[] secret) throws GeneralSecurityException, IOException {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
        byte[] iv = cipher.getIV();
        byte[] encrypted = cipher.doFinal(secret);
        byte[] out = new byte[iv.length + encrypted.length];
        System.arraycopy(iv, 0, out, 0, iv.length);
        System.arraycopy(encrypted, 0, out, iv.length, encrypted.length);
        return out;
    }

    /** Déchiffre un scellé produit par seal(). Lève UserNotAuthenticatedException si besoin. */
    static byte[] open(byte[] blob) throws GeneralSecurityException, IOException {
        if (blob == null || blob.length <= GCM_IV_BYTES) throw new GeneralSecurityException("blob");
        KeyStore ks = keyStore();
        KeyStore.Entry entry = ks.containsAlias(ALIAS) ? ks.getEntry(ALIAS, null) : null;
        if (!(entry instanceof KeyStore.SecretKeyEntry)) throw new KeyPermanentlyInvalidatedException();
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        byte[] iv = new byte[GCM_IV_BYTES];
        System.arraycopy(blob, 0, iv, 0, GCM_IV_BYTES);
        cipher.init(Cipher.DECRYPT_MODE, ((KeyStore.SecretKeyEntry) entry).getSecretKey(), new GCMParameterSpec(GCM_TAG_BITS, iv));
        return cipher.doFinal(blob, GCM_IV_BYTES, blob.length - GCM_IV_BYTES);
    }

    /** L'erreur demande une authentification de l'utilisateur (et non une clé invalide). */
    static boolean needsAuthentication(Throwable t) {
        return t instanceof UserNotAuthenticatedException;
    }

    static boolean isInvalidated(Throwable t) {
        return t instanceof KeyPermanentlyInvalidatedException;
    }
}
