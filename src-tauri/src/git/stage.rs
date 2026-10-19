//! Staging, discarding, line/hunk patches and conflict resolution. Every op takes the per-repo lock,
//! uses `--literal-pathspecs`, validates paths (non-empty, no NUL, inside the repo) and never a shell.
use super::ops::RepoLocks;
use super::runner::{Opts, check_all, check_rel_path, check_rel_paths, run, run_opts, run_raw};
use super::status;
use crate::error::{AppError, ErrorCode, Result};
use crate::models::*;
use std::collections::HashSet;

pub const MAX_PATCH_BYTES: usize = 5 * 1024 * 1024;

fn write(locks: &RepoLocks, repo: &str, args: &[String], stdin: Option<Vec<u8>>) -> Result<super::runner::Output> {
    let o = run_opts(
        repo,
        args,
        Opts { timeout: locks.local_timeout, network: false, hooks: false, stdin },
        &mut |_| {},
    )?;
    check_all(o)
}

fn lit(args: &[&str], paths: &[String]) -> Vec<String> {
    let mut v: Vec<String> = vec!["--literal-pathspecs".into()];
    v.extend(args.iter().map(|s| s.to_string()));
    v.push("--".into());
    v.extend(paths.iter().cloned());
    v
}

fn has_head(repo: &str) -> Result<bool> {
    Ok(run_raw(repo, &["rev-parse", "-q", "--verify", "HEAD^{commit}"], true)?.ok())
}

pub fn stage_files(locks: &RepoLocks, repo: &str, paths: &[String]) -> Result<OpResult> {
    check_rel_paths(paths)?;
    locks.run(repo, || {
        write(locks, repo, &lit(&["add", "-A"], paths), None)?;
        Ok(OpResult { message: format!("Staged {} path(s)", paths.len()) })
    })
}

pub fn unstage_files(locks: &RepoLocks, repo: &str, paths: &[String]) -> Result<OpResult> {
    check_rel_paths(paths)?;
    locks.run(repo, || {
        let args = if has_head(repo)? {
            lit(&["restore", "--staged"], paths)
        } else {
            lit(&["rm", "--cached", "-r", "-q"], paths)
        };
        write(locks, repo, &args, None)?;
        Ok(OpResult { message: format!("Unstaged {} path(s)", paths.len()) })
    })
}

/// Exact tree entries of HEAD for `paths` (non-recursive, literal).
fn head_entries(repo: &str, paths: &[String]) -> Result<HashSet<String>> {
    let mut args = vec!["--literal-pathspecs", "ls-tree", "-z", "--name-only", "HEAD", "--"];
    args.extend(paths.iter().map(String::as_str));
    let o = run(repo, &args, true)?;
    Ok(o.text().split('\0').filter(|s| !s.is_empty()).map(str::to_string).collect())
}

/// Untracked paths (files, or directories holding only untracked files) must really be untracked
/// and not ignored: `ls-files --others --exclude-standard`.
fn verify_untracked(repo: &str, paths: &[String]) -> Result<()> {
    let mut args = vec!["--literal-pathspecs", "ls-files", "--others", "--exclude-standard", "-z", "--"];
    args.extend(paths.iter().map(String::as_str));
    let o = run(repo, &args, true)?;
    let listed: Vec<String> = o.text().split('\0').filter(|s| !s.is_empty()).map(str::to_string).collect();
    for p in paths {
        let trimmed = p.trim_end_matches('/');
        let dir_prefix = format!("{trimmed}/");
        if !listed.iter().any(|l| l == trimmed || l.starts_with(&dir_prefix)) {
            return Err(AppError::invalid(format!("not an untracked file (tracked, ignored or missing): {p}")));
        }
    }
    Ok(())
}

