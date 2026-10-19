//! Git process runner. Never goes through a shell.
use crate::error::{AppError, ErrorCode, Result, classify_stderr};
use std::ffi::OsStr;
use std::io::{Read, Write};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{OnceLock, RwLock};

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

static GIT_AUTO: OnceLock<Option<PathBuf>> = OnceLock::new();
static GIT_OVERRIDE: RwLock<Option<PathBuf>> = RwLock::new(None);

/// `git --version` of a candidate ("2.50.1"), or None when it is not a working git (the macOS
/// /usr/bin/git shim fails when the command line tools are missing).
pub fn probe_version(p: &Path) -> Option<String> {
    let mut c = Command::new(p);
    c.arg("--version").stdin(Stdio::null());
    let (o, _) = exec(c, Limits { timeout: Some(Duration::from_secs(5)), max_stdout: Some(4096), stdin: None }, &mut |_| {}).ok()?;
    if !o.ok() || !o.stdout.starts_with(b"git version") {
        return None;
    }
    let text = String::from_utf8_lossy(&o.stdout);
    Some(text.split_whitespace().nth(2).unwrap_or("unknown").to_string())
}

/// What auto-detect picks: `GIT_LOG_VIEWER_GIT`, homebrew, /usr/local, /usr/bin, then PATH. Cached.
pub fn auto_detect() -> Option<PathBuf> {
    GIT_AUTO
        .get_or_init(|| {
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
            candidates.into_iter().find(|p| p.is_file() && probe_version(p).is_some())
        })
        .clone()
}

/// Settings override (`AppSettings.gitPath`). `None` returns to auto-detect.
pub fn set_git_override(p: Option<PathBuf>) {
    *GIT_OVERRIDE.write().unwrap_or_else(|e| e.into_inner()) = p;
}

pub fn git_override() -> Option<PathBuf> {
    GIT_OVERRIDE.read().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Lookup order: settings override, env `GIT_LOG_VIEWER_GIT`, the candidate list.
pub fn git_path() -> Result<PathBuf> {
    if let Some(p) = git_override() {
        return if p.is_file() {
            Ok(p)
        } else {
            Err(AppError::new(ErrorCode::GitNotFound, format!("configured git not found: {}", p.display())))
        };
    }
    auto_detect().ok_or_else(|| AppError::new(ErrorCode::GitNotFound, "git executable not found"))
}

pub const FALLBACK_PATH: &str = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
const LOGIN_PATH_BEGIN: &str = "__LANES_PATH_BEGIN__";
const LOGIN_PATH_END: &str = "__LANES_PATH_END__";
static LOGIN_PATH: OnceLock<String> = OnceLock::new();

/// Extracts PATH from the marked output of the login shell; None when markers/value are missing.
pub fn parse_login_path(out: &str) -> Option<String> {
    let start = out.rfind(LOGIN_PATH_BEGIN)? + LOGIN_PATH_BEGIN.len();
    let rest = &out[start..];
    let end = rest.find(LOGIN_PATH_END)?;
    let v = rest[..end].trim();
    (!v.is_empty() && !v.contains('\n')).then(|| v.to_string())
}

/// Appends the fallback directories that are missing so git, brew tools and /bin utilities are always reachable.
pub fn with_fallback_dirs(path: &str) -> String {
    let mut parts: Vec<&str> = path.split(':').filter(|p| !p.is_empty()).collect();
    for d in FALLBACK_PATH.split(':') {
        if !parts.contains(&d) {
            parts.push(d);
        }
    }
    parts.join(":")
}

fn resolve_login_path() -> String {
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| Path::new(s).is_absolute() && Path::new(s).is_file())
        .unwrap_or_else(|| "/bin/zsh".to_string());
    // Fixed command, no user input. `-i` so PATH edits in .zshrc (nvm, volta, husky setups) count.
    let mut c = Command::new(shell);
    c.args(["-ilc", "printf '%s%s%s' __LANES_PATH_BEGIN__ \"$PATH\" __LANES_PATH_END__"]).stdin(Stdio::null());
    let resolved = exec(c, Limits { timeout: Some(Duration::from_secs(2)), max_stdout: Some(1 << 20), stdin: None }, &mut |_| {})
        .ok()
        .filter(|(o, _)| o.ok())
        .and_then(|(o, _)| parse_login_path(&o.text()));
    match resolved {
        Some(p) => with_fallback_dirs(&p),
        None => FALLBACK_PATH.to_string(),
    }
}

