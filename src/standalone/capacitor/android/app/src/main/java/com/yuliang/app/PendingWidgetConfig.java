package com.yuliang.app;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONArray;
import org.json.JSONObject;

// 保存"最近一次用户请求添加小组件"时的配置；onUpdate 里若某实例没有专属配置则使用它。
public final class PendingWidgetConfig {
    private static final String PREFS = "CapacitorStorage";
    private static final String KEY = "widget_pending";

    public static void pending(Context c, String theme, JSONArray accts) {
        try {
            JSONObject o = new JSONObject();
            o.put("theme", theme == null ? "light" : theme);
            o.put("accounts", accts == null ? new JSONArray() : accts);
            c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, o.toString()).apply();
        } catch (Throwable ignored) {
        }
    }

    public static JSONObject read(Context c) {
        try {
            String s = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null);
            return s == null ? null : new JSONObject(s);
        } catch (Throwable t) {
            return null;
        }
    }

    public static void clear(Context c) {
        try {
            c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY).apply();
        } catch (Throwable ignored) {
        }
    }
}
