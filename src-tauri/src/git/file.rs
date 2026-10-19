//! Per-file queries: history (`log --follow`), blame (`blame --porcelain`) and tracked file listing.
use super::changes::status_from_letter;
use super::runner::{check_not_option, run, run_capped, run_raw};
use crate::error::{AppError, Result};
use crate::models::*;
use std::collections::HashMap;

pub const HISTORY_CAP: usize = 5000;
pub const BLAME_LINE_CAP: usize = 50_000;
const BLAME_MAX_BYTES: usize = 128 * 1024 * 1024;

fn check_path(path: &str) -> Result<()> {
    if path.is_empty() || path.contains('\0') {
        return Err(AppError::invalid(format!("invalid path: {path:?}")));
    }
    Ok(())
}

// ───────────── history ─────────────

const HISTORY_FORMAT: &str = "--format=%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s";

/// Parses `git log -z --raw --numstat` output where every commit starts with `\x1e`.
///
/// `requested` is the path being followed; the "current" path is tracked across records (newest first) so
/// a commit that shows no file entry still gets a sensible path.
///
/// Robustness decision: a commit without any diff entry (e.g. a merge git kept because it is not TREESAME
/// to every parent, when the diff cannot be attributed) is KEPT with status `modified`, null stats and the
/// path being followed at that point, rather than dropped, so the history never silently skips a commit
/// that git reported.
pub fn parse_file_history(bytes: &[u8], requested: &str) -> Vec<FileHistoryEntry> {
    let text = String::from_utf8_lossy(bytes);
    let mut out = Vec::new();
    let mut cur = requested.to_string();
    for rec in text.split('\x1e') {
        if rec.trim().is_empty() {
            continue;
        }
        // header runs to the first NUL
        let (head, rest) = rec.split_once('\0').unwrap_or((rec, ""));
        let f: Vec<&str> = head.splitn(6, '\x1f').collect();
        if f.len() < 6 || f[0].is_empty() {
            continue;
        }
        let mut status = None;
        let mut path = None;
        let mut old_path: Option<String> = None;
        let mut stats: Option<Option<(u32, u32)>> = None;
        let mut toks = rest.split('\0').map(|t| t.trim_start_matches('\n')).filter(|t| !t.is_empty());
        while let Some(t) = toks.next() {
            if t.starts_with(':') {
                let letter = t.rsplit(' ').next().unwrap_or("");
                let st = status_from_letter(letter);
                let paths = match st {
                    FileStatus::Renamed | FileStatus::Copied => {
                        let (Some(o), Some(n)) = (toks.next(), toks.next()) else { break };
                        old_path = Some(o.to_string());
                        n
                    }
                    _ => {
                        let Some(p) = toks.next() else { break };
                        p
                    }
                };
                status = Some(st);
                path = Some(paths.to_string());
            } else {
                let n: Vec<&str> = t.splitn(3, '\t').collect();
                if n.len() < 3 {
                    continue;
                }
                if n[2].is_empty() {
                    toks.next();
                    toks.next();
                }
                stats = Some(match (n[0].parse::<u32>(), n[1].parse::<u32>()) {
                    (Ok(a), Ok(d)) => Some((a, d)),
                    _ => None,
                });
            }
        }
        let binary = matches!(stats, Some(None));
        let (additions, deletions) = match stats {
            Some(Some((a, d))) => (Some(a), Some(d)),
            _ => (None, None),
        };
        let entry_path = path.unwrap_or_else(|| cur.clone());
        cur = old_path.clone().unwrap_or_else(|| entry_path.clone());
        out.push(FileHistoryEntry {
            hash: f[0].to_string(),
            parents: f[1].split_whitespace().map(str::to_string).collect(),
            author_name: f[2].to_string(),
            author_email: f[3].to_string(),
            author_time: f[4].parse().unwrap_or(0),
            subject: f[5].to_string(),
            path: entry_path,
            old_path,
            status: status.unwrap_or(FileStatus::Modified),
            additions,
            deletions,
            binary,
        });
    }
    out
}

pub fn file_history(repo: &str, path: &str, rev: Option<&str>) -> Result<FileHistory> {
    check_path(path)?;
    let rev = rev.unwrap_or("HEAD");
    check_not_option("rev", rev)?;
    let max = format!("--max-count={}", HISTORY_CAP + 1);
    let args = [
        "--literal-pathspecs",
        "log",
        "-z",
        "--follow",
        "-M",
        "--no-ext-diff",
        "--diff-merges=first-parent",
        "--raw",
        "--numstat",
        max.as_str(),
        HISTORY_FORMAT,
        rev,
        "--",
        path,
    ];
    let o = run_raw(repo, &args, true)?;
    if !o.ok() {
        // Unborn HEAD: no history rather than an error.
        if rev == "HEAD" && run_raw(repo, &["rev-parse", "--verify", "-q", "HEAD"], true)?.code != 0 {
            return Ok(FileHistory { path: path.to_string(), entries: Vec::new(), truncated: false });
        }
        return Err(crate::error::classify_stderr(&o.stderr, o.code));
    }
    let mut entries = parse_file_history(&o.stdout, path);
    let truncated = entries.len() > HISTORY_CAP;
    entries.truncate(HISTORY_CAP);
    Ok(FileHistory { path: path.to_string(), entries, truncated })
}

