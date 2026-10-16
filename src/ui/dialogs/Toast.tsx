import type { ToastState } from '../state/repoStore';

export function Toast({ toast, onDismiss }: { toast: ToastState | null; onDismiss: () => void }) {
  if (!toast) return null;
  return (
    <div className={'toast ' + toast.kind} role="status" onClick={toast.kind === 'progress' ? undefined : onDismiss}>
      {toast.kind === 'progress' && <span className="spinner" />}
      <span className="toast-text">{toast.text}</span>
    </div>
  );
}
