package com.yuliang.app;

import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;
import java.util.ArrayList;
import java.util.List;
import com.yuliang.app.WidgetData.Config;
import com.yuliang.app.WidgetData.Item;
import com.yuliang.app.WidgetData.Palette;

// 滚动款（4x2 / 4x4）的集合服务。每实例用 widgetId 读配置：账号过滤 + 每账号样式 + 主题。
public class QuotaWidgetService extends RemoteViewsService {
    public static final String EXTRA_ID = "wl_id";

    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        return new Factory(getApplicationContext(), intent);
    }

    static class Factory implements RemoteViewsService.RemoteViewsFactory {
        private final Context ctx;
        private final int widgetId;
        private List<Item> data = new ArrayList<>();

        Factory(Context ctx, Intent intent) {
            this.ctx = ctx;
            this.widgetId = intent.getIntExtra(EXTRA_ID, 0);
        }

        @Override public void onCreate() { load(); }
        @Override public void onDataSetChanged() { load(); }
        @Override public void onDestroy() { data.clear(); }
        private void load() {
            try {
                Config cfg = WidgetData.readConfig(ctx, widgetId);
                data = WidgetData.resolveFor(ctx, cfg);
            } catch (Throwable t) {
                data = new ArrayList<>();
            }
        }
        @Override public int getCount() { return data.size(); }

        @Override
        public RemoteViews getViewAt(int position) {
            try {
                if (position < 0 || position >= data.size()) return null;
                Item it = data.get(position);
                Config cfg = WidgetData.readConfig(ctx, widgetId);
                Palette p = WidgetData.palette(cfg.theme);
                return WidgetData.row(ctx, it, p, 34);
            } catch (Throwable t) {
                return null;
            }
        }

        @Override public RemoteViews getLoadingView() { return null; }
        @Override public int getViewTypeCount() { return 1; }
        @Override public long getItemId(int position) { return position; }
        @Override public boolean hasStableIds() { return true; }
    }
}
