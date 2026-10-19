//! `git status --porcelain=v2 -z --branch` parsing + in-progress operation state.
use super::changes::status_from_letter;
use super::refs::detect_operation;
use super::runner::{run, run_capped};
use crate::error::Result;
use crate::models::*;
use std::path::Path;

pub const MAX_ENTRIES: usize = 10_000;
const MAX_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, Default, PartialEq)]
pub struct Parsed {
    pub head_hash: Option<String>,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    pub files: Vec<StatusFile>,
    pub truncated: bool,
}

fn letter(c: char) -> Option<FileStatus> {
    if c == '.' { None } else { Some(status_from_letter(&c.to_string())) }
}

fn conflict_kind(xy: &str) -> ConflictKind {
    match xy {
        "DD" => ConflictKind::BothDeleted,
        "AU" => ConflictKind::AddedByUs,
        "UD" => ConflictKind::DeletedByThem,
        "UA" => ConflictKind::AddedByThem,
        "DU" => ConflictKind::DeletedByUs,
        "AA" => ConflictKind::BothAdded,
        _ => ConflictKind::BothModified,
    }
}

/// Parses `status --porcelain=v2 -z --branch` output (records 1 / 2 / u / ?; ignored '!' skipped).
pub fn parse_porcelain_v2(bytes: &[u8]) -> Parsed {
    let text = String::from_utf8_lossy(bytes);
    let mut toks = text.split('\0');
    let mut p = Parsed::default();
    while let Some(t) = toks.next() {
        if t.is_empty() {
            continue;
        }
        if let Some(h) = t.strip_prefix("# ") {
            if let Some(v) = h.strip_prefix("branch.oid ") {
                p.head_hash = (v != "(initial)").then(|| v.to_string());
            } else if let Some(v) = h.strip_prefix("branch.head ") {
                p.branch = (v != "(detached)").then(|| v.to_string());
            } else if let Some(v) = h.strip_prefix("branch.upstream ") {
                p.upstream = Some(format!("refs/remotes/{v}"));
            } else if let Some(v) = h.strip_prefix("branch.ab ") {
                let mut it = v.split_whitespace();
                p.ahead = it.next().and_then(|a| a.trim_start_matches('+').parse().ok());
                p.behind = it.next().and_then(|b| b.trim_start_matches('-').parse().ok());
            }
            continue;
        }
        let kind = t.as_bytes()[0];
        let entry = match kind {
            b'1' => {
                let f: Vec<&str> = t.splitn(9, ' ').collect();
                if f.len() < 9 {
                    continue;
                }
                let xy: Vec<char> = f[1].chars().collect();
                StatusFile {
                    path: f[8].to_string(),
                    old_path: None,
                    staged: letter(xy[0]),
                    unstaged: letter(xy[1]),
                    untracked: false,
                    conflict: None,
                    submodule: f[2].starts_with('S'),
                }
            }
            b'2' => {
                let f: Vec<&str> = t.splitn(10, ' ').collect();
                let orig = toks.next().unwrap_or_default();
                if f.len() < 10 {
                    continue;
                }
                let xy: Vec<char> = f[1].chars().collect();
                StatusFile {
                    path: f[9].to_string(),
                    old_path: Some(orig.to_string()),
                    staged: letter(xy[0]),
                    unstaged: letter(xy[1]),
                    untracked: false,
                    conflict: None,
                    submodule: f[2].starts_with('S'),
                }
            }
            b'u' => {
                let f: Vec<&str> = t.splitn(11, ' ').collect();
                if f.len() < 11 {
                    continue;
                }
                StatusFile {
                    path: f[10].to_string(),
                    old_path: None,
                    staged: None,
                    unstaged: None,
                    untracked: false,
                    conflict: Some(conflict_kind(f[1])),
                    submodule: f[2].starts_with('S'),
                }
            }
            b'?' => StatusFile {
                path: t[2..].to_string(),
                old_path: None,
                staged: None,
                unstaged: None,
                untracked: true,
                conflict: None,
                submodule: false,
            },
            _ => continue,
        };
        if p.files.len() >= MAX_ENTRIES {
            p.truncated = true;
            break;
        }
        p.files.push(entry);
    }
    p.files.sort_by(|a, b| a.path.cmp(&b.path));
    p
}

