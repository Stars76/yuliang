package com.yuliang.app;

import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Iterator;
import org.json.JSONObject;

// 自写原生 HTTP（替代 Capacitor3 时代、在 Cap6 下失效的 @capacitor-community/http）。
// 用 HttpURLConnection 走 OkHttp/系统网络栈，绕过 WebView CORS；后台线程执行，主线程回调。
@CapacitorPlugin(name = "NativeHttp")
public class NativeHttpPlugin extends Plugin {

    private final Handler main = new Handler(Looper.getMainLooper());

    @PluginMethod
    public void request(PluginCall call) {
        final String url = call.getString("url");
        final String method = call.getString("method", "GET").toUpperCase();
        final JSONObject headers = call.getObject("headers");
        final String data = call.getString("data");

        new Thread(() -> {
            final JSObject ret = new JSObject();
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                c.setConnectTimeout(15000);
                c.setReadTimeout(15000);
                c.setInstanceFollowRedirects(false);
                c.setRequestMethod(method);
                if (headers != null) {
                    for (Iterator<String> it = headers.keys(); it.hasNext(); ) {
                        String k = it.next();
                        c.addRequestProperty(k, headers.getString(k));
                    }
                }
                if (data != null && !data.isEmpty() && !"GET".equals(method) && !"HEAD".equals(method)) {
                    c.setDoOutput(true);
                    try (OutputStream os = c.getOutputStream()) {
                        os.write(data.getBytes("UTF-8"));
                    }
                }
                final int status = c.getResponseCode();
                InputStream is = status >= 400 ? c.getErrorStream() : c.getInputStream();
                final String body = readAll(is);
                ret.put("status", status);
                ret.put("body", body);
                main.post(() -> call.resolve(ret));
            } catch (Exception e) {
                final String msg = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
                main.post(() -> call.reject("network_error", msg));
            }
        }).start();
    }

    private static String readAll(InputStream is) throws Exception {
        if (is == null) return "";
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
        return bos.toString("UTF-8");
    }
}
