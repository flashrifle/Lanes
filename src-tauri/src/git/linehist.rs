//! `git log -L<start>,<end>:<path>` line history.
use super::diff::parse_unified_diff;
use super::runner::{check_not_option, check_rel_path, run, run_capped};
use crate::error::{AppError, Result};
use crate::models::*;

pub const MAX_COMMITS: usize = 500;
pub const MAX_BYTES: usize = 8 * 1024 * 1024;

fn parse(text: &str, fallback_path: &str) -> Vec<LineHistoryEntry> {
    let mut out = Vec::new();
    for rec in text.split('\x1e').skip(1) {
        let (head, patch) = rec.split_once('\n').unwrap_or((rec, ""));
        let f: Vec<&str> = head.split('\x1f').collect();
        if f.len() < 6 {
            continue;
        }
        let path = patch
            .lines()
            .find_map(|l| l.strip_prefix("+++ b/"))
            .or_else(|| patch.lines().find_map(|l| l.strip_prefix("--- a/")))
            .map(|p| p.trim_end_matches('\t').to_string())
            .unwrap_or_else(|| fallback_path.to_string());
        let d = parse_unified_diff(patch, &path, None);
        out.push(LineHistoryEntry {
            hash: f[0].to_string(),
            parents: f[1].split_whitespace().map(str::to_string).collect(),
            author_name: f[2].to_string(),
            author_email: f[3].to_string(),
            author_time: f[4].parse().unwrap_or(0),
            subject: f[5].to_string(),
            path,
            hunks: d.hunks,
        });
    }
    out
}

pub fn line_history(repo: &str, path: &str, rev: Option<&str>, range: LineRange) -> Result<LineHistory> {
    check_rel_path(path)?;
    if range.start == 0 || range.end < range.start {
        return Err(AppError::invalid("invalid line range"));
    }
    let rev_in = rev.unwrap_or("HEAD");
    check_not_option("rev", rev_in)?;
    let full = run(repo, &["rev-parse", "--verify", &format!("{rev_in}^{{commit}}")], true)
        .map_err(|_| AppError::invalid(format!("unknown revision: {rev_in}")))?
        .text()
        .trim()
        .to_string();
    let args = vec![
        "log".to_string(),
        "--no-color".into(),
        "--no-ext-diff".into(),
        "--no-textconv".into(),
        "--format=%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s".into(),
        format!("-n{}", MAX_COMMITS + 1),
        format!("-L{},{}:{}", range.start, range.end, path),
        full.clone(),
    ];
    let (o, cut) = run_capped(repo, &args, MAX_BYTES)?;
    let mut entries = parse(&String::from_utf8_lossy(&o.stdout), path);
    let mut truncated = cut;
    if entries.len() > MAX_COMMITS {
        entries.truncate(MAX_COMMITS);
        truncated = true;
    }
    Ok(LineHistory { path: path.to_string(), rev: full, range, entries, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_records() {
        let t = "\x1eaaa\x1fbbb ccc\x1fN\x1fe@x\x1f5\x1fsubj\n\ndiff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n\x1eddd\x1f\x1fN\x1fe@x\x1f4\x1fs2\n\ndiff --git a/f b/f\n--- /dev/null\n+++ b/f\n@@ -0,0 +1 @@\n+a\n";
        let v = parse(t, "f");
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].parents, vec!["bbb", "ccc"]);
        assert_eq!(v[0].hunks.len(), 1);
        assert_eq!(v[0].path, "f");
        assert!(v[1].parents.is_empty());
        assert_eq!(v[1].hunks[0].lines.len(), 1);
    }
}
