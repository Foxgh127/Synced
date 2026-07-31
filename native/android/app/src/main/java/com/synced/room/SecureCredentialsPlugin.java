package com.synced.room;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "SecureCredentials")
public final class SecureCredentialsPlugin extends Plugin {
    private static final String KEYSTORE_PROVIDER = "AndroidKeyStore";
    private static final String KEY_ALIAS = "synced.channel-owner.v1";
    private static final String PREFERENCES_NAME = "synced_secure_credentials";
    private static final String OWNERSHIP_ENTRY = "channel_owner_v1";
    private static final int GCM_TAG_BITS = 128;
    private static final int GCM_IV_BYTES = 12;

    @PluginMethod
    public void loadChannelOwnership(PluginCall call) {
        JSObject result = new JSObject();
        try {
            String encoded = preferences().getString(OWNERSHIP_ENTRY, null);
            if (encoded == null || encoded.isBlank()) {
                result.put("found", false);
                call.resolve(result);
                return;
            }
            byte[] envelope = Base64.decode(encoded, Base64.NO_WRAP);
            if (envelope.length <= GCM_IV_BYTES) {
                throw new IllegalStateException("credential envelope is invalid");
            }
            byte[] iv = new byte[GCM_IV_BYTES];
            byte[] ciphertext = new byte[envelope.length - GCM_IV_BYTES];
            System.arraycopy(envelope, 0, iv, 0, iv.length);
            System.arraycopy(envelope, iv.length, ciphertext, 0, ciphertext.length);

            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(
                Cipher.DECRYPT_MODE,
                getOrCreateKey(),
                new GCMParameterSpec(GCM_TAG_BITS, iv)
            );
            JSONObject ownership = new JSONObject(
                new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8)
            );
            String room = ownership.optString("room", "");
            String ownerToken = ownership.optString("ownerToken", "");
            if (!validRoom(room) || !validOwnerToken(ownerToken)) {
                throw new IllegalStateException("credential payload is invalid");
            }
            result.put("found", true);
            result.put("room", room);
            result.put("ownerToken", ownerToken);
            call.resolve(result);
        } catch (Exception error) {
            // Authentication failures, a restored preference without its
            // device-bound key, or an invalidated key must never expose or
            // retain undecipherable credential material.
            resetCredentialStore();
            call.reject("无法读取 Android 安全凭据");
        }
    }

    @PluginMethod
    public void saveChannelOwnership(PluginCall call) {
        String room = call.getString("room", "");
        String ownerToken = call.getString("ownerToken", "");
        if (!validRoom(room) || !validOwnerToken(ownerToken)) {
            call.reject("频道主凭据格式无效");
            return;
        }
        try {
            JSONObject ownership = new JSONObject();
            ownership.put("room", room);
            ownership.put("ownerToken", ownerToken);

            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
            byte[] ciphertext = cipher.doFinal(
                ownership.toString().getBytes(StandardCharsets.UTF_8)
            );
            byte[] iv = cipher.getIV();
            if (iv == null || iv.length != GCM_IV_BYTES) {
                throw new IllegalStateException("credential IV is invalid");
            }
            byte[] envelope = new byte[iv.length + ciphertext.length];
            System.arraycopy(iv, 0, envelope, 0, iv.length);
            System.arraycopy(ciphertext, 0, envelope, iv.length, ciphertext.length);
            boolean saved = preferences()
                .edit()
                .putString(
                    OWNERSHIP_ENTRY,
                    Base64.encodeToString(envelope, Base64.NO_WRAP)
                )
                .commit();
            if (!saved) {
                throw new IllegalStateException("credential storage commit failed");
            }
            JSObject result = new JSObject();
            result.put("saved", true);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("无法保存 Android 安全凭据");
        }
    }

    private SharedPreferences preferences() {
        return getContext().getSharedPreferences(
            PREFERENCES_NAME,
            Context.MODE_PRIVATE
        );
    }

    private SecretKey getOrCreateKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER);
        keyStore.load(null);
        java.security.Key existing = keyStore.getKey(KEY_ALIAS, null);
        if (existing instanceof SecretKey) {
            return (SecretKey) existing;
        }
        KeyGenerator generator = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES,
            KEYSTORE_PROVIDER
        );
        generator.init(
            new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build()
        );
        return generator.generateKey();
    }

    private void resetCredentialStore() {
        preferences().edit().remove(OWNERSHIP_ENTRY).commit();
        try {
            KeyStore keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER);
            keyStore.load(null);
            if (keyStore.containsAlias(KEY_ALIAS)) {
                keyStore.deleteEntry(KEY_ALIAS);
            }
        } catch (Exception ignored) {
            // The ciphertext has already been removed. A future save will
            // retry key creation if the platform keystore becomes available.
        }
    }

    private static boolean validRoom(String value) {
        return value != null && value.matches("^[23456789A-HJ-NP-Z]{8}$");
    }

    private static boolean validOwnerToken(String value) {
        return value != null && value.matches("^[A-Za-z0-9_-]{43}$");
    }
}
