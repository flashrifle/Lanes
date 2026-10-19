//! Settings validation / application (pure parts testable without Tauri).
use crate::error::{AppError, Result};
use crate::git::runner;
use crate::menu::{Lang, lang_from_locale};
use crate::models::*;
use crate::persist::Persist;
use std::path::{Path, PathBuf};

pub const MIN_GIT: (u32, u32) = (2, 23);

fn version_at_least(v: &str, min: (u32, u32)) -> bool {
    let mut it = v.split('.').map(|p| p.chars().take_while(char::is_ascii_digit).collect::<String>());
    let major: u32 = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let minor: u32 = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    (major, minor) >= min
}

/// `path` None (or blank) = what auto-detect would pick.
pub fn validate_git_path(path: Option<&str>) -> GitPathCheck {
    let path = path.map(str::trim).filter(|p| !p.is_empty());
    let (resolved, version): (Option<PathBuf>, Option<String>) = match path {
        Some(p) => {
            let pb = PathBuf::from(p);
            if !pb.is_file() {
                return GitPathCheck { ok: false, path: None, version: None, message: Some(format!("not a file: {p}")) };
            }
            let v = runner::probe_version(&pb);
            (Some(pb), v)
        }
        None => match runner::auto_detect() {
            Some(pb) => {
                let v = runner::probe_version(&pb);
                (Some(pb), v)
            }
            None => (None, None),
        },
    };
    match (resolved, version) {
        (Some(pb), Some(v)) => {
            let message = (!version_at_least(&v, MIN_GIT)).then(|| "git >= 2.23 required".to_string());
            GitPathCheck { ok: true, path: Some(pb.to_string_lossy().into_owned()), version: Some(v), message }
        }
        (Some(pb), None) => GitPathCheck {
            ok: false,
            path: Some(pb.to_string_lossy().into_owned()),
            version: None,
            message: Some("this file does not behave like git (`--version` failed)".into()),
        },
        _ => GitPathCheck { ok: false, path: None, version: None, message: Some("git executable not found".into()) },
    }
}

pub fn validate(s: &AppSettings) -> Result<()> {
    if let Some(m) = s.background_fetch_minutes
        && ![15, 30, 60].contains(&m)
    {
        return Err(AppError::invalid("backgroundFetchMinutes must be 15, 30, 60 or null"));
    }
    if let Some(p) = s.git_path.as_deref().filter(|p| !p.trim().is_empty()) {
        let c = validate_git_path(Some(p));
        if !c.ok {
            return Err(AppError::invalid(c.message.unwrap_or_else(|| "invalid git path".into())));
        }
    }
    if let Some(e) = &s.external_editor
        && (e.starts_with('-') || e.contains('\0'))
    {
        return Err(AppError::invalid("invalid external editor"));
    }
    Ok(())
}

/// Normalizes blank strings to None.
pub fn normalize(mut s: AppSettings) -> AppSettings {
    s.git_path = s.git_path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
    s.external_editor = s.external_editor.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
    s
}

/// Applies the git path override (None = auto-detect).
pub fn apply_git_path(s: &AppSettings) {
    runner::set_git_override(s.git_path.as_deref().map(Path::new).map(Path::to_path_buf));
}

/// Validate, persist, apply the git path; returns the stored value.
pub fn store(persist: &Persist, settings: AppSettings) -> Result<AppSettings> {
    let s = normalize(settings);
    validate(&s)?;
    persist.set_settings(s.clone());
    apply_git_path(&s);
    Ok(s)
}

pub fn effective_lang(s: &AppSettings) -> Lang {
    match s.language {
        LanguageSetting::Ko => Lang::Ko,
        LanguageSetting::En => Lang::En,
        LanguageSetting::System => lang_from_locale(sys_locale::get_locale().as_deref()),
    }
}

/// The tray and the close-to-hide behaviour: keepRunningInMenuBar requires menuBarIcon.
pub fn keeps_running(s: &AppSettings) -> bool {
    s.menu_bar_icon && s.keep_running_in_menu_bar
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions() {
        assert!(version_at_least("2.50.1", MIN_GIT));
        assert!(version_at_least("2.23.0", MIN_GIT));
        assert!(!version_at_least("2.22.9", MIN_GIT));
        assert!(version_at_least("3.0", MIN_GIT));
        assert!(version_at_least("2.39.3.windows.1", MIN_GIT));
    }

    #[test]
    fn validation() {
        let mut s = AppSettings::default();
        assert!(validate(&s).is_ok());
        s.background_fetch_minutes = Some(20);
        assert!(validate(&s).is_err());
        s.background_fetch_minutes = Some(30);
        assert!(validate(&s).is_ok());
        s.git_path = Some("/definitely/not/git".into());
        assert!(validate(&s).is_err());
        assert!(!validate_git_path(Some("/definitely/not/git")).ok);
        assert!(validate_git_path(None).ok);
        assert!(keeps_running(&AppSettings::default()));
        let off = AppSettings { menu_bar_icon: false, ..Default::default() };
        assert!(!keeps_running(&off));
    }
}
