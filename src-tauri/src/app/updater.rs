//! Auto-update via tauri-plugin-updater. The plugin is registered only when `plugins.updater.pubkey`
//! is a real key (the repo ships a placeholder until the release key exists), so dev builds run fine.
use crate::error::{AppError, ErrorCode, Result};
use crate::models::*;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_updater::{Update, UpdaterExt};

pub const PLACEHOLDER_PUBKEY: &str = "REPLACE_WITH_UPDATER_PUBKEY";

pub type Pending = Arc<Mutex<Option<Update>>>;

fn fail(msg: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::UpdateFailed, msg)
}

pub fn pubkey_is_real(pubkey: Option<&str>) -> bool {
    pubkey.map(str::trim).is_some_and(|k| !k.is_empty() && k != PLACEHOLDER_PUBKEY)
}

fn configured_pubkey<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|v| v.get("pubkey"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

/// Registers the updater plugin when a real pubkey is configured. Returns whether it is available.
pub fn register<R: Runtime>(app: &AppHandle<R>) -> bool {
    if !pubkey_is_real(configured_pubkey(app).as_deref()) {
        return false;
    }
    app.plugin(tauri_plugin_updater::Builder::new().build()).is_ok()
}

fn rfc3339(d: time::OffsetDateTime) -> Option<String> {
    d.format(&time::format_description::well_known::Rfc3339).ok()
}

pub async fn check<R: Runtime>(app: &AppHandle<R>, pending: &Pending) -> Result<Option<UpdateInfo>> {
    if !pubkey_is_real(configured_pubkey(app).as_deref()) {
        return Err(fail("Updates are not available in this build: no update signing key is configured."));
    }
    #[allow(unused_mut)]
    let mut builder = app.updater_builder();
    #[cfg(debug_assertions)]
    if let Ok(url) = std::env::var("LANES_UPDATER_ENDPOINT") {
        let u: url::Url = url.parse().map_err(|e| fail(format!("invalid LANES_UPDATER_ENDPOINT: {e}")))?;
        builder = builder.endpoints(vec![u]).map_err(|e| fail(e.to_string()))?;
    }
    let updater = builder.build().map_err(|e| fail(e.to_string()))?;
    let found = updater.check().await.map_err(|e| fail(format!("update check failed: {e}")))?;
    let mut slot = pending.lock().unwrap_or_else(|p| p.into_inner());
    match found {
        None => {
            *slot = None;
            Ok(None)
        }
        Some(u) => {
            let info = UpdateInfo {
                version: u.version.clone(),
                current_version: u.current_version.clone(),
                notes: u.body.clone(),
                pub_date: u.date.and_then(rfc3339),
            };
            *slot = Some(u);
            Ok(Some(info))
        }
    }
}

pub async fn install<R: Runtime>(app: &AppHandle<R>, pending: &Pending) -> Result<()> {
    let update = pending
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take()
        .ok_or_else(|| AppError::invalid("no update has been found; check for updates first"))?;
    let total = Arc::new(Mutex::new(0u64));
    let app_chunk = app.clone();
    let app_done = app.clone();
    let total_chunk = total.clone();
    let result = update
        .download_and_install(
            move |n, len| {
                let mut t = total_chunk.lock().unwrap_or_else(|p| p.into_inner());
                *t += n as u64;
                let _ = app_chunk.emit(
                    EVENT_UPDATE_PROGRESS,
                    UpdateProgressEvent { downloaded: *t, total: len, finished: false },
                );
            },
            move || {
                let _ = app_done.emit(
                    EVENT_UPDATE_PROGRESS,
                    UpdateProgressEvent { downloaded: 0, total: None, finished: true },
                );
            },
        )
        .await;
    if let Err(e) = result {
        // keep the update so the user can retry without a fresh check
        *pending.lock().unwrap_or_else(|p| p.into_inner()) = Some(update);
        return Err(fail(format!("update install failed: {e}")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pubkey_detection() {
        assert!(!pubkey_is_real(None));
        assert!(!pubkey_is_real(Some("")));
        assert!(!pubkey_is_real(Some(PLACEHOLDER_PUBKEY)));
        assert!(pubkey_is_real(Some("dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWdu")));
    }
}