/// PATH given to every git run. Resolved once (2 s timeout); call early at startup.
pub fn login_path() -> &'static str {
    LOGIN_PATH.get_or_init(resolve_login_path)
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
    // Always the login-shell PATH (git-lfs filters, smudge/clean drivers, credential helpers, hooks).
    c.env("PATH", login_path())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .env("GIT_EDITOR", "true")
        .env("GIT_MERGE_AUTOEDIT", "no")
        .stdin(Stdio::null());
    if read_only {
        c.env("GIT_OPTIONAL_LOCKS", "0");
    }
    Ok(c)
}

/// Run git; returns the output whatever the exit code.
pub fn run_raw<S: AsRef<OsStr>>(repo: &str, args: &[S], read_only: bool) -> Result<Output> {
    let c = command(repo, args, read_only)?;
    let (o, _) = exec(c, Limits { timeout: Some(READ_TIMEOUT), max_stdout: None, stdin: None }, &mut |_| {})?;
    Ok(o)
}

/// Deadline for runs that have no caller-supplied timeout (read-only queries, stdin helpers).
const READ_TIMEOUT: Duration = Duration::from_secs(120);
/// SIGTERM grace before SIGKILL when a deadline passes.
const KILL_GRACE: Duration = Duration::from_secs(3);

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
    let c = command(repo, args, read_only)?;
    let (o, _) = exec(c, Limits { timeout: Some(READ_TIMEOUT), max_stdout: None, stdin: Some(input) }, &mut |_| {})?;
    Ok(o)
}

/// Command output with stdout and stderr joined, for classifying commands that report errors on stdout.
impl Output {
    pub fn combined(&self) -> String {
        let mut s = self.text();
        if !s.is_empty() && !s.ends_with('\n') && !self.stderr.is_empty() {
            s.push('\n');
        }
        s.push_str(&self.stderr);
        s
    }
}

pub fn run_stdin<S: AsRef<OsStr>>(repo: &str, args: &[S], input: Vec<u8>, read_only: bool) -> Result<Output> {
    check(run_stdin_raw(repo, args, input, read_only)?)
}

