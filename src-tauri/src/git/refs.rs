use super::runner::{run, run_raw};
use crate::error::Result;
use crate::models::*;
use std::collections::HashSet;
use std::path::Path;

#[derive(Debug, Clone, Default)]
pub struct Favorites {
    pub added: HashSet<String>,
    pub removed: HashSet<String>,
}

pub const DEFAULT_FAVORITES: [&str; 2] = ["refs/heads/main", "refs/heads/master"];

impl Favorites {
    pub fn is_favorite(&self, full_name: &str) -> bool {
        self.added.contains(full_name)
            || (DEFAULT_FAVORITES.contains(&full_name) && !self.removed.contains(full_name))
    }
}

/// Parses `ahead 1, behind 2` / `ahead 1` / `behind 2` / `gone` / ``.
/// Returns (ahead, behind, gone).
pub fn parse_track(s: &str) -> (u32, u32, bool) {
    let s = s.trim();
    if s == "gone" {
        return (0, 0, true);
    }
    let (mut a, mut b) = (0, 0);
    for part in s.split(',') {
        let part = part.trim();
        if let Some(n) = part.strip_prefix("ahead ") {
            a = n.trim().parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            b = n.trim().parse().unwrap_or(0);
        }
    }
    (a, b, false)
}

pub const FOR_EACH_REF_FORMAT: &str = "--format=%(refname)%00%(objectname)%00%(*objectname)%00%(upstream)%00%(upstream:track,nobracket)%00%(HEAD)";

pub fn parse_for_each_ref(text: &str, favs: &Favorites) -> Vec<Ref> {
    let mut refs = Vec::new();
    for line in text.lines() {
        let f: Vec<&str> = line.split('\0').collect();
        if f.len() < 6 || f[0].is_empty() {
            continue;
        }
        let full = f[0];
        let hash = if f[2].is_empty() { f[1] } else { f[2] };
        let mut r = Ref {
            name: String::new(),
            full_name: full.to_string(),
            ref_type: RefType::Tag,
            hash: hash.to_string(),
            index: None,
            remote: None,
            upstream: None,
            ahead: None,
            behind: None,
            upstream_gone: false,
            is_current: false,
            is_favorite: favs.is_favorite(full),
        };
        if let Some(n) = full.strip_prefix("refs/heads/") {
            r.name = n.to_string();
            r.ref_type = RefType::LocalBranch;
            r.is_current = f[5] == "*";
            if !f[3].is_empty() {
                r.upstream = Some(f[3].to_string());
                let (a, b, gone) = parse_track(f[4]);
                if gone {
                    r.upstream_gone = true;
                } else {
                    r.ahead = Some(a);
                    r.behind = Some(b);
                }
            }
        } else if let Some(n) = full.strip_prefix("refs/remotes/") {
            if n.ends_with("/HEAD") {
                continue;
            }
            r.name = n.to_string();
            r.ref_type = RefType::RemoteBranch;
            r.remote = n.split('/').next().map(str::to_string);
        } else if let Some(n) = full.strip_prefix("refs/tags/") {
            r.name = n.to_string();
            r.ref_type = RefType::Tag;
        } else {
            continue;
        }
        refs.push(r);
    }
    refs
}

pub fn detect_operation(git_dir: &Path) -> Option<RepoOperation> {
    let e = |n: &str| git_dir.join(n).exists();
    if e("rebase-merge") || e("rebase-apply") {
        Some(RepoOperation::Rebase)
    } else if e("MERGE_HEAD") {
        Some(RepoOperation::Merge)
    } else if e("CHERRY_PICK_HEAD") {
        Some(RepoOperation::CherryPick)
    } else if e("REVERT_HEAD") {
        Some(RepoOperation::Revert)
    } else if e("BISECT_LOG") {
        Some(RepoOperation::Bisect)
    } else {
        None
    }
}

pub fn read_refs(repo: &str, favs: &Favorites) -> Result<RefsSnapshot> {
    let sym = run_raw(repo, &["symbolic-ref", "-q", "HEAD"], true)?;
    let full_name = if sym.ok() { Some(sym.text().trim().to_string()) } else { None };
    let hash_out = run_raw(repo, &["rev-parse", "-q", "--verify", "HEAD^{commit}"], true)?;
    let hash = if hash_out.ok() { Some(hash_out.text().trim().to_string()) } else { None };
    let head = HeadState {
        detached: full_name.is_none(),
        unborn: hash.is_none(),
        branch: full_name.as_deref().map(|f| f.strip_prefix("refs/heads/").unwrap_or(f).to_string()),
        full_name,
        hash: hash.clone(),
    };
    let out = run(repo, &["for-each-ref", FOR_EACH_REF_FORMAT, "refs/heads", "refs/remotes", "refs/tags"], true)?;
    let mut refs = Vec::new();
    if let Some(h) = &hash {
        refs.push(Ref {
            name: "HEAD".into(),
            full_name: "HEAD".into(),
            ref_type: RefType::Head,
            hash: h.clone(),
            index: None,
            remote: None,
            upstream: None,
            ahead: None,
            behind: None,
            upstream_gone: false,
            is_current: true,
            is_favorite: false,
        });
    }
    refs.extend(parse_for_each_ref(&out.text(), favs));
    let git_dir = run(repo, &["rev-parse", "--absolute-git-dir"], true)?.text().trim().to_string();
    Ok(RefsSnapshot { head, refs, operation: detect_operation(Path::new(&git_dir)) })
}

pub fn containing_refs(repo: &str, hash: &str) -> Result<Vec<String>> {
    super::runner::check_hash(hash)?;
    let o = run(
        repo,
        &["for-each-ref", "--contains", hash, "--format=%(refname)", "refs/heads", "refs/remotes", "refs/tags"],
        true,
    )?;
    Ok(o.text()
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !(l.starts_with("refs/remotes/") && l.ends_with("/HEAD")))
        .map(str::to_string)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn track() {
        assert_eq!(parse_track("ahead 1, behind 2"), (1, 2, false));
        assert_eq!(parse_track("ahead 3"), (3, 0, false));
        assert_eq!(parse_track("behind 4"), (0, 4, false));
        assert_eq!(parse_track("gone"), (0, 0, true));
        assert_eq!(parse_track(""), (0, 0, false));
    }

    #[test]
    fn for_each_ref_lines() {
        let h1 = "a".repeat(40);
        let h2 = "b".repeat(40);
        let h3 = "c".repeat(40);
        let text = format!(
            "refs/heads/main\0{h1}\0\0refs/remotes/origin/main\0ahead 1, behind 2\0*\n\
             refs/heads/old\0{h1}\0\0refs/remotes/origin/old\0gone\0 \n\
             refs/remotes/origin/HEAD\0{h1}\0\0\0\0 \n\
             refs/remotes/origin/main\0{h1}\0\0\0\0 \n\
             refs/tags/v1\0{h2}\0{h3}\0\0\0 \n"
        );
        let refs = parse_for_each_ref(&text, &Favorites::default());
        assert_eq!(refs.len(), 4);
        assert_eq!(refs[0].name, "main");
        assert!(refs[0].is_current && refs[0].is_favorite);
        assert_eq!((refs[0].ahead, refs[0].behind), (Some(1), Some(2)));
        assert!(refs[1].upstream_gone && refs[1].ahead.is_none());
        assert_eq!(refs[2].remote.as_deref(), Some("origin"));
        assert_eq!(refs[3].hash, h3);
        assert_eq!(refs[3].ref_type, RefType::Tag);
    }
}
