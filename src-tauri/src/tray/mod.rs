//! Menu bar (tray) icon, per-repo actions, repo-summaries event, Quick Commit window, background fetch.
pub mod background;
pub mod lifecycle;
pub mod model;
pub mod quick_window;
pub mod summary;

use crate::app::settings::effective_lang;
use crate::git::{ops, push};
use crate::menu::Lang;
use crate::models::*;
use crate::state::AppState;
use model::{GlobalAction, Item, RepoAction};
use std::sync::{Arc, Mutex};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};
use tauri::image::Image;
use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Emitter, Manager, Runtime};

pub const TRAY_ID: &str = "lanes-tray";
pub const REFRESH_DEBOUNCE: Duration = Duration::from_secs(1);

/// Managed state of the menu-bar feature.
pub struct Tray {
    tx: mpsc::Sender<()>,
    pub quick: quick_window::QuickState,
    pub bg: background::Background,
    repos: Mutex<Vec<RepoSummary>>,
    cache: Arc<summary::RecentCache>,
}

impl Tray {
    pub fn cache(&self) -> Arc<summary::RecentCache> {
        self.cache.clone()
    }
}

pub fn notify<R: Runtime>(app: &AppHandle<R>, title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
}

/// Ask for a (debounced, 1 s) summaries refresh + tray menu rebuild.
pub fn poke<R: Runtime>(app: &AppHandle<R>) {
    if let Some(t) = app.try_state::<Tray>() {
        let _ = t.tx.send(());
    }
}

fn lang_of<R: Runtime>(app: &AppHandle<R>) -> Lang {
    app.try_state::<AppState>().map(|s| effective_lang(&s.persist.settings())).unwrap_or(Lang::En)
}

fn build_menu<R: Runtime>(app: &AppHandle<R>, items: &[Item]) -> tauri::Result<Menu<R>> {
    let mut mb = MenuBuilder::new(app);
    for item in items {
        match item {
            Item::Repo { index, title, info, actions } => {
                let mut sb = SubmenuBuilder::new(app, title);
                if let Some(info) = info {
                    sb = sb.item(&MenuItemBuilder::new(info).enabled(false).build(app)?).separator();
                }
                for (a, label) in actions {
                    sb = sb.text(model::repo_item_id(*index, *a), label);
                }
                mb = mb.item(&sb.build()?);
            }
            Item::Empty(t) => mb = mb.item(&MenuItemBuilder::new(t).enabled(false).build(app)?),
            Item::Separator => mb = mb.separator(),
            Item::Global(a, label) => mb = mb.text(model::global_item_id(*a), label),
        }
    }
    mb.build()
}

fn unix_now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn rebuild_menu<R: Runtime>(app: &AppHandle<R>, repos: &[RepoSummary]) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    let items = model::build_model(repos, lang_of(app), unix_now());
    if let Ok(menu) = build_menu(app, &items) {
        let _ = tray.set_menu(Some(menu));
    }
    // Totals next to the icon so pending pulls/pushes are visible without opening the menu.
    let _ = tray.set_title(model::tray_title(repos).as_deref());
}

fn refresh<R: Runtime>(app: &AppHandle<R>) {
    let (Some(state), Some(tray)) = (app.try_state::<AppState>(), app.try_state::<Tray>()) else { return };
    let summaries = summary::collect(&state, &tray.cache);
    *tray.repos.lock().unwrap_or_else(|p| p.into_inner()) = summaries.clone();
    let _ = app.emit(EVENT_REPO_SUMMARIES, &summaries);
    rebuild_menu(app, &summaries);
}

fn make_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<TrayIcon<R>> {
    let icon = Image::from_bytes(include_bytes!("../../icons/tray-template@2x.png"))?;
    let items = model::build_model(&[], lang_of(app), unix_now());
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .icon_as_template(true)
        .menu(&build_menu(app, &items)?)
        .on_menu_event(|app, ev| handle_menu_event(app, ev.id().as_ref()))
        .on_tray_icon_event(|tray, ev| tauri_plugin_positioner::on_tray_event(tray.app_handle(), &ev))
        .build(app)
}

/// Create / remove the tray icon (and the hidden quick-commit window) according to settings.
pub fn apply_settings<R: Runtime>(app: &AppHandle<R>, s: &AppSettings) {
    let exists = app.tray_by_id(TRAY_ID).is_some();
    if s.menu_bar_icon && !exists {
        if make_tray(app).is_ok() {
            let _ = quick_window::ensure_window(app);
        }
    } else if !s.menu_bar_icon && exists {
        app.remove_tray_by_id(TRAY_ID);
        // without the icon a hidden app could not be reached any more
        lifecycle::show_main(app);
    }
    if let Some(t) = app.try_state::<Tray>() {
        t.bg.resume_all();
    }
    poke(app);
}

