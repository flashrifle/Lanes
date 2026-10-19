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

/// True when the repo-relative path points into a `.git` directory (never opened as a document).
pub fn is_inside_git_dir(path: &str) -> bool {
    std::path::Path::new(path).components().any(|c| c.as_os_str() == ".git")
}

/// Opens with the configured app, else the default text editor (`open -t`), so a file is never
/// handed to its default handler (an executable script would otherwise be run).
pub fn open_in_editor(repo: &str, path: &str, editor: Option<&str>) -> Result<()> {
    if is_inside_git_dir(path) {
        return Err(AppError::invalid("files inside .git cannot be opened"));
    }
    let full = resolve_inside(repo, path)?;
    if full.strip_prefix(std::fs::canonicalize(repo)?).is_ok_and(|rel| is_inside_git_dir(&rel.to_string_lossy())) {
        return Err(AppError::invalid("files inside .git cannot be opened"));
    }
    let mut c = Command::new("open");
    match editor.map(str::trim).filter(|e| !e.is_empty()) {
        Some(app) => {
            if app.starts_with('-') {
                return Err(AppError::invalid("invalid external editor"));
            }
            c.args(["-a", app]);
        }
        None => {
            c.arg("-t");
        }
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
    fn git_dir_refused() {
        assert!(is_inside_git_dir(".git/config"));
        assert!(is_inside_git_dir("sub/.git/hooks/pre-commit"));
        assert!(!is_inside_git_dir("src/.gitignore"));
        assert!(!is_inside_git_dir(".github/workflows/ci.yml"));
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join(".git/hooks")).unwrap();
        std::fs::write(d.path().join(".git/hooks/pre-commit"), "x").unwrap();
        assert!(open_in_editor(d.path().to_str().unwrap(), ".git/hooks/pre-commit", None).is_err());
    }

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
