import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);
  const push = useCallback((text, kind = 'error') => {
    const id = ++idRef.current;
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-wrap" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function Spinner({ label }) {
  return (
    <div className="spinner-wrap">
      <span className="spinner" aria-hidden="true" />
      {label && <span>{label}</span>}
    </div>
  );
}

export function SkeletonCard() {
  return (
    <div className="card skeleton-card" aria-hidden="true">
      <div className="skel skel-line w60" />
      <div className="skel skel-line w40" />
      <div className="skel skel-bar" />
      <div className="skel skel-line w50" />
      <div className="skel skel-bar" />
    </div>
  );
}

export function EmptyState({ title, hint }) {
  return (
    <div className="empty-state">
      <svg width="96" height="96" viewBox="0 0 96 96" fill="none" aria-hidden="true">
        <rect x="14" y="26" width="68" height="48" rx="8" stroke="currentColor" strokeOpacity="0.35" strokeWidth="2" />
        <rect x="22" y="38" width="30" height="4" rx="2" fill="currentColor" fillOpacity="0.25" />
        <rect x="22" y="48" width="52" height="4" rx="2" fill="currentColor" fillOpacity="0.15" />
        <rect x="22" y="58" width="40" height="4" rx="2" fill="currentColor" fillOpacity="0.1" />
        <circle cx="70" cy="20" r="10" stroke="currentColor" strokeOpacity="0.4" strokeWidth="2" />
        <path d="M66 20h8M70 16v8" stroke="currentColor" strokeOpacity="0.4" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <h3>{title}</h3>
      {hint && <p>{hint}</p>}
    </div>
  );
}
