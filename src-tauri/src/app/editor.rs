//! open_in_editor / reveal_in_finder. Paths must canonicalize inside the repository.
use crate::error::{AppError, Result};
use std::path::PathBuf;
use std::process::{Command, Stdio};

pub fn resolve_inside(repo: &str, path: &str) -> Result<PathBuf> {
    crate::git::runner::check_rel_path(path)?;
    let root = std::fs::canonicalize(repo)?;
    let full = std::fs::canonicalize(root.join(path))?;
    if !full.starts_with(&root) {
        return Err(AppError::invalid("path resolves outside the repository"));
    }
    Ok(full)
}

fn spawn(mut c: Command) -> Result<()> {
    c.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    c.spawn().map(|mut ch| {
        std::thread::spawn(move || {
            let _ = ch.wait();
        });
    })?;
    Ok(())
}

pub fn open_in_editor(repo: &str, path: &str, editor: Option<&str>) -> Result<()> {
    let full = resolve_inside(repo, path)?;
    let mut c = Command::new("open");
    if let Some(app) = editor.map(str::trim).filter(|e| !e.is_empty()) {
        if app.starts_with('-') {
            return Err(AppError::invalid("invalid external editor"));
        }
        c.args(["-a", app]);
    }
    c.arg("--").arg(&full);
    spawn(c)
}

pub fn reveal_in_finder(repo: &str, path: &str) -> Result<()> {
    let full = resolve_inside(repo, path)?;
    let mut c = Command::new("open");
    c.arg("-R").arg("--").arg(&full);
    spawn(c)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_escape() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.txt"), "x").unwrap();
        let repo = d.path().to_str().unwrap();
        assert!(resolve_inside(repo, "a.txt").is_ok());
        assert!(resolve_inside(repo, "../a.txt").is_err());
        assert!(resolve_inside(repo, "/etc/hosts").is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/etc/hosts", d.path().join("link")).unwrap();
            assert!(resolve_inside(repo, "link").is_err());
        }
    }
}
