package com.yuliang.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.view.View;
import android.widget.RemoteViews;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 小组件基类（v1.3 大一统）：
 *  - 6 个尺寸族 = 6 个子类（cell 尺寸不同、单/多/滚动不同），只负责布局形态；
 *  - 内容全部由「实例配置」(WidgetData.readConfig) 决定：选哪些账号、每账号样式、主题。
 *  - 全链路 try/catch，任何一步失败都只影响单次刷新，绝不闪退。
 *  - ↻ 按钮：打开 App 并带 refresh=1 标记，前端桥读到即自动刷新一轮额度。
 */
public abstract class BaseQuotaWidget extends AppWidgetProvider {

    /** 1x1/2x1 单账号大图 */
    protected boolean single() { return false; }
    /** 4x2/4x4 内部滚动 */
    protected boolean scroll() { return false; }
    protected int singleRingDp() { return 60; }

    /** 刷新按钮 → 打开 App（extras: widget_refresh=1），由 JS 桥触发自动刷新 */
    static void bindRefresh(Context ctx, RemoteViews v, int... viewIds) {
        try {
            Intent intent = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
            if (intent == null) return;
            intent.putExtra("widget_refresh", true);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            PendingIntent pi = PendingIntent.getActivity(
                    ctx, 0, intent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            for (int id : viewIds) v.setOnClickPendingIntent(id, pi);
        } catch (Throwable ignored) {
        }
    }

    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        try {
            for (int id : ids) render(ctx, mgr, id);
        } catch (Throwable ignored) {
        }
    }

    @Override
    public void onAppWidgetOptionsChanged(Context ctx, AppWidgetManager mgr, int id, android.os.Bundle newOptions) {
        try {
            render(ctx, mgr, id);
        } catch (Throwable ignored) {
        }
    }

    private void render(Context ctx, AppWidgetManager mgr, int widgetId) {
        WidgetData.Config cfg = WidgetData.readConfig(ctx, widgetId);
        // 新建实例还没有专属配置时，采用"用户最后一次请求添加"的配置并固化为该实例配置
        if (cfg.accounts.isEmpty()) {
            try {
                JSONObject pend = PendingWidgetConfig.read(ctx);
                if (pend != null) {
                    cfg.theme = pend.optString("theme", "light");
                    JSONArray arr = pend.optJSONArray("accounts");
                    cfg.accounts.clear();
                    if (arr != null) {
                        for (int i = 0; i < arr.length(); i++) {
                            JSONObject a = arr.getJSONObject(i);
                            WidgetData.Account ac = new WidgetData.Account();
                            ac.accountId = a.optString("accountId", "");
                            ac.alias = a.optString("alias", "");
                            ac.kind = "balance".equals(a.optString("kind", "quota")) ? "balance" : "quota";
                            ac.style = a.optString("style", "ring");
                            cfg.accounts.add(ac);
                        }
                    }
                    WidgetData.saveConfig(ctx, widgetId, cfg);
                }
            } catch (Throwable ignored) {
            }
        }
        WidgetData.Palette p = WidgetData.palette(cfg.theme);
        if (single()) {
            renderSingle(ctx, mgr, widgetId, cfg, p);
        } else if (scroll()) {
            renderScroll(ctx, mgr, widgetId, cfg, p);
        } else {
            renderFixed(ctx, mgr, widgetId, cfg, p);
        }
    }

