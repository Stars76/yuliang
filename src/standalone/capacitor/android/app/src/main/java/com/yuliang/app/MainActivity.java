package com.yuliang.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 注册本地自定义插件：桌面小组件即时刷新 + 原生 HTTP（替代失效的 community/http）+ Keystore 凭证加密
        registerPlugin(QuotaWidgetPlugin.class);
        registerPlugin(NativeHttpPlugin.class);
        registerPlugin(SecureCodecPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