fn read_trim(p: &Path) -> Option<String> {
    std::fs::read_to_string(p).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn first_line(p: &Path) -> Option<String> {
    std::fs::read_to_string(p).ok().and_then(|s| s.lines().next().map(|l| l.trim().to_string())).filter(|s| !s.is_empty())
}

/// (step, total) of a multi-commit cherry-pick / revert from `.git/sequencer`; None for a single pick.
fn sequencer_progress(repo: &str, git_dir: &Path) -> Option<(u32, u32)> {
    let seq = git_dir.join("sequencer");
    let todo = std::fs::read_to_string(seq.join("todo")).ok()?;
    let remaining = todo.lines().filter(|l| !l.trim().is_empty() && !l.starts_with('#')).count() as u32;
    let head = read_trim(&seq.join("head"))?;
    let done = run(repo, &["rev-list", "--count", &format!("{head}..HEAD")], true)
        .ok()
        .and_then(|o| o.text().trim().parse::<u32>().ok())
        .unwrap_or(0);
    // The commit that stopped the sequence is still the first todo line.
    Some((done + 1, done + remaining.max(1)))
}

/// In-progress operation details; `has_conflicts` = unmerged entries exist.
pub fn operation_state(repo: &str, git_dir: &Path, has_conflicts: bool) -> Option<OperationState> {
    let operation = detect_operation(git_dir)?;
    let mut st = OperationState {
        operation,
        head_name: None,
        onto_hash: None,
        stopped_at: None,
        step: None,
        total: None,
        can_continue: !has_conflicts && operation != RepoOperation::Bisect,
        can_skip: matches!(operation, RepoOperation::Rebase | RepoOperation::CherryPick | RepoOperation::Revert),
    };
    match operation {
        RepoOperation::Rebase => {
            let (dir, step_f, total_f) = if git_dir.join("rebase-merge").exists() {
                (git_dir.join("rebase-merge"), "msgnum", "end")
            } else {
                (git_dir.join("rebase-apply"), "next", "last")
            };
            st.head_name = read_trim(&dir.join("head-name"))
                .filter(|n| n != "detached HEAD")
                .map(|n| n.strip_prefix("refs/heads/").unwrap_or(&n).to_string());
            st.onto_hash = read_trim(&dir.join("onto"));
            st.step = read_trim(&dir.join(step_f)).and_then(|v| v.parse().ok());
            st.total = read_trim(&dir.join(total_f)).and_then(|v| v.parse().ok());
            st.stopped_at = read_trim(&git_dir.join("REBASE_HEAD")).or_else(|| read_trim(&dir.join("stopped-sha")));
        }
        RepoOperation::Merge => st.stopped_at = first_line(&git_dir.join("MERGE_HEAD")),
        RepoOperation::CherryPick => {
            st.stopped_at = first_line(&git_dir.join("CHERRY_PICK_HEAD"));
            if let Some((s, t)) = sequencer_progress(repo, git_dir) {
                st.step = Some(s);
                st.total = Some(t);
            }
        }
        RepoOperation::Revert => {
            st.stopped_at = first_line(&git_dir.join("REVERT_HEAD"));
            if let Some((s, t)) = sequencer_progress(repo, git_dir) {
                st.step = Some(s);
                st.total = Some(t);
            }
        }
        RepoOperation::Bisect => {}
    }
    Some(st)
}

pub fn git_dir_of(repo: &str) -> Result<String> {
    Ok(run(repo, &["rev-parse", "--absolute-git-dir"], true)?.text().trim().to_string())
}

/// Read-only (GIT_OPTIONAL_LOCKS=0).
pub fn read(repo: &str) -> Result<WorkingTreeStatus> {
    let (o, cut) = run_capped(
        repo,
        &["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"],
        MAX_BYTES,
    )?;
    let mut p = parse_porcelain_v2(&o.stdout);
    p.truncated |= cut;
    let git_dir = git_dir_of(repo)?;
    let has_conflicts = p.files.iter().any(|f| f.conflict.is_some());
    let operation = operation_state(repo, Path::new(&git_dir), has_conflicts);
    Ok(WorkingTreeStatus {
        head_hash: p.head_hash,
        branch: p.branch,
        upstream: p.upstream,
        ahead: p.ahead,
        behind: p.behind,
        files: p.files,
        truncated: p.truncated,
        operation,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_records() {
        let oid = "a".repeat(40);
        let mut t = String::new();
        t += &format!("# branch.oid {oid}\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -3\0");
        t += "1 .M N... 100644 100644 100644 h1 h2 src/a b.txt\0";
        t += "1 A. N... 000000 100644 100644 h1 h2 new.txt\0";
        t += "2 R. N... 100644 100644 100644 h1 h2 R100 new name.txt\0old name.txt\0";
        t += "u UU N... 100644 100644 100644 100644 h1 h2 h3 conflict.txt\0";
        t += "u DU N... 100644 100644 000000 100644 h1 h2 h3 du.txt\0";
        t += "1 .M S.M. 160000 160000 160000 h1 h2 sub\0";
        t += "? untracked.txt\0! ignored.txt\0";
        let p = parse_porcelain_v2(t.as_bytes());
        assert_eq!(p.head_hash.as_deref(), Some(oid.as_str()));
        assert_eq!(p.branch.as_deref(), Some("main"));
        assert_eq!(p.upstream.as_deref(), Some("refs/remotes/origin/main"));
        assert_eq!((p.ahead, p.behind), (Some(2), Some(3)));
        assert_eq!(p.files.len(), 7);
        let by = |n: &str| p.files.iter().find(|f| f.path == n).unwrap();
        assert_eq!(by("src/a b.txt").unstaged, Some(FileStatus::Modified));
        assert_eq!(by("src/a b.txt").staged, None);
        assert_eq!(by("new.txt").staged, Some(FileStatus::Added));
        let r = by("new name.txt");
        assert_eq!((r.staged, r.old_path.as_deref()), (Some(FileStatus::Renamed), Some("old name.txt")));
        assert_eq!(by("conflict.txt").conflict, Some(ConflictKind::BothModified));
        assert_eq!(by("du.txt").conflict, Some(ConflictKind::DeletedByUs));
        assert!(by("sub").submodule);
        assert!(by("untracked.txt").untracked);
        // sorted by path
        let paths: Vec<&str> = p.files.iter().map(|f| f.path.as_str()).collect();
        let mut sorted = paths.clone();
        sorted.sort();
        assert_eq!(paths, sorted);
    }

    #[test]
    fn unborn_detached_and_truncation() {
        let p = parse_porcelain_v2(b"# branch.oid (initial)\0# branch.head (detached)\0");
        assert_eq!((p.head_hash, p.branch, p.upstream, p.ahead), (None, None, None, None));
        let mut t = String::new();
        for i in 0..(MAX_ENTRIES + 5) {
            t += &format!("? f{i}\0");
        }
        let p = parse_porcelain_v2(t.as_bytes());
        assert!(p.truncated);
        assert_eq!(p.files.len(), MAX_ENTRIES);
    }

    #[test]
    fn conflict_mapping() {
        assert_eq!(conflict_kind("AA"), ConflictKind::BothAdded);
        assert_eq!(conflict_kind("DD"), ConflictKind::BothDeleted);
        assert_eq!(conflict_kind("AU"), ConflictKind::AddedByUs);
        assert_eq!(conflict_kind("UA"), ConflictKind::AddedByThem);
        assert_eq!(conflict_kind("UD"), ConflictKind::DeletedByThem);
    }
}
