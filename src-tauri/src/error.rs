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

/// Classify a failed git invocation by its stderr (run with LC_ALL=C).
pub fn classify_stderr(stderr: &str, exit_code: i32) -> AppError {
    let code = if stderr.contains("not a git repository")
        || stderr.contains("must be run in a work tree")
        || stderr.contains("cannot change to")
    {
        ErrorCode::NotARepo
    } else if stderr.contains("Authentication failed")
        || stderr.contains("Permission denied (publickey)")
        || stderr.contains("could not read Username")
        || stderr.contains("could not read Password")
    {
        ErrorCode::AuthFailed
    } else if stderr.contains("Not possible to fast-forward") {
        ErrorCode::NonFastForward
    } else if stderr.contains("would be overwritten") {
        ErrorCode::WouldOverwrite
    } else if stderr.contains("no tracking information") {
        ErrorCode::NoUpstream
    } else if stderr.contains("not fully merged") {
        ErrorCode::NotFullyMerged
    } else {
        ErrorCode::GitFailed
    };
    let message = stderr
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(|l| {
            l.strip_prefix("fatal: ")
                .or_else(|| l.strip_prefix("error: "))
                .unwrap_or(l)
                .to_string()
        })
        .unwrap_or_else(|| format!("git exited with code {exit_code}"));
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
        assert_eq!(c("fatal: Not possible to fast-forward, aborting."), ErrorCode::NonFastForward);
        assert_eq!(c("error: Your local changes would be overwritten by checkout"), ErrorCode::WouldOverwrite);
        assert_eq!(c("There is no tracking information for the current branch."), ErrorCode::NoUpstream);
        assert_eq!(c("error: the branch 'x' is not fully merged"), ErrorCode::NotFullyMerged);
        assert_eq!(c("fatal: boom"), ErrorCode::GitFailed);
        assert_eq!(classify_stderr("fatal: boom\n", 1).message, "boom");
    }
}