pub fn discard_files(locks: &RepoLocks, repo: &str, req: &DiscardRequest) -> Result<OpResult> {
    if req.paths.is_empty() && req.untracked_paths.is_empty() {
        return Err(AppError::invalid("no paths given"));
    }
    req.paths.iter().chain(&req.untracked_paths).try_for_each(|p| check_rel_path(p))?;
    locks.run(repo, || {
        // Verify everything first so a refused path leaves nothing half-discarded.
        if !req.untracked_paths.is_empty() {
            verify_untracked(repo, &req.untracked_paths)?;
        }
        if !req.paths.is_empty() {
            if req.include_staged {
                if has_head(repo)? {
                    let in_head = head_entries(repo, &req.paths)?;
                    let (tracked, added): (Vec<String>, Vec<String>) =
                        req.paths.iter().cloned().partition(|p| in_head.contains(p));
                    if !tracked.is_empty() {
                        write(locks, repo, &lit(&["restore", "--worktree", "--staged", "--source=HEAD"], &tracked), None)?;
                    }
                    if !added.is_empty() {
                        // staged-new files: rollback removes them from index and disk
                        write(locks, repo, &lit(&["rm", "-r", "-f", "-q", "--ignore-unmatch"], &added), None)?;
                    }
                } else {
                    write(locks, repo, &lit(&["rm", "-r", "-f", "-q", "--ignore-unmatch"], &req.paths), None)?;
                }
            } else {
                write(locks, repo, &lit(&["restore", "--worktree"], &req.paths), None)?;
            }
        }
        if !req.untracked_paths.is_empty() {
            // files only: never -d, never -x
            write(locks, repo, &lit(&["clean", "-f", "-q"], &req.untracked_paths), None)?;
        }
        Ok(OpResult { message: format!("Discarded {} path(s)", req.paths.len() + req.untracked_paths.len()) })
    })
}

// ───────────── apply_patch ─────────────

/// C-style quoting as git prints names with special characters.
pub fn c_quote(s: &str) -> String {
    let mut out = String::from("\"");
    for b in s.bytes() {
        match b {
            b'"' => out.push_str("\\\""),
            b'\\' => out.push_str("\\\\"),
            b'\n' => out.push_str("\\n"),
            b'\t' => out.push_str("\\t"),
            b'\r' => out.push_str("\\r"),
            0x07 => out.push_str("\\a"),
            0x08 => out.push_str("\\b"),
            0x0c => out.push_str("\\f"),
            0x0b => out.push_str("\\v"),
            b if b < 0x20 || b == 0x7f => out.push_str(&format!("\\{b:03o}")),
            b => out.push(b as char),
        }
    }
    out.push('"');
    out
}

/// Inverse of [`c_quote`] (input includes the surrounding quotes); also decodes octal bytes.
pub fn c_unquote(s: &str) -> Option<String> {
    let inner = s.strip_prefix('"')?.strip_suffix('"')?;
    let b = inner.as_bytes();
    let mut out: Vec<u8> = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'\\' {
            out.push(b[i]);
            i += 1;
            continue;
        }
        i += 1;
        let c = *b.get(i)?;
        match c {
            b'"' | b'\\' => out.push(c),
            b'n' => out.push(b'\n'),
            b't' => out.push(b'\t'),
            b'r' => out.push(b'\r'),
            b'a' => out.push(0x07),
            b'b' => out.push(0x08),
            b'f' => out.push(0x0c),
            b'v' => out.push(0x0b),
            b'0'..=b'3' => {
                let oct = std::str::from_utf8(b.get(i..i + 3)?).ok()?;
                out.push(u8::from_str_radix(oct, 8).ok()?);
                i += 2;
            }
            _ => return None,
        }
        i += 1;
    }
    String::from_utf8(out).ok()
}

/// Name from a `--- `/`+++ ` header value: strips a trailing tab, C-unquotes, drops the `a/`/`b/` prefix.
fn header_path(raw: &str) -> Option<String> {
    let raw = raw.trim_end_matches(['\t', '\r']);
    if raw == "/dev/null" {
        return Some(raw.to_string());
    }
    let name = if raw.starts_with('"') { c_unquote(raw)? } else { raw.to_string() };
    name.strip_prefix("a/").or_else(|| name.strip_prefix("b/")).map(str::to_string)
}

