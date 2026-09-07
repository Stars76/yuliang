import { Component } from 'react';

// 兜底：任何子树渲染抛错时，显示错误信息而不是整屏白屏（便于在真机上定位）。
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    try {
      console.error('[render-error]', error, info);
    } catch {}
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 20, fontFamily: 'system-ui', color: '#e05252' }}>
          <h3 style={{ margin: '0 0 8px' }}>界面出错了</h3>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, color: '#c9d3ff' }}>
            {String(this.state.error?.stack || this.state.error?.message || this.state.error)}
          </pre>
          <button
            style={{ marginTop: 12, padding: '6px 14px', borderRadius: 8, border: '1px solid #444', background: '#1a2140', color: '#fff' }}
            onClick={() => this.setState({ error: null })}
          >
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
