//! Git process runner. Never goes through a shell.
use crate::error::{AppError, ErrorCode, Result, classify_stderr};
use std::ffi::OsStr;
use std::io::{Read, Write};
use std::sync::mpsc;
use std::time::{Duration, Instant};
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

/// A candidate counts only if `--version` really prints a git version (the macOS /usr/bin/git
/// shim fails when the command line tools are missing).
fn probe(p: &Path) -> bool {
    Command::new(p)
        .arg("--version")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map(|o| o.status.success() && o.stdout.starts_with(b"git version"))
        .unwrap_or(false)
}

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
        candidates.into_iter().find(|p| p.is_file() && probe(p))
    });
    found
        .as_deref()
        .ok_or_else(|| AppError::new(ErrorCode::GitNotFound, "git executable not found"))
}

const SCRUBBED_ENV: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CONFIG",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_NAMESPACE",
    "GIT_CEILING_DIRECTORIES",
];

fn command<S: AsRef<OsStr>>(repo: &str, args: &[S], read_only: bool) -> Result<Command> {
    let mut c = Command::new(git_path()?);
    for k in SCRUBBED_ENV {
        c.env_remove(k);
    }
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

/// Kill the child (and its process group on unix, so ssh/hook grandchildren release the pipes).
fn kill_tree(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .args(["-KILL", "--", &format!("-{}", child.id())])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

enum Chunk {
    Out(Vec<u8>),
    Err(Vec<u8>),
    OutDone,
    ErrDone,
}

fn pump<R: Read + Send + 'static>(mut r: R, tx: mpsc::Sender<Chunk>, err: bool) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        loop {
            match r.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let c = if err { Chunk::Err(buf[..n].to_vec()) } else { Chunk::Out(buf[..n].to_vec()) };
                    if tx.send(c).is_err() {
                        return;
                    }
                }
            }
        }
        let _ = tx.send(if err { Chunk::ErrDone } else { Chunk::OutDone });
    });
}

struct Limits {
    timeout: Option<Duration>,
    /// stop reading (and kill git) once stdout exceeds this many bytes
    max_stdout: Option<usize>,
}

/// Core executor: streams stdout/stderr through threads, enforces a deadline and a stdout cap.
/// Returns the output and whether stdout was cut at `max_stdout`. Never leaves the child running.
fn exec(mut c: Command, limits: Limits, on_line: &mut dyn FnMut(&str)) -> Result<(Output, bool)> {
    c.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        c.process_group(0);
    }
    let mut child = c.spawn()?;
    let (tx, rx) = mpsc::channel::<Chunk>();
    pump(child.stdout.take().expect("piped stdout"), tx.clone(), false);
    pump(child.stderr.take().expect("piped stderr"), tx, true);
    let deadline = limits.timeout.map(|t| Instant::now() + t);
    let (mut out, mut all_err, mut line) = (Vec::new(), Vec::new(), Vec::new());
    let (mut out_done, mut err_done, mut truncated) = (false, false, false);
    while !(out_done && err_done) {
        let msg = match deadline {
            None => rx.recv().map_err(|_| mpsc::RecvTimeoutError::Disconnected),
            Some(d) => rx.recv_timeout(d.saturating_duration_since(Instant::now())),
        };
        match msg {
            Ok(Chunk::Out(b)) => {
                out.extend_from_slice(&b);
                if let Some(max) = limits.max_stdout
                    && out.len() > max
                {
                    out.truncate(max);
                    truncated = true;
                    kill_tree(&mut child);
                    break;
                }
            }
            Ok(Chunk::Err(b)) => {
                all_err.extend_from_slice(&b);
                for &ch in &b {
                    if ch == b'\r' || ch == b'\n' {
                        if !line.is_empty() {
                            on_line(&String::from_utf8_lossy(&line));
                            line.clear();
                        }
                    } else {
                        line.push(ch);
                    }
                }
            }
            Ok(Chunk::OutDone) => out_done = true,
            Ok(Chunk::ErrDone) => err_done = true,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                kill_tree(&mut child);
                let secs = limits.timeout.map(|t| t.as_secs_f32()).unwrap_or(0.0);
                let mut e = AppError::new(ErrorCode::GitFailed, format!("git timed out after {secs:.0}s and was stopped"));
                e.stderr = Some(String::from_utf8_lossy(&all_err).into_owned());
                return Err(e);
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    if !line.is_empty() {
        on_line(&String::from_utf8_lossy(&line));
    }
    let status = child.wait()?;
    Ok((
        Output {
            stdout: out,
            stderr: String::from_utf8_lossy(&all_err).into_owned(),
            code: if truncated { 0 } else { status.code().unwrap_or(-1) },
        },
        truncated,
    ))
}

/// Streaming variant: stderr is split on `\r`/`\n` and each non-empty line is passed to `on_line`.
/// `timeout` kills git after the deadline and fails with `gitFailed`. `network` adds a
/// non-interactive ssh default unless the user configured their own.
pub fn run_stream<S: AsRef<OsStr>>(
    repo: &str,
    args: &[S],
    timeout: Duration,
    network: bool,
    on_line: &mut dyn FnMut(&str),
) -> Result<Output> {
    let mut c = command(repo, args, false)?;
    if network
        && std::env::var_os("GIT_SSH_COMMAND").is_none()
        && std::env::var_os("GIT_SSH").is_none()
        && !run_raw(repo, &["config", "--get", "core.sshCommand"], true).map(|o| o.ok()).unwrap_or(false)
    {
        c.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
    }
    let (o, _) = exec(c, Limits { timeout: Some(timeout), max_stdout: None }, on_line)?;
    check(o)
}

/// Read-only run that stops reading stdout after `max` bytes (killing git). Returns (output, truncated).
pub fn run_capped<S: AsRef<OsStr>>(repo: &str, args: &[S], max: usize) -> Result<(Output, bool)> {
    let c = command(repo, args, true)?;
    let (o, truncated) = exec(c, Limits { timeout: Some(Duration::from_secs(60)), max_stdout: Some(max) }, &mut |_| {})?;
    if truncated { Ok((o, true)) } else { check(o).map(|o| (o, false)) }
}

/// Reject values that git could interpret as options.
pub fn check_not_option(kind: &str, v: &str) -> Result<()> {
    if v.is_empty() || v.starts_with('-') || v.contains('\0') {
        Err(AppError::invalid(format!("invalid {kind}: {v:?}")))
    } else {
        Ok(())
    }
}

/// Full object ids only (40 hex sha1 / 64 hex sha256); returns the lowercase form.
pub fn norm_hash(v: &str) -> Result<String> {
    if matches!(v.len(), 40 | 64) && v.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(v.to_ascii_lowercase())
    } else {
        Err(AppError::invalid(format!("invalid commit hash: {v:?}")))
    }
}

pub fn check_hash(v: &str) -> Result<()> {
    norm_hash(v).map(|_| ())
}

pub fn empty_tree(repo: &str) -> Result<String> {
    let o = run_stdin(repo, &["hash-object", "-t", "tree", "--stdin"], Vec::new(), true)?;
    Ok(o.text().trim().to_string())
}
