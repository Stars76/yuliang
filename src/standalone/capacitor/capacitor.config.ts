import type { CapacitorConfig } from '@capacitor/cli';

// 单机额度面板 · Android(Capacitor) 壳配置。
// webDir 指向本目录 vite 构建产物（npm run build:web → www）。
const config: CapacitorConfig = {
  appId: 'com.yuliang.app',
  appName: '余量',
  webDir: 'www',
  server: {
    androidScheme: 'https',
  },
};

export default config;