// ───────────── blame ─────────────

#[derive(Default)]
struct Info {
    author_name: String,
    author_email: String,
    author_time: i64,
    summary: String,
    boundary: bool,
    filename: String,
}

fn parse_header(l: &str) -> Option<(String, u32)> {
    let mut it = l.split(' ');
    let h = it.next()?;
    if !(h.len() == 40 || h.len() == 64) || !h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let orig = it.next()?.parse().ok()?;
    it.next()?.parse::<u32>().ok()?;
    Some((h.to_string(), orig))
}

/// Parses `git blame --porcelain`. Returns (lines, commits, truncated at `cap` lines).
pub fn parse_blame_porcelain(bytes: &[u8], cap: usize) -> (Vec<BlameLine>, Vec<BlameCommit>, bool) {
    let mut infos: HashMap<String, Info> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    let mut lines: Vec<BlameLine> = Vec::new();
    let mut cur: Option<(String, u32)> = None;
    let mut truncated = false;
    for raw in bytes.split(|&b| b == b'\n') {
        if raw.first() == Some(&b'\t') {
            let Some((hash, orig)) = cur.take() else { continue };
            if lines.len() >= cap {
                truncated = true;
                break;
            }
            let t = String::from_utf8_lossy(&raw[1..]);
            let t = t.strip_suffix('\r').unwrap_or(&t).to_string();
            let orig_path = infos.get(&hash).map(|i| i.filename.clone()).unwrap_or_default();
            lines.push(BlameLine { hash, orig_line: orig, orig_path, text: t });
            continue;
        }
        let l = String::from_utf8_lossy(raw);
        if cur.is_none() {
            if let Some((h, orig)) = parse_header(&l) {
                if !infos.contains_key(&h) {
                    infos.insert(h.clone(), Info::default());
                    order.push(h.clone());
                }
                cur = Some((h, orig));
            }
            continue;
        }
        let (h, _) = cur.as_ref().expect("checked");
        let info = infos.get_mut(h).expect("inserted");
        let (k, v) = l.split_once(' ').unwrap_or((&l, ""));
        match k {
            "author" => info.author_name = v.to_string(),
            "author-mail" => info.author_email = v.trim().trim_start_matches('<').trim_end_matches('>').to_string(),
            "author-time" => info.author_time = v.trim().parse().unwrap_or(0),
            "summary" => info.summary = v.to_string(),
            "boundary" => info.boundary = true,
            "filename" => info.filename = v.to_string(),
            _ => {}
        }
    }
    let commits = order
        .into_iter()
        .map(|h| {
            let i = infos.remove(&h).unwrap_or_default();
            BlameCommit {
                hash: h,
                author_name: i.author_name,
                author_email: i.author_email,
                author_time: i.author_time,
                subject: i.summary,
                boundary: i.boundary,
            }
        })
        .collect::<Vec<_>>();
    // drop commits only referenced by lines beyond the cap (none can exist: infos are added with their first line)
    let used: std::collections::HashSet<&str> = lines.iter().map(|l| l.hash.as_str()).collect();
    let commits = commits.into_iter().filter(|c| used.contains(c.hash.as_str())).collect();
    (lines, commits, truncated)
}

/// NUL byte in the first 8 KiB, like git's own heuristic.
pub fn looks_binary(head: &[u8]) -> bool {
    head.iter().take(8000).any(|&b| b == 0)
}

pub fn blame(repo: &str, path: &str, rev: &str) -> Result<BlameResult> {
    check_path(path)?;
    check_not_option("rev", rev)?;
    let empty = |binary| BlameResult {
        path: path.to_string(),
        rev: rev.to_string(),
        lines: Vec::new(),
        commits: Vec::new(),
        binary,
        truncated: false,
    };
    // Binary check on the blob first (errors out cleanly if the path does not exist at rev).
    let spec = format!("{rev}:{path}");
    let (head, _) = run_capped(repo, &["cat-file", "blob", spec.as_str()], 8192)?;
    if looks_binary(&head.stdout) {
        return Ok(empty(true));
    }
    let (o, cut) = run_capped(repo, &["blame", "--porcelain", rev, "--", path], BLAME_MAX_BYTES)?;
    let (lines, commits, truncated) = parse_blame_porcelain(&o.stdout, BLAME_LINE_CAP);
    Ok(BlameResult {
        path: path.to_string(),
        rev: rev.to_string(),
        lines,
        commits,
        binary: false,
        truncated: truncated || cut,
    })
}

