package com.yuliang.app;

import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONArray;
import org.json.JSONObject;

// 小组件管理插件：把额度快照即时重绘；把「所选账号 + 样式 + 尺寸」固定为新的桌面小组件。
@CapacitorPlugin(name = "QuotaWidget")
public class QuotaWidgetPlugin extends Plugin {

    // 按 cell 尺寸映射组件类
    private static final String[][] SIZES = {
            {"1x1", "com.yuliang.app.W1x1"},
            {"2x1", "com.yuliang.app.W2x1"},
            {"2x2", "com.yuliang.app.W2x2"},
            {"3x2", "com.yuliang.app.W3x2"},
            {"4x2", "com.yuliang.app.W4x2"},
            {"4x4", "com.yuliang.app.W4x4"},
    };

    private static Class<?> clsOf(String size) {
        for (String[] s : SIZES) if (s[0].equals(size)) {
            try { return Class.forName(s[1]); } catch (Throwable ignored) { }
        }
        return null;
    }

    @PluginMethod
    public void notifyUpdate(PluginCall call) {
        try {
            Context c = getContext();
            AppWidgetManager mgr = AppWidgetManager.getInstance(c);
            for (String[] s : SIZES) {
                try {
                    Class<?> w = clsOf(s[0]);
                    if (w == null) continue;
                    int[] ids = mgr.getAppWidgetIds(new ComponentName(c, w));
                    if (ids == null || ids.length == 0) continue;
                    Intent intent = new Intent(c, w);
                    intent.setAction(AppWidgetManager.ACTION_APPWIDGET_UPDATE);
                    intent.putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids);
                    c.sendBroadcast(intent);
                    for (int id : ids) mgr.notifyAppWidgetViewDataChanged(id, R.id.widget_list);
                } catch (Throwable ignored) {
                }
            }
        } catch (Throwable ignored) {
        }
        call.resolve();
    }

    /** 主题跟随：把已放置实例的配置主题整体切到 light/dark 并重绘 */
    @PluginMethod
    public void setTheme(PluginCall call) {
        try {
            String theme = call.getString("theme", "light");
            Context c = getContext();
            AppWidgetManager mgr = AppWidgetManager.getInstance(c);
            for (String[] s : SIZES) {
                Class<?> w = clsOf(s[0]);
                if (w == null) continue;
                int[] ids = mgr.getAppWidgetIds(new ComponentName(c, w));
                for (int id : ids) {
                    try {
                        WidgetData.Config cfg = WidgetData.readConfig(c, id);
                        cfg.theme = theme;
                        WidgetData.saveConfig(c, id, cfg);
                    } catch (Throwable ignored) {
                    }
                }
            }
            notifyUpdate(call); // 复用广播重绘
        } catch (Throwable t) {
            call.resolve();
        }
    }

    /** 用系统浏览器打开外部链接（如 Codex 设备码验证页），避免 WebView 内跳转困住用户 */
    @PluginMethod
    public void openExternal(PluginCall call) {
        String url = call.getString("url", "");
        try {
            Context c = getContext();
            Intent intent = new Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            c.startActivity(intent);
            call.resolve();
        } catch (Throwable t) {
            call.reject("open_failed", t.getMessage());
        }
    }

    /** 直接由 App 添加小组件（API>=26 走系统请求固定；返回状态供前端给出精确引导）。 */
    @PluginMethod
    public void requestAdd(PluginCall call) {
        final String size = call.getString("size", "3x2");
        final String theme = call.getString("theme", "light");
        final JSONArray accts = call.getArray("accounts");
        try {
            final Class<?> w = clsOf(size);
            if (w == null) {
                call.reject("invalid_size", "size");
                return;
            }
            final Context c = getContext();
            final AppWidgetManager mgr = AppWidgetManager.getInstance(c);
            // 先记下这份"待放置配置"：用户确认/手动添加后 onUpdate 会读取它固化为实例配置
            PendingWidgetConfig.pending(c, theme, accts);
            ComponentName cn = new ComponentName(c, w);

            if (Build.VERSION.SDK_INT >= 26) {
                boolean ok = false;
                try {
                    ok = mgr.requestPinAppWidget(cn, new Bundle(), null);
                } catch (Throwable t) {
                    ok = false; // 个别 ROM 对未授权应用直接抛异常
                }
                if (ok) {
                    // 系统已受理（绝大多数 ROM 会弹放置框）；但 ColorOS/OriginOS 个别版本会静默忽略，
                    // 无法从这里检测弹窗是否真出现 → 让前端同时给出"长按手动添加"兜底指引
                    call.resolve(js("pin-ok"));
                    return;
                }
                // requestPin 被拒/异常：降级尝试系统小组件选择器（部分 ROM 支持直接进列表）
                if (launchPicker(c)) {
                    call.resolve(js("picker"));
                    return;
                }
                // 选择器也不可用：交给用户长按桌面手动添加
                call.resolve(js("manual"));
                return;
            }

            // API < 26：只能走系统选择器（即便可用也只是打开列表供用户自行摆放）
            if (launchPicker(c)) {
                call.resolve(js("picker"));
            } else {
                call.resolve(js("manual"));
            }
        } catch (Throwable t) {
            call.reject(t.getMessage() == null ? "failed" : t.getMessage(), "failed");
        }
    }

    private static JSObject js(String status) {
        try {
            return new JSObject().put("status", status);
        } catch (Throwable t) {
            return new JSObject();
        }
    }

    /** 打开系统小组件选择器；打不开返回 false（引导用户长按桌面手动添加）。 */
    private boolean launchPicker(Context c) {
        try {
            Intent picker = new Intent(AppWidgetManager.ACTION_APPWIDGET_PICK);
            picker.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID);
            picker.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            c.startActivity(picker);
            return true;
        } catch (Throwable t) {
            return false;
        }
    }
}
