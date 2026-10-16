import { dismissToast, useStore } from '../state/store';

export function Toast() {
  const toast = useStore((s) => s.toast);
  if (!toast) return null;
  return (
    <div className={'toast ' + toast.kind} role="status" onClick={toast.kind === 'progress' ? undefined : dismissToast}>
      {toast.kind === 'progress' && <span className="spinner" />}
      <span className="toast-text">{toast.text}</span>
    </div>
  );
}
