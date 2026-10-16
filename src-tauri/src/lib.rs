pub mod commands;
pub mod error;
pub mod git;
pub mod menu;
pub mod models;
pub mod persist;
pub mod snapshot;
pub mod state;
pub mod watcher;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .menu(menu::build)
        .setup(|app| {
            let file = app.path().app_config_dir().ok().map(|d| d.join("state.json"));
            app.manage(state::AppState::new(file));
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
            commands::validate_branch_name,
            commands::checkout,
            commands::fetch,
            commands::pull,
            commands::create_branch,
            commands::delete_branch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