/// Validates the single-file patch against `path`; `Err(invalidArgument)` on any mismatch.
pub fn validate_patch(path: &str, patch: &str) -> Result<()> {
    check_rel_path(path)?;
    if patch.is_empty() || patch.len() > MAX_PATCH_BYTES {
        return Err(AppError::invalid("patch is empty or larger than 5 MB"));
    }
    if !patch.starts_with("diff --git ") || !patch.ends_with('\n') || patch.contains('\0') {
        return Err(AppError::invalid("not a single-file git patch"));
    }
    let mut lines = patch.split('\n');
    let first = lines.next().unwrap_or_default();
    let quoted = c_quote(&format!("a/{path}"));
    let quoted_b = c_quote(&format!("b/{path}"));
    let ok_first = [format!("diff --git a/{path} b/{path}"), format!("diff --git {quoted} {quoted_b}")];
    if !ok_first.iter().any(|f| f == first) {
        return Err(AppError::invalid("patch header paths do not match the requested path"));
    }
    let (mut minus, mut plus) = (None, None);
    for l in lines {
        if l.starts_with("@@") {
            break;
        }
        if l.starts_with("diff --git ")
            || l.starts_with("rename ")
            || l.starts_with("copy ")
            || l.starts_with("similarity index")
            || l.starts_with("dissimilarity index")
        {
            return Err(AppError::invalid("patch must touch exactly one file and no renames"));
        }
        if let Some(r) = l.strip_prefix("--- ") {
            minus = header_path(r);
        } else if let Some(r) = l.strip_prefix("+++ ") {
            plus = header_path(r);
        }
    }
    let good = |h: &Option<String>| h.as_deref().is_some_and(|n| n == path || n == "/dev/null");
    if !good(&minus) || !good(&plus) || (minus.as_deref() == Some("/dev/null") && plus.as_deref() == Some("/dev/null")) {
        return Err(AppError::invalid("patch ---/+++ paths do not match the requested path"));
    }
    Ok(())
}

pub fn apply_patch(locks: &RepoLocks, repo: &str, req: &ApplyPatchRequest) -> Result<OpResult> {
    if req.target == PatchTarget::Worktree && !req.reverse {
        return Err(AppError::invalid("a worktree patch must be applied in reverse (discard)"));
    }
    validate_patch(&req.path, &req.patch)?;
    locks.run(repo, || {
        let mut base: Vec<String> = vec!["apply".into()];
        let mut flags: Vec<String> = Vec::new();
        if req.target == PatchTarget::Index {
            flags.push("--cached".into());
        }
        if req.reverse {
            flags.push("--reverse".into());
        }
        flags.extend(["--recount".into(), "--whitespace=nowarn".into(), "-".into()]);
        let mut check = base.clone();
        check.push("--check".into());
        check.extend(flags.clone());
        let o = run_opts(
            repo,
            &check,
            Opts { timeout: locks.local_timeout, network: false, hooks: false, stdin: Some(req.patch.clone().into_bytes()) },
            &mut |_| {},
        )?;
        if !o.ok() {
            let mut e = AppError::new(ErrorCode::PatchFailed, "the patch no longer applies (the diff is stale)");
            if o.combined().contains("index.lock") {
                e = crate::error::classify_stderr(&o.combined(), o.code);
            } else if let Some(l) = o.stderr.lines().map(str::trim).find(|l| !l.is_empty()) {
                e.message = l.trim_start_matches("error: ").to_string();
            }
            e.stderr = Some(o.combined());
            return Err(e);
        }
        base.extend(flags);
        write(locks, repo, &base, Some(req.patch.clone().into_bytes()))?;
        Ok(OpResult { message: "Patch applied".into() })
    })
}

// ───────────── resolve_conflict ─────────────

