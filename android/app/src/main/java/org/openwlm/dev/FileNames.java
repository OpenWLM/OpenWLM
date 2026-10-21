package org.openwlm.dev;

/** Nom d'un fichier enregistré (sans dépendance Android, testé : FileNamesTest). */
final class FileNames {

    static final int MAX_LENGTH = 120;

    private FileNames() {}

    /**
     * Retire les séparateurs et caractères interdits, de contrôle, et invisibles ou
     * bidirectionnels (U+202E…) qui permettraient un nom trompeur (« facture » + U+202E +
     * « gnp.exe » s'affiche « factureexe.png »).
     */
    static String sanitize(String name) {
        String s = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}\\p{Cf}]", "_").trim();
        if (s.isEmpty() || s.equals(".") || s.equals("..")) s = "fichier";
        return s.length() > MAX_LENGTH ? s.substring(0, MAX_LENGTH) : s;
    }
}
