package com.yuliang.app;

import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONArray;
import org.json.JSONObject;

// 小组件管理插件：把额度快照即时重绘；把「所选账号 + 样式 + 尺寸」固定为新的桌面小组件。
// requestAdd 的 ROM 差异（实测归纳）：
//  • 华为/荣耀、OPPO/三星：弹系统确认框，确认即上桌
//  • 小米/红米：不弹框直接上桌，但需先授予「桌面快捷方式」权限，未授权则毫无反应
//  • vivo/iQOO：不接其原子组件 SDK 则 requestPinAppWidget 完全无效
// 因此：pin 请求发出后轮询 getAppWidgetIds 计数判断成败，失败按 ROM 差异化兜底。
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

    /** 直接由 App 添加小组件：pin 请求 + 计数轮询判定成败 + ROM 差异化兜底。 */
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
            final ComponentName cn = new ComponentName(c, w);

            if (Build.VERSION.SDK_INT >= 26) {
                final int before = countIds(mgr, c, w);
                boolean requested = false;
                try {
                    requested = mgr.requestPinAppWidget(cn, new Bundle(), null);
                } catch (Throwable ignored) {
                }
                if (requested) {
                    // 返回 true 不代表成功（launcher 可静默忽略，小米未授权快捷方式权限时即如此）。
                    // 轮询计数：某次轮询发现 widgetId 变多 → 上桌成功；超时未变 → 按 ROM 兜底。
                    final PluginCall pending = call;
                    final Handler h = new Handler(Looper.getMainLooper());
                    final int[] attempts = {0};
                    final Runnable[] poll = new Runnable[1];
                    poll[0] = new Runnable() {
                        @Override
                        public void run() {
                            attempts[0]++;
                            if (countIds(mgr, c, w) > before) {
                                pending.resolve(js("pinned"));
                                return;
                            }
                            if (attempts[0] >= 10) { // 10 次 × 400ms ≈ 4s 仍无变化
                                pending.resolve(js(fallbackStatus(c)));
                                return;
                            }
                            h.postDelayed(poll[0], 400);
                        }
                    };
                    h.postDelayed(poll[0], 400);
                    return;
                }
                // 请求被明确拒绝：尝试系统小组件选择器
                if (launchPicker(c)) {
                    call.resolve(js("picker"));
                    return;
                }
                call.resolve(js("manual"));
                return;
            }

            // API < 26：只能走系统选择器
            if (launchPicker(c)) {
                call.resolve(js("picker"));
            } else {
                call.resolve(js("manual"));
            }
        } catch (Throwable t) {
            call.reject(t.getMessage() == null ? "failed" : t.getMessage(), "failed");
        }
    }

    private static int countIds(AppWidgetManager mgr, Context c, Class<?> w) {
        try {
            int[] ids = mgr.getAppWidgetIds(new ComponentName(c, w));
            return ids == null ? 0 : ids.length;
        } catch (Throwable t) {
            return 0;
        }
    }

    /** 轮询超时未上桌 → 按品牌给出可操作的兜底状态（小米引导开权限，vivo 明说走手动）。 */
    private static String fallbackStatus(Context c) {
        String brand = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.toLowerCase();
        if (brand.contains("xiaomi") || brand.contains("redmi")) {
            // 小米：桌面快捷方式权限被关时请求无效；跳系统应用详情让用户一键开启
            try {
                Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.fromParts("package", c.getPackageName(), null));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                c.startActivity(i);
                return "miui-permission";
            } catch (Throwable ignored) {
            }
        }
        if (brand.contains("oppo") || brand.contains("oneplus") || brand.contains("realme") || brand.contains("oneplus")) {
            // OPPO/一加/真我（ColorOS 12+）：未授予「桌面快捷方式」权限时静默失败，
            // 且 ColorOS 13+ 部分场景跳转桌面设置页而非确认框。跳应用详情引导开启。
            try {
                Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.fromParts("package", c.getPackageName(), null));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                c.startActivity(i);
                return "coloros-permission";
            } catch (Throwable ignored) {
            }
        }
        return "manual";
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

    private static JSObject js(String status) {
        try {
            return new JSObject().put("status", status);
        } catch (Throwable t) {
            return new JSObject();
        }
    }
}
