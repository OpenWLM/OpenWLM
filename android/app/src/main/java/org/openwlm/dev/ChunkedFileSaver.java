package org.openwlm.dev;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Enregistrement d'un fichier reçu par morceaux (quelques Mo à la fois) : un fichier de
 * 100 Mo ne transite jamais en entier par le pont JS ↔ Java ni en mémoire.
 *
 * Android 10+ : écrit directement dans Téléchargements (MediaStore), marqué « en cours »
 * (IS_PENDING) jusqu'à la fin ; supprimé en cas d'échec ou d'abandon. Android 8-9 : écrit dans
 * un fichier temporaire du cache de l'app, copié ensuite à l'emplacement choisi par
 * l'utilisateur.
 */
final class ChunkedFileSaver {

    /** Taille maximale d'un fichier enregistré (celle des fichiers acceptés par le serveur). */
    static final long MAX_BYTES = 100L * 1024 * 1024;
    /** Taille maximale d'un morceau (données décodées). */
    static final int MAX_CHUNK_BYTES = 4 * 1024 * 1024;
    private static final String TEMP_DIR = "pending-saves";

    static final class Session {
        final String fileName;
        final String mimeType;
        final Uri uri;
        final File temp;
        OutputStream out;
        long written;

        Session(String fileName, String mimeType, Uri uri, File temp, OutputStream out) {
            this.fileName = fileName;
            this.mimeType = mimeType;
            this.uri = uri;
            this.temp = temp;
            this.out = out;
        }
    }

    static final class TooLargeException extends IOException {
        TooLargeException() {
            super("too_large");
        }
    }

    private final Map<String, Session> sessions = new ConcurrentHashMap<>();

    /** Fichiers temporaires laissés par un enregistrement interrompu (app tuée). */
    static void cleanTemp(Context context) {
        File[] files = new File(context.getCacheDir(), TEMP_DIR).listFiles();
        if (files == null) return;
        for (File f : files) {
            // noinspection ResultOfMethodCallIgnored
            f.delete();
        }
    }

    String begin(Context context, String fileName, String mimeType) throws IOException {
        String id = UUID.randomUUID().toString();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentResolver resolver = context.getContentResolver();
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, fileName);
            values.put(MediaStore.Downloads.MIME_TYPE, mimeType);
            values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
            values.put(MediaStore.Downloads.IS_PENDING, 1);
            Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) throw new IOException("insert_failed");
            OutputStream out = resolver.openOutputStream(uri);
            if (out == null) {
                resolver.delete(uri, null, null);
                throw new IOException("no_stream");
            }
            sessions.put(id, new Session(fileName, mimeType, uri, null, out));
        } else {
            File dir = new File(context.getCacheDir(), TEMP_DIR);
            if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("no_temp_dir");
            File temp = new File(dir, id);
            sessions.put(id, new Session(fileName, mimeType, null, temp, new FileOutputStream(temp)));
        }
        return id;
    }

    /** Ajoute un morceau ; au-delà de MAX_BYTES au total, l'enregistrement est abandonné. */
    void append(Context context, String id, byte[] chunk) throws IOException {
        Session session = sessions.get(id);
        if (session == null) throw new IOException("unknown_save");
        if (session.written + chunk.length > MAX_BYTES) {
            abort(context, id);
            throw new TooLargeException();
        }
        try {
            session.out.write(chunk);
            session.written += chunk.length;
        } catch (IOException e) {
            abort(context, id);
            throw e;
        }
    }

    /** Termine l'écriture. Android 10+ : fichier visible dans Téléchargements. */
    Session finish(Context context, String id) throws IOException {
        Session session = sessions.remove(id);
        if (session == null) throw new IOException("unknown_save");
        try {
            session.out.close();
        } catch (IOException e) {
            discard(context, session);
            throw e;
        }
        if (session.uri != null) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.IS_PENDING, 0);
            context.getContentResolver().update(session.uri, values, null, null);
        }
        return session;
    }

    void abort(Context context, String id) {
        Session session = sessions.remove(id);
        if (session != null) discard(context, session);
    }

    void abortAll(Context context) {
        for (String id : sessions.keySet()) abort(context, id);
    }

    static void discard(Context context, Session session) {
        try {
            if (session.out != null) session.out.close();
        } catch (IOException ignored) {
            // Déjà fermé
        }
        if (session.uri != null) context.getContentResolver().delete(session.uri, null, null);
        if (session.temp != null) {
            // noinspection ResultOfMethodCallIgnored
            session.temp.delete();
        }
    }
}
