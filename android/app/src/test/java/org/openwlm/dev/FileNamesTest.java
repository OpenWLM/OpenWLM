package org.openwlm.dev;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class FileNamesTest {

    @Test
    public void caracteresBidirectionnelsEtInvisiblesRetires() {
        assertEquals("facture_gnp.exe", FileNames.sanitize("facture" + (char) 0x202E + "gnp.exe"));
        assertEquals("a_b", FileNames.sanitize("a" + (char) 0x200B + "b"));
    }

    @Test
    public void cheminsEtCaracteresInterdits() {
        assertEquals(".._.._etc_passwd", FileNames.sanitize("../../etc/passwd"));
        assertEquals("a_b_c", FileNames.sanitize("a\\b:c"));
        assertEquals("ligne_2", FileNames.sanitize("ligne\n2"));
    }

    @Test
    public void nomVideOuLong() {
        assertEquals("fichier", FileNames.sanitize(null));
        assertEquals("fichier", FileNames.sanitize("  "));
        assertEquals("fichier", FileNames.sanitize(".."));
        assertEquals(FileNames.MAX_LENGTH, FileNames.sanitize("x".repeat(500)).length());
        assertEquals("photo été.jpg", FileNames.sanitize("photo été.jpg"));
    }
}
