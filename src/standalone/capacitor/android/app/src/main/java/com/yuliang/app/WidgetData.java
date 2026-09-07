package com.yuliang.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.view.View;
import android.widget.RemoteViews;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 小组件共享逻辑（v1.3 大一统版）：
 *  - 实例配置按 appWidgetId 存 SharedPreferences（主题 + 账号选择 + 每账号样式）。
 *  - balance 账号强制数字；quota 账号可选 ring / nested / bar / number。
 *  - 快照 item 带 accountId + kind；渲染全链路 try/catch，单行失败降级为纯文本，绝不崩整卡。
 */
public final class WidgetData {

    public static final int STYLE_BAR = 0, STYLE_RING = 1, STYLE_NUMBER = 2;

    private static final String PREFS = "CapacitorStorage";
    private static final String SNAP_KEY = "widget_snapshot";
    private static final String CFG_PREFIX = "widget_cfg_";

    private WidgetData() {}

    // ---------- 快照条目 ----------
    public static final class Item {
        public String accountId = "";
        public String alias = "";
        public String text = "—";
        public String kind = "quota";   // quota | balance
        public Integer pct;             // 剩余 0-100；null = 余额/异常
        public boolean err;
        public String style = "ring";   // 渲染时解析出的样式（quota 用）
        public Integer innerPct;        // nested：内层（如 5h）剩余
        public Integer outerPct;        // nested：外层（如 weekly）剩余
        public Integer windowIdx = null;
    }