pub fn init<R: Runtime>(app: &AppHandle<R>) {
    let (tx, rx) = mpsc::channel::<()>();
    app.manage(Tray {
        tx,
        quick: quick_window::QuickState::default(),
        bg: background::Background::default(),
        repos: Mutex::new(Vec::new()),
        cache: Arc::new(summary::RecentCache::default()),
    });
    // debounced refresher
    let a = app.clone();
    std::thread::spawn(move || {
        while rx.recv().is_ok() {
            loop {
                match rx.recv_timeout(REFRESH_DEBOUNCE) {
                    Ok(()) => continue,
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            refresh(&a);
        }
    });
    // background fetch
    let a = app.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(background::TICK);
            let (Some(state), Some(tray)) = (a.try_state::<AppState>(), a.try_state::<Tray>()) else { continue };
            let lang = effective_lang(&state.persist.settings());
            let a2 = a.clone();
            let a3 = a.clone();
            tray.bg.tick(
                &state,
                Instant::now(),
                &mut |repo| notify(&a2, &repo_name(repo), model::strings(lang).auth_paused),
                &mut || poke(&a3),
            );
        }
    });
    let settings = app.state::<AppState>().persist.settings();
    apply_settings(app, &settings);
}

fn repo_name(path: &str) -> String {
    std::path::Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string())
}

fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    if let Some(action) = crate::menu::action_for_id(id) {
        lifecycle::dispatch_menu_action(app, action);
        return;
    }
    if let Some(g) = model::parse_global_item_id(id) {
        match g {
            GlobalAction::OpenLanes => lifecycle::show_main_window(app, None),
            GlobalAction::Settings => lifecycle::dispatch_menu_action(app, MenuAction::Settings),
            GlobalAction::CheckUpdates => lifecycle::dispatch_menu_action(app, MenuAction::CheckForUpdates),
            GlobalAction::Quit => app.exit(0),
        }
        return;
    }
    if let Some((index, action)) = model::parse_repo_item_id(id) {
        let path = app
            .try_state::<Tray>()
            .and_then(|t| t.repos.lock().unwrap_or_else(|p| p.into_inner()).get(index).map(|s| s.path.clone()));
        if let Some(path) = path {
            let app = app.clone();
            std::thread::spawn(move || run_repo_action(&app, &path, action));
        }
    }
}

fn run_repo_action<R: Runtime>(app: &AppHandle<R>, path: &str, action: RepoAction) {
    let Some(state) = app.try_state::<AppState>() else { return };
    let st = model::strings(lang_of(app));
    let name = repo_name(path);
    let report = |res: crate::error::Result<String>| match res {
        Ok(msg) => notify(app, &name, &msg),
        Err(e) if e.code == crate::error::ErrorCode::NonFastForward => notify(app, &name, st.non_ff_hint),
        Err(e) => notify(app, &name, &format!("{}: {}", st.failed, e.message)),
    };
    match action {
        RepoAction::OpenInLanes => lifecycle::show_main_window(app, Some(path.to_string())),
        RepoAction::QuickCommit => {
            if let Some(t) = app.try_state::<Tray>() {
                let _ = quick_window::open(app, &t.quick, path);
            }
        }
        RepoAction::Fetch => {
            report(ops::fetch(&state.locks, path, None, &mut |_| {}).map(|_| st.fetch_ok.to_string()));
            poke(app);
        }
        RepoAction::Pull => {
            report(ops::pull(&state.locks, path, PullMode::FfOnly, &mut |_| {}).map(|_| st.pull_ok.to_string()));
            poke(app);
        }
        RepoAction::Push => {
            let res = (|| {
                let pv = push::preview(path, None)?;
                let Some(remote) = pv.remote.clone() else {
                    return Ok(st.no_remote.to_string());
                };
                let req = PushRequest {
                    remote,
                    local_branch: pv.local_branch.clone(),
                    remote_branch: pv.remote_branch.clone(),
                    set_upstream: pv.upstream.is_none(),
                    force_with_lease: None, // never force from the tray
                    follow_tags: false,
                };
                push::push(&state.locks, path, &req, &mut |_| {}).map(|_| st.push_ok.to_string())
            })();
            report(res);
            poke(app);
        }
    }
}
