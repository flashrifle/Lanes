//! Git process runner. Never goes through a shell.
use crate::error::{AppError, ErrorCode, Result, classify_stderr};
use std::ffi::OsStr;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;

pub struct Output {
    pub stdout: Vec<u8>,
    pub stderr: String,
    pub code: i32,
}

impl Output {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
    pub fn ok(&self) -> bool {
        self.code == 0
    }
    /// stdout + stderr trimmed, for toast messages.
    pub fn summary(&self) -> String {
        let out = self.text();
        let mut s = String::new();
        for part in [out.trim(), self.stderr.trim()] {
            if !part.is_empty() {
                if !s.is_empty() {
                    s.push('\n');
                }
                s.push_str(part);
            }
        }
        s
    }
}

static GIT: OnceLock<Option<PathBuf>> = OnceLock::new();

pub fn git_path() -> Result<&'static Path> {
    let found = GIT.get_or_init(|| {
        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Some(p) = std::env::var_os("GIT_LOG_VIEWER_GIT") {
            candidates.push(PathBuf::from(p));
        }
        for p in ["/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git"] {
            candidates.push(PathBuf::from(p));
        }
        if let Some(path) = std::env::var_os("PATH") {
            for d in std::env::split_paths(&path) {
                candidates.push(d.join("git"));
            }
        }
        candidates.into_iter().find(|p| p.is_file())
    });
    found
        .as_deref()
        .ok_or_else(|| AppError::new(ErrorCode::GitNotFound, "git executable not found"))
}

fn command<S: AsRef<OsStr>>(repo: &str, args: &[S], read_only: bool) -> Result<Command> {
    let mut c = Command::new(git_path()?);
    c.args(["-C", repo, "-c", "core.quotepath=false", "-c", "color.ui=false", "-c", "log.showSignature=false"]);
    c.args(args);
    c.env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .env("GIT_EDITOR", "true")
        .env("GIT_MERGE_AUTOEDIT", "no")
        .stdin(Stdio::null());
    if read_only {
        c.env("GIT_OPTIONAL_LOCKS", "0");
    }
    Ok(c)
}

fn to_output(o: std::process::Output) -> Output {
    Output {
        stdout: o.stdout,
        stderr: String::from_utf8_lossy(&o.stderr).into_owned(),
        code: o.status.code().unwrap_or(-1),
    }
}

/// Run git; returns the output whatever the exit code.
pub fn run_raw<S: AsRef<OsStr>>(repo: &str, args: &[S], read_only: bool) -> Result<Output> {
    let mut c = command(repo, args, read_only)?;
    Ok(to_output(c.output()?))
}

/// Run git; non-zero exit becomes a classified error.
pub fn run<S: AsRef<OsStr>>(repo: &str, args: &[S], read_only: bool) -> Result<Output> {
    let o = run_raw(repo, args, read_only)?;
    check(o)
}

fn check(o: Output) -> Result<Output> {
    if o.ok() { Ok(o) } else { Err(classify_stderr(&o.stderr, o.code)) }
}

/// Run git with `input` on stdin; returns output whatever the exit code.
pub fn run_stdin_raw<S: AsRef<OsStr>>(repo: &str, args: &[S], input: Vec<u8>, read_only: bool) -> Result<Output> {
    let mut c = command(repo, args, read_only)?;
    c.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = c.spawn()?;
    let mut stdin = child.stdin.take().expect("piped stdin");
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(&input);
    });
    let out = child.wait_with_output()?;
    let _ = writer.join();
    Ok(to_output(out))
}

pub fn run_stdin<S: AsRef<OsStr>>(repo: &str, args: &[S], input: Vec<u8>, read_only: bool) -> Result<Output> {
    check(run_stdin_raw(repo, args, input, read_only)?)
}

/// Streaming variant: stderr is split on `\r`/`\n` and each non-empty line is passed to `on_line`.
pub fn run_stream<S: AsRef<OsStr>>(repo: &str, args: &[S], on_line: &mut dyn FnMut(&str)) -> Result<Output> {
    let mut c = command(repo, args, false)?;
    c.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = c.spawn()?;
    let mut stdout = child.stdout.take().expect("piped stdout");
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    let mut stderr = child.stderr.take().expect("piped stderr");
    let mut all = Vec::new();
    let mut line = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let n = match stderr.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        all.extend_from_slice(&chunk[..n]);
        for &b in &chunk[..n] {
            if b == b'\r' || b == b'\n' {
                if !line.is_empty() {
                    on_line(&String::from_utf8_lossy(&line));
                    line.clear();
                }
            } else {
                line.push(b);
            }
        }
    }
    if !line.is_empty() {
        on_line(&String::from_utf8_lossy(&line));
    }
    let status = child.wait()?;
    let out = reader.join().unwrap_or_default();
    check(Output {
        stdout: out,
        stderr: String::from_utf8_lossy(&all).into_owned(),
        code: status.code().unwrap_or(-1),
    })
}

/// Reject values that git could interpret as options.
pub fn check_not_option(kind: &str, v: &str) -> Result<()> {
    if v.is_empty() || v.starts_with('-') || v.contains('\0') {
        Err(AppError::invalid(format!("invalid {kind}: {v:?}")))
    } else {
        Ok(())
    }
}

pub fn check_hash(v: &str) -> Result<()> {
    if (4..=64).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(AppError::invalid(format!("invalid commit hash: {v:?}")))
    }
}

pub fn empty_tree(repo: &str) -> Result<String> {
    let o = run_stdin(repo, &["hash-object", "-t", "tree", "--stdin"], Vec::new(), true)?;
    Ok(o.text().trim().to_string())
}
