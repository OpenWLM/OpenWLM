package org.openwlm.dev;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class BridgeTrustTest {

    private static final String HOST = "messenger.example.org";

    @Test
    public void pageDuServeurChoisi() {
        assertTrue(BridgeTrust.isTrustedPage("https://messenger.example.org/", HOST));
        assertTrue(BridgeTrust.isTrustedPage("https://MESSENGER.example.org/?chat=3", HOST));
        assertTrue(BridgeTrust.isTrustedPage("https://messenger.example.org:443/offline.html", HOST));
        assertTrue(BridgeTrust.isTrustedPage("https://local.test:8443/", "local.test:8443"));
    }

    @Test
    public void autresOriginesRefusees() {
        assertFalse(BridgeTrust.isTrustedPage("http://messenger.example.org/", HOST));
        assertFalse(BridgeTrust.isTrustedPage("https://messenger.example.org.evil.test/", HOST));
        assertFalse(BridgeTrust.isTrustedPage("https://evil.test/?u=https://messenger.example.org/", HOST));
        assertFalse(BridgeTrust.isTrustedPage("https://messenger.example.org:8443/", HOST));
        assertFalse(BridgeTrust.isTrustedPage("about:blank", HOST));
        assertFalse(BridgeTrust.isTrustedPage(null, HOST));
        assertFalse(BridgeTrust.isTrustedPage("https://messenger.example.org/", null));
    }

    @Test
    public void microCameraSelonEtatDeLApp() {
        String origin = "https://messenger.example.org/";
        // App visible et déverrouillée
        assertTrue(BridgeTrust.allowMediaCapture(origin, HOST, true, false, 0, 0));
        // Appel en cours (arrière-plan ou écran éteint)
        assertTrue(BridgeTrust.allowMediaCapture(origin, HOST, false, true, 0, 0));
        // Juste après « Répondre », app encore verrouillée
        assertTrue(BridgeTrust.allowMediaCapture(origin, HOST, false, false, 1_000, 61_000));
        // Arrière-plan / verrouillée, sans appel
        assertFalse(BridgeTrust.allowMediaCapture(origin, HOST, false, false, 70_000, 61_000));
        // Mauvaise origine, même app visible
        assertFalse(BridgeTrust.allowMediaCapture("https://evil.test/", HOST, true, true, 0, 0));
    }

    @Test
    public void cheminsLocauxCapacitorRefuses() {
        assertTrue(BridgeTrust.isForbiddenLocalPath("/_capacitor_file_/data/data/org.openwlm.dev/app_webview/Default/Cookies"));
        assertTrue(BridgeTrust.isForbiddenLocalPath("/_CAPACITOR_FILE_/sdcard/x"));
        assertTrue(BridgeTrust.isForbiddenLocalPath("/_capacitor_content_/content://media/external/images/1"));
        assertFalse(BridgeTrust.isForbiddenLocalPath("/"));
        assertFalse(BridgeTrust.isForbiddenLocalPath("/api/user/me"));
        assertFalse(BridgeTrust.isForbiddenLocalPath("/assets/_capacitor_file_.png"));
        assertFalse(BridgeTrust.isForbiddenLocalPath(null));
    }

    @Test
    public void cheminsLocauxNormalisesAvantComparaison() {
        assertTrue(BridgeTrust.isForbiddenLocalPath("/foo/../_capacitor_file_/data/x"));
        assertTrue(BridgeTrust.isForbiddenLocalPath("//_capacitor_file_/data/x"));
        assertTrue(BridgeTrust.isForbiddenLocalPath("/./_capacitor_content_/x"));
        assertTrue(BridgeTrust.isForbiddenLocalPath("/%2e%2e/_capacitor_file_/x"));
        assertTrue(BridgeTrust.isForbiddenLocalPath("/a/%252e%252e/_capacitor_file_/x"));
        assertTrue(BridgeTrust.isForbiddenLocalPath("/%5f%63apacitor_file_/x"));
        assertTrue(BridgeTrust.isForbiddenLocalPath("\\_capacitor_file_\\x"));
        assertFalse(BridgeTrust.isForbiddenLocalPath("/assets/../index.html"));
        assertFalse(BridgeTrust.isForbiddenLocalPath("/api/files/download/abc"));
    }
}
