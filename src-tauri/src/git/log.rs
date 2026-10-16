use super::runner::{check_hash, check_not_option, run, run_stdin};
use crate::error::{AppError, Result};
use crate::models::*;

#[derive(Debug, Clone, PartialEq)]
pub struct CommitRecord {
    pub hash: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub author_time: i64,
    pub committer_time: i64,
    pub message: String,
}

impl CommitRecord {
    pub fn subject(&self) -> &str {
        self.message.lines().next().unwrap_or("")
    }
}

pub const LOG_FORMAT: &str = "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%ct%x1f%B";

pub fn parse_log_output(bytes: &[u8]) -> Vec<CommitRecord> {
    let mut out = Vec::new();
    for rec in bytes.split(|&b| b == 0) {
        if rec.is_empty() {
            continue;
        }
        let s = String::from_utf8_lossy(rec);
        let s = s.trim_start_matches('\n');
        let f: Vec<&str> = s.splitn(7, '\x1f').collect();
        if f.len() < 7 || f[0].is_empty() {
            continue;
        }
        out.push(CommitRecord {
            hash: f[0].to_string(),
            parents: f[1].split_whitespace().map(str::to_string).collect(),
            author_name: f[2].to_string(),
            author_email: f[3].to_string(),
            author_time: f[4].parse().unwrap_or(0),
            committer_time: f[5].parse().unwrap_or(0),
            message: f[6].trim_end_matches('\n').to_string(),
        });
    }
    out
}

/// Revision arguments for a scope. `unborn` drops HEAD (which would fail to resolve).
pub fn scope_revs(refs: &Option<Vec<String>>, unborn: bool) -> Result<Vec<String>> {
    match refs {
        None => {
            let mut v: Vec<String> = ["--branches", "--remotes", "--tags"].iter().map(|s| s.to_string()).collect();
            if !unborn {
                v.push("HEAD".into());
            }
            Ok(v)
        }
        Some(list) => {
            let mut v = Vec::new();
            for r in list {
                check_not_option("ref", r)?;
                if unborn && r == "HEAD" {
                    continue;
                }
                v.push(r.clone());
            }
            Ok(v)
        }
    }
}

/// `limit` is the maximum number of records to read (caller adds 1 to detect truncation).
pub fn load_records(repo: &str, revs: &[String], limit: Option<u32>) -> Result<Vec<CommitRecord>> {
    if revs.is_empty() {
        return Ok(Vec::new());
    }
    let mut args: Vec<String> = vec!["log".into(), "-z".into(), "--date-order".into(), LOG_FORMAT.into()];
    if let Some(l) = limit {
        args.push(format!("--max-count={l}"));
    }
    args.extend(revs.iter().cloned());
    args.push("--".into());
    let o = run(repo, &args, true)?;
    Ok(parse_log_output(&o.stdout))
}

pub fn commit_details(repo: &str, hash: &str) -> Result<CommitDetails> {
    check_hash(hash)?;
    let fmt = "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%B";
    let o = run(repo, &["log", "-1", "-z", fmt, hash, "--"], true)?;
    let text = o.text();
    let text = text.trim_end_matches('\0');
    let f: Vec<&str> = text.splitn(9, '\x1f').collect();
    if f.len() < 9 {
        return Err(AppError::invalid(format!("unknown commit {hash}")));
    }
    let msg = f[8].trim_end();
    let (subject, body) = match msg.split_once('\n') {
        Some((s, b)) => (s.to_string(), b.trim().to_string()),
        None => (msg.to_string(), String::new()),
    };
    Ok(CommitDetails {
        hash: f[0].into(),
        parents: f[1].split_whitespace().map(str::to_string).collect(),
        author_name: f[2].into(),
        author_email: f[3].into(),
        author_time: f[4].parse().unwrap_or(0),
        committer_name: f[5].into(),
        committer_email: f[6].into(),
        committer_time: f[7].parse().unwrap_or(0),
        subject,
        body,
    })
}

pub fn status_from_code(c: &str) -> SignatureStatus {
    match c {
        "G" => SignatureStatus::Good,
        "B" => SignatureStatus::Bad,
        "U" => SignatureStatus::UnknownValidity,
        "X" => SignatureStatus::Expired,
        "Y" => SignatureStatus::ExpiredKey,
        "R" => SignatureStatus::RevokedKey,
        "E" => SignatureStatus::CannotCheck,
        _ => SignatureStatus::None,
    }
}

pub fn parse_signatures(bytes: &[u8]) -> Vec<SignatureInfo> {
    let mut out = Vec::new();
    for rec in bytes.split(|&b| b == 0) {
        let s = String::from_utf8_lossy(rec);
        let s = s.trim_matches('\n');
        let f: Vec<&str> = s.splitn(3, '\x1f').collect();
        if f.len() < 2 || f[0].is_empty() {
            continue;
        }
        let signer = f.get(2).map(|s| s.trim()).filter(|s| !s.is_empty()).map(str::to_string);
        out.push(SignatureInfo { hash: f[0].into(), status: status_from_code(f[1]), signer });
    }
    out
}

pub fn signatures(repo: &str, hashes: &[String]) -> Result<Vec<SignatureInfo>> {
    if hashes.is_empty() {
        return Ok(Vec::new());
    }
    for h in hashes {
        check_hash(h)?;
    }
    let input = hashes.join("\n") + "\n";
    let o = run_stdin(
        repo,
        &["log", "--no-walk=unsorted", "--stdin", "-z", "--format=%H%x1f%G?%x1f%GS"],
        input.into_bytes(),
        true,
    )?;
    Ok(parse_signatures(&o.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_records() {
        let h1 = "1".repeat(40);
        let h2 = "2".repeat(40);
        let data = format!(
            "{h1}\x1f{h2} {h2}\x1fAl\x1fal@x\x1f100\x1f200\x1fSubject\n\nBody\x1fmore\n\0{h2}\x1f\x1fBo\x1fbo@x\x1f1\x1f2\x1froot\n\0"
        );
        let r = parse_log_output(data.as_bytes());
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].parents.len(), 2);
        assert_eq!(r[0].subject(), "Subject");
        assert_eq!(r[0].message, "Subject\n\nBody\x1fmore");
        assert_eq!(r[0].committer_time, 200);
        assert!(r[1].parents.is_empty());
        assert_eq!(r[1].author_name, "Bo");
    }

    #[test]
    fn parses_signatures() {
        let data = format!("{}\x1fG\x1fAlice <a@x>\0{}\x1fN\x1f\0", "a".repeat(40), "b".repeat(40));
        let s = parse_signatures(data.as_bytes());
        assert_eq!(s[0].status, SignatureStatus::Good);
        assert_eq!(s[0].signer.as_deref(), Some("Alice <a@x>"));
        assert_eq!(s[1].status, SignatureStatus::None);
        assert!(s[1].signer.is_none());
    }

    #[test]
    fn revs() {
        assert_eq!(scope_revs(&None, true).unwrap().len(), 3);
        assert!(scope_revs(&Some(vec!["--all".into()]), false).is_err());
        assert!(scope_revs(&Some(vec!["HEAD".into()]), true).unwrap().is_empty());
    }
}
