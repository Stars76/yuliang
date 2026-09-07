import { PROVIDER_LABELS } from '../util.js';

// 关于页：版本信息、数据安全说明、支持的服务一览。
// __APP_VERSION__ 由两套 vite 配置的 define 从根 package.json 注入。
export default function About() {
  const version = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';
  return (
    <div className="about-page">
      <section className="card about-card">
        <div className="about-hero">
          <img className="about-logo" src="/icons/logo.png" alt="余量" />
          <div>
            <h2 className="about-title">余量</h2>
            <p className="muted small">单机离线额度面板 · v{version}</p>
          </div>
        </div>
        <p className="about-desc">
          把多个 AI 编码订阅服务的剩余额度、限额窗口与重置时间聚合到一张面板。所有取数均为只读查询，不产生任何模型用量。
        </p>
      </section>

      <section className="card about-card">
        <h3 className="about-h3">数据与隐私</h3>
        <ul className="about-list">
          <li>凭证只保存在本设备：Windows 存系统凭据管理器（加密），Android 存安全存储</li>
          <li>没有服务器、没有账户体系，查询流量只从设备直达各服务官方端点</li>
          <li>所有端点均为代码内固定白名单，只读 GET，绝不调用模型接口</li>
        </ul>
      </section>

      <section className="card about-card">
        <h3 className="about-h3">支持的服务</h3>
        <ul className="about-providers">
          {Object.entries(PROVIDER_LABELS).map(([id, label]) => (
            <li key={id} className="about-provider-item">
              <span className="p-icon" data-p={id} aria-hidden="true">{id[0].toUpperCase()}</span>
              <span>{label}</span>
            </li>
          ))}
        </ul>
        <p className="muted small" style={{ marginTop: 8 }}>
          Codex（直连）为实验性功能：依赖未公开接口，上游变更时可能失效。
        </p>
      </section>

      <p className="muted small about-license">基于 MIT 许可证开源发布。</p>
    </div>
  );
}
