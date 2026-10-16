use super::runner::{check_hash, empty_tree, run};
use crate::error::{AppError, Result};
use crate::models::*;

pub const MAX_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_LINES: usize = 20_000;

fn parse_range(s: &str) -> (u32, u32) {
    // "12,3" or "12" (count defaults to 1)
    match s.split_once(',') {
        Some((a, b)) => (a.parse().unwrap_or(0), b.parse().unwrap_or(0)),
        None => (s.parse().unwrap_or(0), 1),
    }
}

/// "@@ -a,b +c,d @@ ..." -> (a,b,c,d)
pub fn parse_hunk_header(line: &str) -> Option<(u32, u32, u32, u32)> {
    let rest = line.strip_prefix("@@ -")?;
    let (old, rest) = rest.split_once(" +")?;
    let (new, _) = rest.split_once(" @@")?;
    let (a, b) = parse_range(old);
    let (c, d) = parse_range(new);
    Some((a, b, c, d))
}

/// Parses the output of a single-file `git diff`.
pub fn parse_unified_diff(text: &str, path: &str, old_path: Option<&str>) -> FileDiff {
    let mut d = FileDiff {
        path: path.to_string(),
        old_path: old_path.map(str::to_string),
        binary: false,
        old_mode: None,
        new_mode: None,
        hunks: Vec::new(),
        truncated: false,
    };
    let mut index_mode: Option<String> = None;
    let (mut old_no, mut new_no) = (0u32, 0u32);
    for line in text.split('\n') {
        if let Some((a, b, c, e)) = parse_hunk_header(line) {
            old_no = a;
            new_no = c;
            d.hunks.push(DiffHunk {
                header: line.to_string(),
                old_start: a,
                old_lines: b,
                new_start: c,
                new_lines: e,
                lines: Vec::new(),
            });
            continue;
        }
        if let Some(h) = d.hunks.last_mut() {
            let (kind, text, o, n) = match line.as_bytes().first() {
                Some(b'+') => {
                    let n = new_no;
                    new_no += 1;
                    (DiffLineKind::Add, &line[1..], None, Some(n))
                }
                Some(b'-') => {
                    let o = old_no;
                    old_no += 1;
                    (DiffLineKind::Del, &line[1..], Some(o), None)
                }
                Some(b' ') => {
                    let (o, n) = (old_no, new_no);
                    old_no += 1;
                    new_no += 1;
                    (DiffLineKind::Context, &line[1..], Some(o), Some(n))
                }
                Some(b'\\') => (DiffLineKind::NoNewline, line[1..].trim_start(), None, None),
                // blank context line (whitespace stripped) inside a hunk; ignore the final split artifact
                None => {
                    if old_no >= h.old_start + h.old_lines && new_no >= h.new_start + h.new_lines {
                        continue;
                    }
                    let (o, n) = (old_no, new_no);
                    old_no += 1;
                    new_no += 1;
                    (DiffLineKind::Context, "", Some(o), Some(n))
                }
                _ => continue,
            };
            h.lines.push(DiffLine { kind, old_line: o, new_line: n, text: text.to_string() });
            continue;
        }
        // file header section
        if let Some(m) = line.strip_prefix("old mode ") {
            d.old_mode = Some(m.trim().to_string());
        } else if let Some(m) = line.strip_prefix("new mode ") {
            d.new_mode = Some(m.trim().to_string());
        } else if let Some(m) = line.strip_prefix("new file mode ") {
            d.new_mode = Some(m.trim().to_string());
        } else if let Some(m) = line.strip_prefix("deleted file mode ") {
            d.old_mode = Some(m.trim().to_string());
        } else if let Some(r) = line.strip_prefix("index ") {
            index_mode = r.split_whitespace().nth(1).map(str::to_string);
        } else if line.starts_with("Binary files ") || line.starts_with("GIT binary patch") {
            d.binary = true;
        } else if let Some(p) = line.strip_prefix("rename from ")
            && d.old_path.is_none() {
                d.old_path = Some(p.to_string());
            }
    }
    if d.old_mode.is_none() && d.new_mode.is_none() {
        d.old_mode = index_mode.clone();
        d.new_mode = index_mode;
    }
    d
}

