use crate::git::{repo, runner};
use crate::models::Diagnostics;

fn os_version() -> String {
    let v = std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());
    match v {
        Some(v) => format!("macOS {v}"),
        None => std::env::consts::OS.to_string(),
    }
}

pub fn diagnostics(app_version: &str) -> Diagnostics {
    Diagnostics {
        app_version: app_version.to_string(),
        os: os_version(),
        arch: std::env::consts::ARCH.to_string(),
        git_version: repo::git_version().ok(),
        git_path: runner::git_path().ok().map(|p| p.to_string_lossy().into_owned()),
        locale: sys_locale::get_locale(),
    }
}