/// Does `side` have a version of the file for this conflict kind?
fn side_has_file(kind: ConflictKind, side: ConflictSide) -> bool {
    use ConflictKind::*;
    match (kind, side) {
        (BothModified | BothAdded, _) => true,
        (BothDeleted, _) => false,
        (AddedByUs, ConflictSide::Ours) => true,
        (AddedByUs, ConflictSide::Theirs) => false,
        (AddedByThem, ConflictSide::Ours) => false,
        (AddedByThem, ConflictSide::Theirs) => true,
        (DeletedByUs, ConflictSide::Ours) => false,
        (DeletedByUs, ConflictSide::Theirs) => true,
        (DeletedByThem, ConflictSide::Ours) => true,
        (DeletedByThem, ConflictSide::Theirs) => false,
    }
}

pub fn resolve_conflict(locks: &RepoLocks, repo: &str, paths: &[String], side: ConflictSide) -> Result<OpResult> {
    check_rel_paths(paths)?;
    locks.run(repo, || {
        let st = status::read(repo)?;
        let mut keep: Vec<String> = Vec::new();
        let mut remove: Vec<String> = Vec::new();
        for p in paths {
            let kind = st
                .files
                .iter()
                .find(|f| &f.path == p)
                .and_then(|f| f.conflict)
                .ok_or_else(|| AppError::invalid(format!("not a conflicted path: {p}")))?;
            if side_has_file(kind, side) { keep.push(p.clone()) } else { remove.push(p.clone()) }
        }
        if !keep.is_empty() {
            let flag = if side == ConflictSide::Ours { "--ours" } else { "--theirs" };
            write(locks, repo, &lit(&["checkout", flag], &keep), None)?;
            write(locks, repo, &lit(&["add", "-A"], &keep), None)?;
        }
        if !remove.is_empty() {
            write(locks, repo, &lit(&["rm", "-q", "--ignore-unmatch"], &remove), None)?;
        }
        Ok(OpResult { message: format!("Resolved {} path(s)", paths.len()) })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting_roundtrip() {
        for s in ["plain", "with \"quote\"", "back\\slash", "tab\tnl\n", "ctl\u{1}x", " lead"] {
            assert_eq!(c_unquote(&c_quote(s)).as_deref(), Some(s), "{s:?}");
        }
        assert_eq!(c_unquote("\"a\\303\\251\"").as_deref(), Some("aé"));
        assert_eq!(c_unquote("noquotes"), None);
    }

    #[test]
    fn patch_validation() {
        let ok = "diff --git a/f.txt b/f.txt\nindex 1..2 100644\n--- a/f.txt\n+++ b/f.txt\n@@ -1 +1 @@\n-a\n+b\n";
        assert!(validate_patch("f.txt", ok).is_ok());
        assert!(validate_patch("g.txt", ok).is_err());
        assert!(validate_patch("f.txt", &ok[..ok.len() - 1]).is_err());
        assert!(validate_patch("f.txt", &format!("x{ok}")).is_err());
        let rename = ok.replace("index 1..2 100644\n", "rename from x\nrename to f.txt\n");
        assert!(validate_patch("f.txt", &rename).is_err());
        let other = ok.replace("+++ b/f.txt", "+++ b/other.txt");
        assert!(validate_patch("f.txt", &other).is_err());
        // names with spaces / quotes
        let sp = "diff --git a/a b.txt b/a b.txt\n--- a/a b.txt\t\n+++ b/a b.txt\t\n@@ -1 +1 @@\n-a\n+b\n";
        assert!(validate_patch("a b.txt", sp).is_ok());
        let q = format!(
            "diff --git {} {}\n--- {}\n+++ {}\n@@ -1 +1 @@\n-a\n+b\n",
            c_quote("a/q\"x"),
            c_quote("b/q\"x"),
            c_quote("a/q\"x"),
            c_quote("b/q\"x")
        );
        assert!(validate_patch("q\"x", &q).is_ok());
        assert!(validate_patch("../f.txt", ok).is_err());
    }

    #[test]
    fn side_versions() {
        assert!(side_has_file(ConflictKind::DeletedByThem, ConflictSide::Ours));
        assert!(!side_has_file(ConflictKind::DeletedByThem, ConflictSide::Theirs));
        assert!(!side_has_file(ConflictKind::BothDeleted, ConflictSide::Ours));
    }
}