    /** 单账号大图（1x1/2x1）：第一位账号 圆环/嵌套/数字 居中 */
    private void renderSingle(Context ctx, AppWidgetManager mgr, int widgetId, WidgetData.Config cfg, WidgetData.Palette p) {
        List<WidgetData.Item> items = WidgetData.resolveFor(ctx, cfg);
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_single);
        setBg(v, ctx, cfg.theme, R.id.single_root);
        v.setTextColor(R.id.single_alias, p.alias);
        if (items.isEmpty()) {
            v.setViewVisibility(R.id.single_ring, View.GONE);
            v.setTextViewText(R.id.single_number, "—");
            v.setTextViewText(R.id.single_alias, "打开 App 添加账号");
            v.setTextColor(R.id.single_number, p.sub);
        } else {
            WidgetData.Item it = items.get(0);
            String st = it.style == null ? "number" : it.style;
            v.setTextViewText(R.id.single_alias, it.alias);
            v.setTextColor(R.id.single_alias, p.alias);
            if ("number".equals(st)) {
                v.setViewVisibility(R.id.single_ring, View.GONE);
                v.setTextViewText(R.id.single_number, it.text);
                v.setTextColor(R.id.single_number, it.err ? p.err : p.text);
            } else if ("nested".equals(st) && it.innerPct != null && it.outerPct != null) {
                v.setViewVisibility(R.id.single_ring, View.VISIBLE);
                v.setImageViewBitmap(R.id.single_ring, WidgetData.makeNested(ctx, it.innerPct, it.outerPct, singleRingDp(), p.ringFg, p.ringTrack));
                v.setTextViewText(R.id.single_number, (it.outerPct == null ? "" : it.outerPct + "%"));
                v.setTextColor(R.id.single_number, p.text);
            } else { // ring / bar / fallback → 大环
                v.setViewVisibility(R.id.single_ring, View.VISIBLE);
                v.setImageViewBitmap(R.id.single_ring, WidgetData.makeRing(ctx, it.pct == null ? 0 : it.pct, singleRingDp(),
                        it.err ? p.err : WidgetData.pctColor(it.pct == null ? 0 : it.pct, p), p.ringTrack));
                v.setTextViewText(R.id.single_number, it.pct == null ? "" : it.pct + "%");
                v.setTextColor(R.id.single_number, p.text);
            }
        }
        bindRefresh(ctx, v, R.id.widget_refresh);
        mgr.updateAppWidget(widgetId, v);
    }

    /** 固定多行（2x1/2x2/3x2） */
    private void renderFixed(Context ctx, AppWidgetManager mgr, int widgetId, WidgetData.Config cfg, WidgetData.Palette p) {
        List<WidgetData.Item> items = WidgetData.resolveFor(ctx, cfg);
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_multi);
        setBg(v, ctx, cfg.theme, R.id.widget_root);
        v.setTextViewText(R.id.widget_title, "余量");
        v.setTextColor(R.id.widget_title, p.text);
        v.setTextViewText(R.id.widget_updated, WidgetData.stamp(ctx));
        v.setTextColor(R.id.widget_updated, p.sub);
        v.removeAllViews(R.id.widget_rows);
        v.setViewVisibility(R.id.widget_empty, View.GONE);
        if (items.isEmpty()) {
            v.setViewVisibility(R.id.widget_empty, View.VISIBLE);
            v.setTextViewText(R.id.widget_empty, "还没有数据 · 打开 App 添加凭证");
            v.setTextColor(R.id.widget_empty, p.sub);
        } else {
            int max = maxFixedRows();
            for (int i = 0; i < Math.min(items.size(), max); i++) {
                try {
                    v.addView(R.id.widget_rows, WidgetData.row(ctx, items.get(i), p, 30));
                } catch (Throwable ignored) {
                }
            }
        }
        bindRefresh(ctx, v, R.id.widget_refresh);
        mgr.updateAppWidget(widgetId, v);
    }

    /** 滚动（4x2/4x4）：ListView + RemoteViewsService，工厂按实例配置过滤/样式/主题 */
    private void renderScroll(Context ctx, AppWidgetManager mgr, int widgetId, WidgetData.Config cfg, WidgetData.Palette p) {
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.widget_list);
        setBg(v, ctx, cfg.theme, R.id.widget_root);
        v.setTextViewText(R.id.widget_title, "余量");
        v.setTextColor(R.id.widget_title, p.text);
        v.setTextViewText(R.id.widget_updated, WidgetData.stamp(ctx));
        v.setTextColor(R.id.widget_updated, p.sub);
        Intent svc = new Intent(ctx, QuotaWidgetService.class);
        svc.putExtra(QuotaWidgetService.EXTRA_ID, widgetId);
        svc.setData(Uri.parse(svc.toUri(0))); // 每实例独立适配器
        v.setEmptyView(R.id.widget_list, R.id.widget_empty);
        v.setRemoteAdapter(R.id.widget_list, svc);
        bindRefresh(ctx, v, R.id.widget_refresh);
        mgr.updateAppWidget(widgetId, v);
        mgr.notifyAppWidgetViewDataChanged(widgetId, R.id.widget_list);
    }

    protected int maxFixedRows() { return 6; }

    private static void setBg(RemoteViews v, Context ctx, String theme, int rootId) {
        try {
            boolean light = !"dark".equalsIgnoreCase(theme);
            v.setInt(rootId, "setBackgroundResource",
                    light ? R.drawable.widget_bg_light : R.drawable.widget_bg_dark);
        } catch (Throwable ignored) {
        }
    }
}
