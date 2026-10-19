use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    GitNotFound,
    NotARepo,
    GitFailed,
    SnapshotExpired,
    InvalidArgument,
    NotFullyMerged,
    NonFastForward,
    NoUpstream,
    WouldOverwrite,
    AuthFailed,
    Busy,
    PushRejected,
    StaleLease,
    DirtyWorktree,
    NothingToCommit,
    UnmergedFiles,
    PatchFailed,
    UpdateFailed,
    Io,
    Internal,
}

#[derive(Debug, Clone, Serialize, Deserialize, thiserror::Error)]
#[error("{message}")]
pub struct AppError {
    pub code: ErrorCode,
    pub message: String,
    pub stderr: Option<String>,
}

pub type Result<T> = std::result::Result<T, AppError>;

impl AppError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        AppError { code, message: message.into(), stderr: None }
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidArgument, message)
    }
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message)
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::new(ErrorCode::Io, e.to_string())
    }
}

/// Classify a failed git invocation by its output (run with LC_ALL=C). Callers pass stderr, or
/// stdout + stderr for commands that report failures on stdout (commit, push --porcelain).
pub fn classify_stderr(stderr: &str, exit_code: i32) -> AppError {
    let has = |needle: &str| stderr.contains(needle);
    let code = if has("not a git repository") || has("must be run in a work tree") || has("cannot change to") {
        ErrorCode::NotARepo
    } else if has("index.lock") || has("Another git process seems to be running") {
        ErrorCode::Busy
    } else if has("Authentication failed")
        || has("Permission denied (publickey)")
        || has("could not read Username")
        || has("could not read Password")
        || has("Host key verification failed")
        || has("Could not read from remote repository")
        || has("error: 401")
        || has("error: 403")
        || has("HTTP 401")
        || has("HTTP 403")
    {
        ErrorCode::AuthFailed
    } else if has("stale info") {
        ErrorCode::StaleLease
    } else if has("[rejected]") || (has("[remote rejected]") && has("fetch first")) || has("Updates were rejected") {
        ErrorCode::PushRejected
    } else if has("Not possible to fast-forward") {
        ErrorCode::NonFastForward
    } else if has("would be overwritten by cherry-pick")
        || has("would be overwritten by revert")
        || has("would be overwritten by rebase")
        || has("Please commit or stash them")
        || has("You have unstaged changes")
        || has("Your index contains uncommitted changes")
    {
        ErrorCode::DirtyWorktree
    } else if has("would be overwritten") || has("already exists, no checkout") {
        ErrorCode::WouldOverwrite
    } else if has("no tracking information") {
        ErrorCode::NoUpstream
    } else if has("not fully merged") {
        ErrorCode::NotFullyMerged
    } else if has("unmerged files")
        || has("unresolved conflict")
        || has("must edit all merge conflicts")
        || has("needs merge")
    {
        ErrorCode::UnmergedFiles
    } else if has("nothing to commit") || has("no changes added to commit") || has("nothing added to commit") {
        ErrorCode::NothingToCommit
    } else if has("patch does not apply") || has("corrupt patch") || has("patch failed") {
        ErrorCode::PatchFailed
    } else {
        ErrorCode::GitFailed
    };
    let lines = || stderr.lines().map(str::trim).filter(|l| !l.is_empty());
    let pick = lines()
        .find(|l| l.starts_with("fatal: ") || l.starts_with("error: "))
        .or_else(|| lines().find(|l| l.contains("nothing to commit") || l.contains("no changes added")))
        .or_else(|| lines().next());
    let message = pick
        .map(|l| l.strip_prefix("fatal: ").or_else(|| l.strip_prefix("error: ")).unwrap_or(l).to_string())
        .unwrap_or_else(|| format!("git exited with code {exit_code}"));
    let message = if code == ErrorCode::Busy {
        "A git lock file exists (.git/index.lock): another git process may be running, or the lock is stale. \
         If no git operation is running, delete the lock file."
            .to_string()
    } else {
        message
    };
    AppError { code, message, stderr: Some(stderr.to_string()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies() {
        let c = |s: &str| classify_stderr(s, 1).code;
        assert_eq!(c("fatal: not a git repository (or any of the parent directories): .git"), ErrorCode::NotARepo);
        assert_eq!(c("fatal: Authentication failed for 'x'"), ErrorCode::AuthFailed);
        assert_eq!(c("fatal: unable to access 'https://x/': The requested URL returned error: 403"), ErrorCode::AuthFailed);
        assert_eq!(c("remote: HTTP 401 Unauthorized"), ErrorCode::AuthFailed);
        assert_eq!(c("Host key verification failed.\nfatal: Could not read from remote repository."), ErrorCode::AuthFailed);
        assert_eq!(c("git@github.com: Permission denied (publickey)."), ErrorCode::AuthFailed);
        assert!(classify_stderr("fatal: Unable to create '/r/.git/index.lock': File exists.", 128).message.contains("lock file"));
        assert_eq!(c("fatal: Not possible to fast-forward, aborting."), ErrorCode::NonFastForward);
        assert_eq!(c("error: Your local changes would be overwritten by checkout"), ErrorCode::WouldOverwrite);
        assert_eq!(c("There is no tracking information for the current branch."), ErrorCode::NoUpstream);
        assert_eq!(c("error: the branch 'x' is not fully merged"), ErrorCode::NotFullyMerged);
        assert_eq!(c("fatal: boom"), ErrorCode::GitFailed);
        assert_eq!(classify_stderr("fatal: boom\n", 1).message, "boom");
        assert_eq!(c("fatal: Unable to create '/r/.git/index.lock': File exists."), ErrorCode::Busy);
        assert_eq!(c("! [rejected] main -> main (non-fast-forward)\nerror: failed to push some refs"), ErrorCode::PushRejected);
        assert_eq!(c("! [rejected] main -> main (fetch first)"), ErrorCode::PushRejected);
        assert_eq!(c("! [rejected] main -> main (stale info)"), ErrorCode::StaleLease);
        assert_eq!(c("error: cannot rebase: You have unstaged changes.\nerror: Please commit or stash them."), ErrorCode::DirtyWorktree);
        assert_eq!(c("error: your local changes would be overwritten by cherry-pick."), ErrorCode::DirtyWorktree);
        assert_eq!(c("error: Your local changes to the following files would be overwritten by merge"), ErrorCode::WouldOverwrite);
        assert_eq!(c("On branch main\nnothing to commit, working tree clean"), ErrorCode::NothingToCommit);
        assert_eq!(c("no changes added to commit (use \"git add\")"), ErrorCode::NothingToCommit);
        assert_eq!(c("error: Committing is not possible because you have unmerged files."), ErrorCode::UnmergedFiles);
        assert_eq!(c("error: patch failed: a.txt:1\nerror: a.txt: patch does not apply"), ErrorCode::PatchFailed);
        assert_eq!(c("error: corrupt patch at line 5"), ErrorCode::PatchFailed);
    }
}
