package com.yuliang.app;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.security.KeyStore;
import java.util.Base64;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

// 凭证加密插件：Android Keystore AES-256-GCM。
// 密钥生成就地存于硬件背书的 Keystore，不可导出；App 卸载即销毁。
// encrypt/decrypt 接口与 Electron safeStorage codec 同构（base64 字符进出）。
@CapacitorPlugin(name = "SecureCodec")
public class SecureCodecPlugin extends Plugin {

    private static final String ANDROID_KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "yuliang_cred_key";
    private static final int GCM_TAG_BITS = 128;
    private static final int IV_BYTES = 12;

    private SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance(ANDROID_KEYSTORE);
        ks.load(null);
        SecretKey existing = (SecretKey) ks.getKey(KEY_ALIAS, null);
        if (existing != null) return existing;
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE);
        kg.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return kg.generateKey();
    }

    @PluginMethod
    public void encrypt(PluginCall call) {
        try {
            String plain = call.getString("plain", "");
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, key());
            byte[] iv = c.getIV();
            byte[] ct = c.doFinal(plain.getBytes("UTF-8"));
            byte[] out = new byte[iv.length + ct.length];
            System.arraycopy(iv, 0, out, 0, iv.length);
            System.arraycopy(ct, 0, out, iv.length, ct.length);
            JSObject ret = new JSObject();
            ret.put("data", Base64.getEncoder().encodeToString(out));
            call.resolve(ret);
        } catch (Throwable t) {
            call.reject("encrypt_failed", t.getMessage());
        }
    }

    @PluginMethod
    public void decrypt(PluginCall call) {
        try {
            byte[] all = Base64.getDecoder().decode(call.getString("data", ""));
            if (all.length <= IV_BYTES) throw new IllegalArgumentException("ciphertext too short");
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(GCM_TAG_BITS, all, 0, IV_BYTES));
            String plain = new String(c.doFinal(all, IV_BYTES, all.length - IV_BYTES), "UTF-8");
            JSObject ret = new JSObject();
            ret.put("plain", plain);
            call.resolve(ret);
        } catch (Throwable t) {
            call.reject("decrypt_failed", t.getMessage());
        }
    }
}
