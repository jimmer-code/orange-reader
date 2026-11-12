package app.shubian;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.SecureRandom;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

/** Stores user-provided provider keys encrypted with an Android Keystore key. */
final class UserSecrets {
    private static final String PREFS = "user_secrets";
    private static final String KEY_ALIAS = "app.shubian.user-secrets";
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String SEPARATOR = ".";

    private UserSecrets() { }

    static String get(Context context, String name) {
        try {
            String value = prefs(context).getString(name, "");
            if (value == null || value.isEmpty()) return "";
            String[] parts = value.split("\\.", 2);
            if (parts.length != 2) return "";
            byte[] iv = Base64.decode(parts[0], Base64.NO_WRAP);
            byte[] ciphertext = Base64.decode(parts[1], Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
            return new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
        } catch (Exception ignored) {
            return "";
        }
    }

    static boolean has(Context context, String name) {
        return !get(context, name).isEmpty();
    }

    static void set(Context context, String name, String value) throws Exception {
        String text = value == null ? "" : value.trim();
        if (text.isEmpty()) {
            clear(context, name);
            return;
        }
        byte[] iv = new byte[12];
        new SecureRandom().nextBytes(iv);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key(), new GCMParameterSpec(128, iv));
        byte[] ciphertext = cipher.doFinal(text.getBytes(StandardCharsets.UTF_8));
        String stored = Base64.encodeToString(iv, Base64.NO_WRAP) + SEPARATOR
                + Base64.encodeToString(ciphertext, Base64.NO_WRAP);
        prefs(context).edit().putString(name, stored).apply();
    }

    static void clear(Context context, String name) {
        prefs(context).edit().remove(name).apply();
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance(KEYSTORE);
        store.load(null);
        if (!store.containsAlias(KEY_ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
            generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .build());
            generator.generateKey();
        }
        return ((SecretKey) store.getKey(KEY_ALIAS, null));
    }
}