/// Stop the child and its process group (so ssh/hook grandchildren release the pipes): SIGTERM first so
/// git can drop its lock files and hooks can clean up, SIGKILL after `grace` if it is still running.
fn kill_tree(child: &mut std::process::Child, grace: Duration) {
    #[cfg(unix)]
    fn signal_group(sig: &str, pid: u32) {
        let _ = Command::new("kill")
            .args([sig, "--", &format!("-{pid}")])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(unix)]
    if !grace.is_zero() {
        signal_group("-TERM", child.id());
        let end = Instant::now() + grace;
        while Instant::now() < end {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }
    #[cfg(unix)]
    signal_group("-KILL", child.id());
    #[cfg(not(unix))]
    let _ = grace;
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
    /// bytes written to the child's stdin (then closed); None = /dev/null
    stdin: Option<Vec<u8>>,
}

/// Core executor: streams stdout/stderr through threads, enforces a deadline and a stdout cap.
/// Returns the output and whether stdout was cut at `max_stdout`. Never leaves the child running.
fn exec(mut c: Command, mut limits: Limits, on_line: &mut dyn FnMut(&str)) -> Result<(Output, bool)> {
    c.stdout(Stdio::piped()).stderr(Stdio::piped());
    if limits.stdin.is_some() {
        c.stdin(Stdio::piped());
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        c.process_group(0);
    }
    let mut child = c.spawn()?;
    if let Some(input) = limits.stdin.take() {
        let mut stdin = child.stdin.take().expect("piped stdin");
        std::thread::spawn(move || {
            let _ = stdin.write_all(&input);
        });
    }
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
                    kill_tree(&mut child, Duration::ZERO);
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
                kill_tree(&mut child, KILL_GRACE);
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

fn apply_network(c: &mut Command, repo: &str) {
    if std::env::var_os("GIT_SSH_COMMAND").is_none()
        && std::env::var_os("GIT_SSH").is_none()
        && !run_raw(repo, &["config", "--get", "core.sshCommand"], true).map(|o| o.ok()).unwrap_or(false)
    {
        c.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
    }
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
    let o = run_opts(repo, args, Opts { timeout, network, hooks: false, stdin: None }, on_line)?;
    check(o)
}

/// Options for [`run_opts`].
pub struct Opts {
    pub timeout: Duration,
    /// non-interactive ssh default
    pub network: bool,
    /// informational: the op may run hooks (every git run already uses the login-shell PATH)
    pub hooks: bool,
    pub stdin: Option<Vec<u8>>,
}

/// General executor for write ops: optional stdin, timeout, streaming stderr lines, hook PATH.
/// Returns the output whatever the exit code (callers classify with [`check_all`] or inspect it);
/// a timeout is an error.
pub fn run_opts<S: AsRef<OsStr>>(repo: &str, args: &[S], o: Opts, on_line: &mut dyn FnMut(&str)) -> Result<Output> {
    let mut c = command(repo, args, false)?;
    if o.network {
        apply_network(&mut c, repo);
    }
    let (out, _) = exec(c, Limits { timeout: Some(o.timeout), max_stdout: None, stdin: o.stdin }, on_line)?;
    Ok(out)
}

/// Non-zero exit becomes an error classified from stdout + stderr.
pub fn check_all(o: Output) -> Result<Output> {
    if o.ok() {
        Ok(o)
    } else {
        let mut e = classify_stderr(&o.combined(), o.code);
        e.stderr = Some(o.combined());
        Err(e)
    }
}

/// Read-only run that stops reading stdout after `max` bytes (killing git). Returns (output, truncated).
pub fn run_capped<S: AsRef<OsStr>>(repo: &str, args: &[S], max: usize) -> Result<(Output, bool)> {
    run_capped_codes(repo, args, max, &[0])
}

/// Like [`run_capped`] but also accepts the listed exit codes (e.g. 1 for `diff --no-index`).
pub fn run_capped_codes<S: AsRef<OsStr>>(repo: &str, args: &[S], max: usize, ok_codes: &[i32]) -> Result<(Output, bool)> {
    let c = command(repo, args, true)?;
    let (o, truncated) = exec(c, Limits { timeout: Some(Duration::from_secs(60)), max_stdout: Some(max), stdin: None }, &mut |_| {})?;
    if truncated || ok_codes.contains(&o.code) { Ok((o, truncated)) } else { check(o).map(|o| (o, false)) }
}

/// Reject values that git could interpret as options.
pub fn check_not_option(kind: &str, v: &str) -> Result<()> {
    if v.is_empty() || v.starts_with('-') || v.contains('\0') {
        Err(AppError::invalid(format!("invalid {kind}: {v:?}")))
    } else {
        Ok(())
    }
}

/// A repo-relative path argument: non-empty, no NUL, not absolute, no `..` component.
pub fn check_rel_path(p: &str) -> Result<()> {
    if p.is_empty() || p.contains('\0') {
        return Err(AppError::invalid("empty or invalid path"));
    }
    let path = Path::new(p);
    if path.is_absolute()
        || path.components().any(|c| matches!(c, std::path::Component::ParentDir | std::path::Component::Prefix(_)))
    {
        return Err(AppError::invalid(format!("path must be inside the repository: {p:?}")));
    }
    Ok(())
}

/// A repo-relative path that names a file: like [`check_rel_path`] but a trailing `/` (directory) is refused.
pub fn check_file_path(p: &str) -> Result<()> {
    check_rel_path(p)?;
    if p.ends_with('/') {
        return Err(AppError::invalid(format!("expected a file path, not a directory: {p:?}")));
    }
    Ok(())
}

pub fn check_rel_paths(paths: &[String]) -> Result<()> {
    if paths.is_empty() {
        return Err(AppError::invalid("no paths given"));
    }
    paths.iter().try_for_each(|p| check_rel_path(p))
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