    public static List<Item> loadAll(Context ctx) {
        List<Item> out = new ArrayList<>();
        try {
            String json = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(SNAP_KEY, null);
            if (json == null) return out;
            JSONArray arr = new JSONObject(json).optJSONArray("items");
            if (arr == null) return out;
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                Item it = new Item();
                it.accountId = o.optString("accountId", "");
                it.alias = o.optString("alias", "");
                it.text = o.optString("text", "—");
                it.kind = "balance".equals(o.optString("kind", "quota")) ? "balance" : "quota";
                it.err = o.optBoolean("err", false);
                it.pct = o.isNull("pct") ? null : Math.max(0, o.optInt("pct", -1) < 0 ? null : o.optInt("pct", -1));
                if (o.has("innerPct")) { int v = o.optInt("innerPct", -1); it.innerPct = v >= 0 ? v : null; }
                if (o.has("outerPct")) { int v = o.optInt("outerPct", -1); it.outerPct = v >= 0 ? v : null; }
                it.style = it.kind.equals("balance") || it.pct == null ? "number" : "ring";
                if (it.innerPct != null && it.outerPct != null) it.style = "nested";
                out.add(it);
            }
        } catch (Exception ignored) {
        }
        return out;
    }

    public static long updatedAt(Context ctx) {
        try {
            String json = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(SNAP_KEY, null);
            return json == null ? 0 : new JSONObject(json).optLong("updated", 0);
        } catch (Exception e) {
            return 0;
        }
    }
    public static String stamp(Context ctx) {
        long t = updatedAt(ctx);
        return t > 0 ? "更新于 " + new SimpleDateFormat("HH:mm", Locale.getDefault()).format(new Date(t)) : "尚无数据 · 打开 App 刷新";
    }

    // ---------- 实例配置 ----------
    public static final class Account {
        public String accountId = "";
        public String alias = "";
        public String kind = "quota";
        public String style = "ring";   // ring|nested|bar|number
    }
    public static final class Config {
        public String theme = "light";
        public final List<Account> accounts = new ArrayList<>();
        public boolean pinnedStyleRing; // 1x1/2x1 单账号场景是否环形（默认 true 环）
    }

    public static Config readConfig(Context ctx, int widgetId) {
        Config cfg = new Config();
        try {
            String json = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(CFG_PREFIX + widgetId, null);
            if (json == null) return cfg;
            JSONObject o = new JSONObject(json);
            cfg.theme = o.optString("theme", "light");
            JSONArray arr = o.optJSONArray("accounts");
            if (arr != null) {
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject a = arr.getJSONObject(i);
                    Account ac = new Account();
                    ac.accountId = a.optString("accountId", "");
                    ac.alias = a.optString("alias", "");
                    ac.kind = "balance".equals(a.optString("kind", "quota")) ? "balance" : "quota";
                    ac.style = a.optString("style", ac.kind.equals("balance") ? "number" : "ring");
                    cfg.accounts.add(ac);
                }
            }
        } catch (Exception ignored) {
        }
        return cfg;
    }

    public static void saveConfig(Context ctx, int widgetId, Config cfg) {
        try {
            JSONObject o = new JSONObject();
            o.put("theme", cfg.theme);
            JSONArray arr = new JSONArray();
            for (Account a : cfg.accounts) {
                JSONObject j = new JSONObject();
                j.put("accountId", a.accountId);
                j.put("alias", a.alias);
                j.put("kind", a.kind);
                j.put("style", a.style);
                arr.put(j);
            }
            o.put("accounts", arr);
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(CFG_PREFIX + widgetId, o.toString()).apply();
        } catch (Exception ignored) {
        }
    }

    /** 无配置或配置为空时：全部账号 + 每账号默认样式 */
    public static List<Item> resolveAll(Context ctx) {
        return loadAll(ctx);
    }

    /** 有配置：按配置挑选账号并应用每账号样式；找不到的账号跳过 */
    public static List<Item> resolveFor(Context ctx, Config cfg) {
        if (cfg.accounts.isEmpty()) return resolveAll(ctx);
        List<Item> all = loadAll(ctx);
        List<Item> out = new ArrayList<>();
        for (Account a : cfg.accounts) {
            Item hit = null;
            for (Item it : all) if (it.accountId.equals(a.accountId)) { hit = it; break; }
            if (hit == null) continue;
            hit.alias = a.alias != null && !a.alias.isEmpty() ? a.alias : hit.alias;
            if (a.kind.equals("balance") || hit.kind.equals("balance") || hit.pct == null) {
                hit.style = "number";
            } else {
                hit.style = a.style == null ? "ring" : a.style;
            }
            out.add(hit);
        }
        return out;
    }

    // ---------- 色板 ----------
    public static final class Palette {
        public final int bg, text, alias, sub, bar, ringTrack, err, ringFg;
        Palette(int bg, int text, int alias, int sub, int bar, int ringTrack, int err) {
            this.bg = bg; this.text = text; this.alias = alias; this.sub = sub;
            this.bar = bar; this.ringTrack = ringTrack; this.err = err;
            this.ringFg = bar;
        }
    }
    public static Palette palette(String theme) {
        boolean light = !"dark".equalsIgnoreCase(theme);
        if (light) {
            // 浅色系：对齐 App 浅色主题
            return new Palette(0xFFF3F6FF, 0xFF17223B, 0xFF3A4A66, 0xFF5B6B85, 0xFF4A7DFF, 0xFFDCE3F8, 0xFFE05252);
        }
        return new Palette(0xCC0B1020, 0xFFE9EDF7, 0xFFC3CADD, 0xFF8B93AB, 0xFF7C9CFF, 0xFF2A3350, 0xFFFF8A8A);
    }
    public static int pctColor(int pct, Palette p) {
        if (pct >= 95) return 0xFFE05252;      // danger
        if (pct >= 80) return 0xFFE0952F;      // warn
        return p.bar;
    }

    // ---------- 位图 ----------
    public static android.graphics.Bitmap makeRing(Context ctx, int pct, int dp, int fg, int track) {
        int size = Math.max(12, (int) (dp * ctx.getResources().getDisplayMetrics().density));
        android.graphics.Bitmap bmp = android.graphics.Bitmap.createBitmap(size, size, android.graphics.Bitmap.Config.ARGB_8888);
        Canvas cv = new Canvas(bmp);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setStyle(Paint.Style.STROKE);
        p.setStrokeCap(Paint.Cap.ROUND);
        float stroke = size * 0.13f;
        p.setStrokeWidth(stroke);
        RectF r = new RectF(stroke / 2f, stroke / 2f, size - stroke / 2f, size - stroke / 2f);
        p.setColor(track);
        cv.drawArc(r, 0, 360, false, p);
        p.setColor(fg);
        float sweep = pct < 0 ? 0f : Math.min(360f, pct * 3.6f);
        cv.drawArc(r, -90f, sweep, false, p);
        return bmp;
    }

    /** 嵌套圆环：外层 outerPct、内层 innerPct（位图），中心数字交给布局里的 TextView */
    public static android.graphics.Bitmap makeNested(Context ctx, int innerPct, int outerPct, int dp, int fg, int track) {
        int size = Math.max(14, (int) (dp * ctx.getResources().getDisplayMetrics().density));
        android.graphics.Bitmap bmp = android.graphics.Bitmap.createBitmap(size, size, android.graphics.Bitmap.Config.ARGB_8888);
        Canvas cv = new Canvas(bmp);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setStyle(Paint.Style.STROKE);
        p.setStrokeCap(Paint.Cap.ROUND);
        float oS = size * 0.12f, iS = size * 0.09f;
        RectF or = new RectF(oS / 2f, oS / 2f, size - oS / 2f, size - oS / 2f);
        RectF ir = new RectF(oS + iS * 0.4f, oS + iS * 0.4f, size - oS - iS * 0.4f, size - oS - iS * 0.4f);
        p.setStrokeWidth(oS); p.setColor(track); cv.drawArc(or, 0, 360, false, p);
        p.setColor(fg); cv.drawArc(or, -90f, Math.min(360f, Math.max(0, outerPct) * 3.6f), false, p);
        p.setStrokeWidth(iS); p.setColor(track); cv.drawArc(ir, 0, 360, false, p);
        p.setColor(0xFF25B586); cv.drawArc(ir, -90f, Math.min(360f, Math.max(0, innerPct) * 3.6f), false, p);
        return bmp;
    }

    /** 统一按 Item 生成一行 RemoteViews（新 row 布局：bar/ring/number/文本都可用） */
    public static RemoteViews row(Context ctx, Item it, Palette p, int ringDp) {
        try {
            RemoteViews r = new RemoteViews(ctx.getPackageName(), R.layout.widget_row);
            r.setTextViewText(R.id.row_alias, it.alias);
            r.setTextColor(R.id.row_alias, p.alias);
            r.setViewVisibility(R.id.row_bar, View.GONE);
            r.setViewVisibility(R.id.row_ring, View.GONE);
            r.setViewVisibility(R.id.row_number, View.GONE);
            String st = it.style == null ? "number" : it.style;
            if ("number".equals(st)) {
                r.setViewVisibility(R.id.row_number, View.VISIBLE);
                r.setTextViewText(R.id.row_number, it.text);
                r.setTextColor(R.id.row_number, it.err ? p.err : p.text);
            } else if ("nested".equals(st) && it.innerPct != null && it.outerPct != null) {
                r.setViewVisibility(R.id.row_ring, View.VISIBLE);
                r.setImageViewBitmap(R.id.row_ring, makeNested(ctx, it.innerPct, it.outerPct, ringDp, p.ringFg, p.ringTrack));
                r.setTextViewText(R.id.row_text, it.text);
                r.setTextColor(R.id.row_text, it.err ? p.err : p.sub);
            } else if ("ring".equals(st) && it.pct != null) {
                r.setViewVisibility(R.id.row_ring, View.VISIBLE);
                r.setImageViewBitmap(R.id.row_ring, makeRing(ctx, it.pct, ringDp, it.err ? p.err : pctColor(it.pct, p), p.ringTrack));
                r.setTextViewText(R.id.row_text, it.text);
                r.setTextColor(R.id.row_text, it.err ? p.err : p.sub);
            } else if ("bar".equals(st) && it.pct != null) {
                r.setViewVisibility(R.id.row_bar, View.VISIBLE);
                r.setProgressBar(R.id.row_bar, 100, Math.max(0, Math.min(100, it.pct)), false);
                r.setTextViewText(R.id.row_text, it.text);
                r.setTextColor(R.id.row_text, it.err ? p.err : p.sub);
            } else {
                // 降级：纯文本
                r.setViewVisibility(R.id.row_number, View.VISIBLE);
                r.setTextViewText(R.id.row_number, it.text);
                r.setTextColor(R.id.row_number, it.err ? p.err : p.sub);
            }
            return r;
        } catch (Throwable t) {
            // 极端兜底：单行降级为纯文本，绝不崩
            try {
                RemoteViews fallback = new RemoteViews(ctx.getPackageName(), R.layout.widget_row);
                fallback.setTextViewText(R.id.row_alias, it.alias);
                fallback.setViewVisibility(R.id.row_ring, View.GONE);
                fallback.setViewVisibility(R.id.row_bar, View.GONE);
                fallback.setViewVisibility(R.id.row_number, View.VISIBLE);
                fallback.setTextViewText(R.id.row_number, it.text);
                fallback.setTextColor(R.id.row_number, it.err ? p.err : p.text);
                return fallback;
            } catch (Throwable ignored) {
                return null;
            }
        }
    }
}
