//! Quick Commit window: created once (hidden), positioned under the tray icon, hidden on blur
//! unless the UI reports an op in flight (`set_quick_commit_busy`).
use crate::error::{AppError, Result};
use crate::models::*;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_positioner::{Position, WindowExt};

/// A show within this long after a blur-hide is ignored: clicking the tray icon again toggles the window.
pub const TOGGLE_GUARD: Duration = Duration::from_millis(250);

#[derive(Default)]
pub struct QuickState {
    target: Mutex<Option<String>>,
    busy: AtomicBool,
    last_blur_hide: Mutex<Option<Instant>>,
}

/// Pure toggle rule.
pub fn ignore_show(last_blur_hide: Option<Instant>, now: Instant) -> bool {
    last_blur_hide.is_some_and(|t| now.saturating_duration_since(t) < TOGGLE_GUARD)
}

/// Pure blur rule.
pub fn should_hide_on_blur(busy: bool) -> bool {
    !busy
}

impl QuickState {
    pub fn target(&self) -> Option<String> {
        self.target.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
    pub fn set_busy(&self, busy: bool) {
        self.busy.store(busy, Ordering::SeqCst);
    }
    pub fn busy(&self) -> bool {
        self.busy.load(Ordering::SeqCst)
    }
}

pub fn ensure_window<R: Runtime>(app: &AppHandle<R>) -> Result<WebviewWindow<R>> {
    if let Some(w) = app.get_webview_window(QUICK_COMMIT_WINDOW_LABEL) {
        return Ok(w);
    }
    WebviewWindowBuilder::new(app, QUICK_COMMIT_WINDOW_LABEL, WebviewUrl::App("index.html?quickCommit=1".into()))
        .title("Quick Commit")
        .inner_size(380.0, 520.0)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .build()
        .map_err(|e| AppError::internal(format!("quick-commit window: {e}")))
}

/// `open_quick_commit { repoPath }`.
pub fn open<R: Runtime>(app: &AppHandle<R>, state: &QuickState, repo_path: &str) -> Result<()> {
    if ignore_show(*state.last_blur_hide.lock().unwrap_or_else(|p| p.into_inner()), Instant::now()) {
        return Ok(());
    }
    *state.target.lock().unwrap_or_else(|p| p.into_inner()) = Some(repo_path.to_string());
    let w = ensure_window(app)?;
    if w.move_window(Position::TrayBottomCenter).is_err() {
        // the tray icon position is not known yet
        let _ = w.move_window(Position::TopRight);
    }
    let _ = w.show();
    let _ = w.set_focus();
    let ev = QuickCommitTargetEvent { repo_path: repo_path.to_string() };
    let _ = app.emit_to(QUICK_COMMIT_WINDOW_LABEL, EVENT_QUICK_COMMIT_TARGET, ev.clone());
    // First show: the page may still be loading its listener; repeat once (UI also pulls get_quick_commit_target).
    let app2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(500));
        let _ = app2.emit_to(QUICK_COMMIT_WINDOW_LABEL, EVENT_QUICK_COMMIT_TARGET, ev);
    });
    Ok(())
}

/// Window lost focus.
pub fn on_blur<R: Runtime>(app: &AppHandle<R>, state: &QuickState) {
    if !should_hide_on_blur(state.busy()) {
        return;
    }
    if let Some(w) = app.get_webview_window(QUICK_COMMIT_WINDOW_LABEL)
        && w.is_visible().unwrap_or(false)
    {
        let _ = w.hide();
        *state.last_blur_hide.lock().unwrap_or_else(|p| p.into_inner()) = Some(Instant::now());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toggle_guard() {
        let t0 = Instant::now();
        assert!(!ignore_show(None, t0));
        assert!(ignore_show(Some(t0), t0 + Duration::from_millis(100)));
        assert!(!ignore_show(Some(t0), t0 + Duration::from_millis(300)));
    }

    #[test]
    fn blur_rule_and_state() {
        assert!(should_hide_on_blur(false));
        assert!(!should_hide_on_blur(true));
        let s = QuickState::default();
        assert!(!s.busy());
        s.set_busy(true);
        assert!(s.busy());
        assert_eq!(s.target(), None);
    }
}
