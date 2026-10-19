pub mod app;
pub mod commands;
pub mod error;
pub mod git;
pub mod menu;
pub mod models;
pub mod persist;
pub mod snapshot;
pub mod state;
pub mod tray;
pub mod watcher;

use crate::models::QUICK_COMMIT_WINDOW_LABEL;
use tauri::{AppHandle, Manager, WindowEvent};

/// (Re)builds the native menu in the language chosen by the settings.
pub fn apply_menu_language(app: &AppHandle) {
    let Some(state) = app.try_state::<state::AppState>() else { return };
    let lang = app::settings::effective_lang(&state.persist.settings());
    if let Ok(menu) = menu::build(app, lang) {
        let _ = app.set_menu(menu);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_positioner::init())
        .on_menu_event(|app, ev| {
            if let Some(action) = menu::action_for_id(ev.id().as_ref()) {
                tray::lifecycle::dispatch_menu_action(app, action);
            }
        })
        .on_window_event(|window, event| {
            let app = window.app_handle();
            match (window.label(), event) {
                (tray::lifecycle::MAIN_LABEL, WindowEvent::CloseRequested { api, .. }) => {
                    if tray::lifecycle::on_main_close_requested(app) {
                        api.prevent_close();
                    }
                }
                // the hidden quick-commit window must not keep the app alive after the main window closes
                (tray::lifecycle::MAIN_LABEL, WindowEvent::Destroyed) => app.exit(0),
                (QUICK_COMMIT_WINDOW_LABEL, WindowEvent::Focused(false)) => {
                    if let Some(t) = app.try_state::<tray::Tray>() {
                        tray::quick_window::on_blur(app, &t.quick);
                    }
                }
                _ => {}
            }
        })
        .setup(|app| {
            let file = app.path().app_config_dir().ok().map(|d| d.join("state.json"));
            let st = state::AppState::new(file);
            let settings = st.persist.settings();
            app::settings::apply_git_path(&settings);
            app.manage(st);
            // resolve the login-shell PATH once, off the main thread (2 s timeout)
            std::thread::spawn(|| {
                git::runner::login_path();
            });
            app::updater::register(app.handle());
            apply_menu_language(app.handle());
            tray::init(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_repo,
            commands::close_repo,
            commands::get_recent_repos,
            commands::get_system_locale,
            commands::remove_recent_repo,
            commands::get_refs,
            commands::set_favorite,
            commands::load_log,
            commands::release_snapshot,
            commands::get_commit_rows,
            commands::filter_commits,
            commands::get_authors,
            commands::get_commit_details,
            commands::get_containing_refs,
            commands::get_signatures,
            commands::get_changed_files,
            commands::get_file_diff,
            commands::get_file_history,
            commands::get_blame,
            commands::list_files,
            commands::validate_branch_name,
            commands::checkout,
            commands::fetch,
            commands::pull,
            commands::create_branch,
            commands::delete_branch,
            commands::get_status,
            commands::stage_files,
            commands::unstage_files,
            commands::discard_files,
            commands::apply_patch,
            commands::commit,
            commands::resolve_conflict,
            commands::open_in_editor,
            commands::reveal_in_finder,
            commands::get_push_preview,
            commands::push,
            commands::list_stashes,
            commands::stash_save,
            commands::stash_apply,
            commands::stash_drop,
            commands::merge,
            commands::rebase,
            commands::control_operation,
            commands::cherry_pick,
            commands::revert,
            commands::reset,
            commands::validate_tag_name,
            commands::create_tag,
            commands::delete_tag,
            commands::push_tag,
            commands::get_reflog,
            commands::compare_refs,
            commands::get_line_history,
            commands::get_settings,
            commands::set_settings,
            commands::validate_git_path,
            commands::get_diagnostics,
            commands::check_for_update,
            commands::install_update,
            commands::restart_app,
            commands::get_repo_summaries,
            commands::open_quick_commit,
            commands::show_main_window,
            commands::get_quick_commit_target,
            commands::set_quick_commit_busy,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            // Dock click while the window is hidden in the menu bar: back to a regular app.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                tray::lifecycle::show_main(_app);
            }
        });
}