// ───────────── list files ─────────────

pub fn list_files(repo: &str, rev: Option<&str>) -> Result<Vec<String>> {
    let rev = rev.unwrap_or("HEAD");
    check_not_option("rev", rev)?;
    if rev == "HEAD" && run_raw(repo, &["rev-parse", "--verify", "-q", "HEAD"], true)?.code != 0 {
        return Ok(Vec::new()); // unborn
    }
    let o = run(repo, &["ls-tree", "-r", "--name-only", "-z", rev], true)?;
    let mut v: Vec<String> = String::from_utf8_lossy(&o.stdout)
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    v.sort();
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_parses_rename_binary_and_empty() {
        let (a, b, c, d) = ("a".repeat(40), "b".repeat(40), "c".repeat(40), "d".repeat(40));
        let data = format!(
            "\x1e{a}\x1f{b}\x1fAl\x1fal@x\x1f300\x1ffour\0\n:100644 100644 1 2 M\0new.txt\x001\t2\tnew.txt\0\
             \x1e{b}\x1f{c}\x1fAl\x1fal@x\x1f200\x1fthree\0\n:100644 100644 1 1 R100\0old.txt\0new.txt\x000\t0\t\0old.txt\0new.txt\0\
             \x1e{c}\x1f{d} {a}\x1fAl\x1fal@x\x1f150\x1fmerge\0\
             \x1e{d}\x1f\x1fBo\x1fbo@x\x1f100\x1fadd\x1f x\0\n:000000 100644 0 1 A\0old.txt\0-\t-\told.txt\0"
        );
        let r = parse_file_history(data.as_bytes(), "new.txt");
        assert_eq!(r.len(), 4);
        assert_eq!((r[0].status, r[0].path.as_str(), r[0].additions, r[0].deletions), (FileStatus::Modified, "new.txt", Some(1), Some(2)));
        assert_eq!(r[1].status, FileStatus::Renamed);
        assert_eq!(r[1].old_path.as_deref(), Some("old.txt"));
        assert_eq!(r[1].additions, Some(0));
        assert_eq!(r[2].parents.len(), 2);
        assert_eq!(r[2].status, FileStatus::Modified);
        assert_eq!(r[2].path, "old.txt"); // tracked path carried over the rename
        assert_eq!(r[2].additions, None);
        assert!(r[3].binary);
        assert_eq!(r[3].additions, None);
        assert_eq!(r[3].status, FileStatus::Added);
        assert_eq!(r[3].subject, "add\x1f x");
        assert!(r[3].parents.is_empty());
    }

    #[test]
    fn blame_porcelain() {
        let (a, b) = ("a".repeat(40), "0".repeat(39) + "b");
        let data = format!(
            "{a} 1 1 2\nauthor Al\nauthor-mail <al@x>\nauthor-time 100\nauthor-tz +0000\ncommitter Al\nsummary first\nboundary\nfilename old.txt\n\tone\r\n\
             {a} 2 2\n\ttwo\n\
             {b} 1 3 1\nauthor Bo\nauthor-mail <bo@x>\nauthor-time 200\nsummary second\nprevious {a} old.txt\nfilename new.txt\n\tthree\n\
             {a} 3 4\n\t\n"
        );
        let (lines, commits, trunc) = parse_blame_porcelain(data.as_bytes(), 100);
        assert!(!trunc);
        assert_eq!(lines.len(), 4);
        assert_eq!(commits.len(), 2);
        assert!(commits[0].boundary && !commits[1].boundary);
        assert_eq!(commits[0].author_email, "al@x");
        assert_eq!(commits[1].subject, "second");
        assert_eq!(lines[0].text, "one");
        assert_eq!(lines[1].hash, a);
        assert_eq!(lines[1].orig_path, "old.txt");
        assert_eq!(lines[2].orig_path, "new.txt");
        assert_eq!((lines[2].orig_line, lines[3].orig_line), (1, 3));
        assert_eq!(lines[3].text, "");
        let (l, c, t) = parse_blame_porcelain(data.as_bytes(), 2);
        assert!(t);
        assert_eq!((l.len(), c.len()), (2, 1));
    }

    #[test]
    fn binary_detect() {
        assert!(looks_binary(b"ab\0cd"));
        assert!(!looks_binary(b"hello"));
    }
}
