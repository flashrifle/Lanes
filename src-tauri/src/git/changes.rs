use super::runner::{empty_tree, norm_hash, run, run_stdin};
use crate::error::{AppError, Result};
use crate::models::*;
use std::collections::{HashMap, HashSet};

pub fn status_from_letter(s: &str) -> FileStatus {
    match s.chars().next() {
        Some('A') => FileStatus::Added,
        Some('M') => FileStatus::Modified,
        Some('D') => FileStatus::Deleted,
        Some('R') => FileStatus::Renamed,
        Some('C') => FileStatus::Copied,
        Some('T') => FileStatus::TypeChanged,
        Some('U') => FileStatus::Unmerged,
        _ => FileStatus::Unknown,
    }
}

/// (status, path, old_path)
pub type NameStatus = (FileStatus, String, Option<String>);

/// Parses `diff-tree -r -z --name-status` output.
pub fn parse_name_status(bytes: &[u8]) -> Vec<NameStatus> {
    let text = String::from_utf8_lossy(bytes);
    let mut toks = text.split('\0').filter(|t| !t.is_empty());
    let mut out = Vec::new();
    while let Some(st) = toks.next() {
        let status = status_from_letter(st);
        match status {
            FileStatus::Renamed | FileStatus::Copied => {
                let (Some(old), Some(new)) = (toks.next(), toks.next()) else { break };
                out.push((status, new.to_string(), Some(old.to_string())));
            }
            _ => {
                let Some(p) = toks.next() else { break };
                out.push((status, p.to_string(), None));
            }
        }
    }
    out
}

/// path (new) -> (additions, deletions) ; None = binary
pub type NumStat = HashMap<String, Option<(u32, u32)>>;

/// Parses `diff -z --numstat` output.
pub fn parse_numstat(bytes: &[u8]) -> NumStat {
    let text = String::from_utf8_lossy(bytes);
    let mut toks = text.split('\0');
    let mut out = HashMap::new();
    while let Some(t) = toks.next() {
        if t.is_empty() {
            continue;
        }
        let f: Vec<&str> = t.splitn(3, '\t').collect();
        if f.len() < 3 {
            continue;
        }
        let path = if f[2].is_empty() {
            let (_old, new) = (toks.next(), toks.next());
            new.unwrap_or("").to_string()
        } else {
            f[2].to_string()
        };
        let counts = match (f[0].parse::<u32>(), f[1].parse::<u32>()) {
            (Ok(a), Ok(d)) => Some((a, d)),
            _ => None,
        };
        out.insert(path, counts);
    }
    out
}

fn base_tree(repo: &str, from: Option<&str>) -> Result<String> {
    match from {
        Some(h) => Ok(h.to_string()),
        None => empty_tree(repo),
    }
}

/// Changed files between two tree-ish (None = empty tree).
pub fn diff_pair(repo: &str, from: Option<&str>, to: &str) -> Result<Vec<ChangedFile>> {
    let base = base_tree(repo, from)?;
    let ns = run(repo, &["diff-tree", "-r", "-z", "-M", "--name-status", &base, to], true)?;
    let num = run(repo, &["--literal-pathspecs", "diff", "-z", "--no-textconv", "--no-ext-diff", "-M", "--numstat", &base, to], true)?;
    let stats = parse_numstat(&num.stdout);
    Ok(parse_name_status(&ns.stdout)
        .into_iter()
        .map(|(status, path, old_path)| {
            let st = stats.get(&path);
            let (additions, deletions, binary) = match st {
                Some(Some((a, d))) => (Some(*a), Some(*d), false),
                Some(None) => (None, None, true),
                None => (None, None, false),
            };
            ChangedFile {
                path,
                old_path,
                status,
                additions,
                deletions,
                binary,
                from_hash: from.map(str::to_string),
                to_hash: to.to_string(),
            }
        })
        .collect())
}

fn parents_of(repo: &str, hashes: &[String]) -> Result<HashMap<String, Vec<String>>> {
    let o = run_stdin(
        repo,
        &["log", "--no-walk=unsorted", "--stdin", "-z", "--format=%H%x1f%P"],
        (hashes.join("\n") + "\n").into_bytes(),
        true,
    )?;
    let text = o.text();
    let mut m = HashMap::new();
    for rec in text.split('\0') {
        let rec = rec.trim_matches('\n');
        if let Some((h, p)) = rec.split_once('\x1f') {
            m.insert(h.to_string(), p.split_whitespace().map(str::to_string).collect());
        }
    }
    Ok(m)
}

/// `hashes` are in UI row order (newest first).
pub fn changed_files(repo: &str, hashes: &[String]) -> Result<ChangesResult> {
    if hashes.is_empty() {
        return Err(AppError::invalid("no commits given"));
    }
    let hashes: Vec<String> = hashes.iter().map(|h| norm_hash(h)).collect::<Result<_>>()?;
    let hashes = &hashes[..];
    let parents = parents_of(repo, hashes)?;
    let first_parent = |h: &str| -> Result<Option<String>> {
        parents
            .get(h)
            .map(|p| p.first().cloned())
            .ok_or_else(|| AppError::invalid(format!("unknown commit {h}")))
    };
    if hashes.len() == 1 {
        let h = &hashes[0];
        let fp = first_parent(h)?;
        let mut files = diff_pair(repo, fp.as_deref(), h)?;
        files.sort_by(|a, b| a.path.cmp(&b.path));
        let is_merge = parents.get(h).map(|p| p.len() > 1).unwrap_or(false);
        return Ok(ChangesResult { mode: ChangesMode::Single, is_merge, files });
    }
    // Linear first-parent chain, newest first?
    let mut linear = true;
    for w in hashes.windows(2) {
        if first_parent(&w[0])?.as_deref() != Some(w[1].as_str()) {
            linear = false;
            break;
        }
    }
    if linear {
        let oldest = hashes.last().expect("non-empty");
        let from = first_parent(oldest)?;
        let mut files = diff_pair(repo, from.as_deref(), &hashes[0])?;
        files.sort_by(|a, b| a.path.cmp(&b.path));
        return Ok(ChangesResult { mode: ChangesMode::Range, is_merge: false, files });
    }
    let mut seen = HashSet::new();
    let mut files = Vec::new();
    for h in hashes {
        let fp = first_parent(h)?;
        for f in diff_pair(repo, fp.as_deref(), h)? {
            if seen.insert(f.path.clone()) {
                files.push(f);
            }
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(ChangesResult { mode: ChangesMode::Union, is_merge: false, files })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_status() {
        let data = b"M\0a.txt\0R100\0old.txt\0new.txt\0A\0dir/b\0D\0c\0C75\0x\0y\0T\0t\0";
        let r = parse_name_status(data);
        assert_eq!(r.len(), 6);
        assert_eq!(r[0], (FileStatus::Modified, "a.txt".into(), None));
        assert_eq!(r[1], (FileStatus::Renamed, "new.txt".into(), Some("old.txt".into())));
        assert_eq!(r[2].0, FileStatus::Added);
        assert_eq!(r[3].0, FileStatus::Deleted);
        assert_eq!(r[4], (FileStatus::Copied, "y".into(), Some("x".into())));
        assert_eq!(r[5].0, FileStatus::TypeChanged);
    }

    #[test]
    fn numstat() {
        let data = b"3\t1\ta.txt\0-\t-\timg.png\x005\t0\t\0old\0new\0";
        let r = parse_numstat(data);
        assert_eq!(r["a.txt"], Some((3, 1)));
        assert_eq!(r["img.png"], None);
        assert_eq!(r["new"], Some((5, 0)));
    }
}
