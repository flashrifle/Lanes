//! Main-window lifecycle: close-to-menu-bar, activation policy, reopen.
//! Order matters (avoids a Dock flicker): hiding = hide the window THEN Accessory;
//! showing = Regular THEN show + focus.
use crate::app::settings::keeps_running;
use crate::models::*;
use crate::state::AppState;
use tauri::{AppHandle, Emitter, Manager, Runtime};

pub const MAIN_LABEL: &str = "main";

#[cfg(target_os = "macos")]
fn set_policy<R: Runtime>(app: &AppHandle<R>, accessory: bool) {
    use tauri::ActivationPolicy;
    let p = if accessory { ActivationPolicy::Accessory } else { ActivationPolicy::Regular };
    let _ = app.set_activation_policy(p);
}

#[cfg(not(target_os = "macos"))]
fn set_policy<R: Runtime>(_app: &AppHandle<R>, _accessory: bool) {}

pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    set_policy(app, false);
    if let Some(w) = app.get_webview_window(MAIN_LABEL) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

pub fn hide_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window(MAIN_LABEL) {
        let _ = w.hide();
    }
    set_policy(app, true);
}

/// Shared by the native menu and the tray: show the main window, then emit `menu-action` to it.
pub fn dispatch_menu_action<R: Runtime>(app: &AppHandle<R>, action: MenuAction) {
    show_main(app);
    let _ = app.emit_to(MAIN_LABEL, EVENT_MENU_ACTION, MenuActionEvent { action });
}

/// `show_main_window { repoPath }`.
pub fn show_main_window<R: Runtime>(app: &AppHandle<R>, repo_path: Option<String>) {
    show_main(app);
    if let Some(path) = repo_path {
        let _ = app.emit_to(MAIN_LABEL, EVENT_OPEN_REPO_REQUEST, OpenRepoRequestEvent { path });
    }
}

/// Close request on the main window. Returns true when the close was turned into a hide.
pub fn on_main_close_requested<R: Runtime>(app: &AppHandle<R>) -> bool {
    let Some(state) = app.try_state::<AppState>() else { return false };
    if !keeps_running(&state.persist.settings()) {
        return false;
    }
    hide_main(app);
    if state.persist.take_hidden_notice() {
        let lang = crate::app::settings::effective_lang(&state.persist.settings());
        let (title, body) = super::model::strings(lang).hidden_notice;
        super::notify(app, title, body);
    }
    true
}