pub fn file_diff(repo: &str, req: &DiffRequest) -> Result<FileDiff> {
    if req.path.is_empty() || req.path.contains('\0') {
        return Err(AppError::invalid("empty path"));
    }
    check_hash(&req.to_hash)?;
    let base = match &req.from_hash {
        Some(h) => {
            check_hash(h)?;
            h.clone()
        }
        None => empty_tree(repo)?,
    };
    let ctx = req.context_lines.unwrap_or(3).min(10_000);
    let mut args: Vec<String> = vec![
        "diff".into(),
        "--no-color".into(),
        "--no-ext-diff".into(),
        "-M".into(),
        format!("-U{ctx}"),
        base,
        req.to_hash.clone(),
        "--".into(),
    ];
    if let Some(o) = &req.old_path {
        args.push(o.clone());
    }
    args.push(req.path.clone());
    let out = run(repo, &args, true)?;
    let mut bytes: &[u8] = &out.stdout;
    let mut truncated = false;
    if bytes.len() > MAX_BYTES {
        bytes = &bytes[..MAX_BYTES];
        truncated = true;
    }
    let mut text = String::from_utf8_lossy(bytes).into_owned();
    if let Some((idx, _)) = text.match_indices('\n').nth(MAX_LINES) {
        text.truncate(idx);
        truncated = true;
    }
    let mut d = parse_unified_diff(&text, &req.path, req.old_path.as_deref());
    d.truncated = truncated;
    Ok(d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header() {
        assert_eq!(parse_hunk_header("@@ -1,3 +1,4 @@ fn x()"), Some((1, 3, 1, 4)));
        assert_eq!(parse_hunk_header("@@ -0,0 +1 @@"), Some((0, 0, 1, 1)));
        assert_eq!(parse_hunk_header("not a header"), None);
    }

    #[test]
    fn parses_diff() {
        let t = "diff --git a/f b/f\nindex 111..222 100644\n--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@ ctx\n one\n-two\n+TWO\n three\n\\ No newline at end of file\n@@ -10 +10,2 @@\n-x\n+y\n+z\n";
        let d = parse_unified_diff(t, "f", None);
        assert_eq!(d.hunks.len(), 2);
        assert_eq!(d.old_mode.as_deref(), Some("100644"));
        let h = &d.hunks[0];
        assert_eq!(h.header, "@@ -1,3 +1,3 @@ ctx");
        assert_eq!(h.lines.len(), 5);
        assert_eq!(h.lines[1].kind, DiffLineKind::Del);
        assert_eq!((h.lines[1].old_line, h.lines[1].new_line), (Some(2), None));
        assert_eq!((h.lines[2].old_line, h.lines[2].new_line), (None, Some(2)));
        assert_eq!((h.lines[3].old_line, h.lines[3].new_line), (Some(3), Some(3)));
        assert_eq!(h.lines[4].kind, DiffLineKind::NoNewline);
        assert_eq!(h.lines[4].text, "No newline at end of file");
        assert_eq!(d.hunks[1].lines.len(), 3);
        assert_eq!(d.hunks[1].lines[2].new_line, Some(11));
    }

    #[test]
    fn binary_and_modes() {
        let t = "diff --git a/i b/i\nnew file mode 100755\nindex 000..222\nBinary files /dev/null and b/i differ\n";
        let d = parse_unified_diff(t, "i", None);
        assert!(d.binary);
        assert_eq!(d.new_mode.as_deref(), Some("100755"));
        assert!(d.old_mode.is_none());
        assert!(d.hunks.is_empty());
        let t = "diff --git a/a b/b\nold mode 100644\nnew mode 100755\nsimilarity index 100%\nrename from a\nrename to b\n";
        let d = parse_unified_diff(t, "b", None);
        assert_eq!(d.old_mode.as_deref(), Some("100644"));
        assert_eq!(d.new_mode.as_deref(), Some("100755"));
        assert_eq!(d.old_path.as_deref(), Some("a"));
    }
}
