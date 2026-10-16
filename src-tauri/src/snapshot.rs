use crate::error::{AppError, ErrorCode, Result};
use crate::git::log::{CommitRecord, load_records, scope_revs};
use crate::git::refs::{Favorites, read_refs};
use crate::git::repo::canonical_key;
use crate::git::runner::run;
use crate::models::*;
use regex::RegexBuilder;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// Snapshots kept per repository (multi-tab: every open repo has its own budget).
pub const KEEP_SNAPSHOTS_PER_REPO: usize = 2;

pub struct Snapshot {
    pub id: u32,
    pub repo_path: String,
    /// canonical repo key (see `repo::canonical_key`)
    pub key: String,
    /// revision arguments used for the log (for the path filter)
    pub revs: Vec<String>,
    pub records: Vec<CommitRecord>,
    pub hash_index: HashMap<String, u32>,
}

#[derive(Default)]
struct Inner {
    map: HashMap<u32, Arc<Snapshot>>,
    /// per-repo insertion order, oldest first
    order: HashMap<String, VecDeque<u32>>,
    /// per-repo close generation; bumped by `release_repo`
    gens: HashMap<String, u64>,
}

pub struct SnapshotStore {
    inner: Mutex<Inner>,
    next: AtomicU32,
}

impl Default for SnapshotStore {
    fn default() -> Self {
        SnapshotStore { inner: Mutex::new(Inner::default()), next: AtomicU32::new(1) }
    }
}

impl SnapshotStore {
    pub fn next_id(&self) -> u32 {
        self.next.fetch_add(1, Ordering::SeqCst)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Current close-generation of a repo; capture before loading and pass to `insert_if_current`.
    pub fn generation(&self, key: &str) -> u64 {
        self.lock().gens.get(key).copied().unwrap_or(0)
    }

    /// Inserts unless the repo was closed since `gen` was captured. Evicts the oldest snapshots
    /// of that repo beyond the per-repo budget. Returns None when dropped.
    pub fn insert_if_current(&self, s: Snapshot, gen_at_start: u64) -> Option<Arc<Snapshot>> {
        let mut g = self.lock();
        if g.gens.get(&s.key).copied().unwrap_or(0) != gen_at_start {
            return None;
        }
        let s = Arc::new(s);
        g.map.insert(s.id, s.clone());
        let mut evicted = Vec::new();
        let q = g.order.entry(s.key.clone()).or_default();
        q.push_back(s.id);
        while q.len() > KEEP_SNAPSHOTS_PER_REPO {
            if let Some(old) = q.pop_front() {
                evicted.push(old);
            }
        }
        for old in evicted {
            g.map.remove(&old);
        }
        Some(s)
    }

    pub fn insert(&self, s: Snapshot) -> Arc<Snapshot> {
        let gen_now = self.generation(&s.key);
        self.insert_if_current(s, gen_now).expect("generation just read")
    }

    pub fn get(&self, id: u32) -> Result<Arc<Snapshot>> {
        self.lock()
            .map
            .get(&id)
            .cloned()
            .ok_or_else(|| AppError::new(ErrorCode::SnapshotExpired, format!("snapshot {id} expired")))
    }

    pub fn release(&self, id: u32) {
        let mut g = self.lock();
        if let Some(s) = g.map.remove(&id)
            && let Some(q) = g.order.get_mut(&s.key)
        {
            q.retain(|&i| i != id);
        }
    }

    /// Drops all snapshots of a repo and invalidates in-flight loads for it.
    pub fn release_repo(&self, repo: &str) {
        let key = canonical_key(repo);
        let mut g = self.lock();
        *g.gens.entry(key.clone()).or_default() += 1;
        if let Some(q) = g.order.remove(&key) {
            for id in q {
                g.map.remove(&id);
            }
        }
    }
}

pub fn load_log(store: &SnapshotStore, repo: &str, scope: LogScope, favs: &Favorites) -> Result<LogSnapshot> {
    let started = Instant::now();
    let key = canonical_key(repo);
    let gen_at_start = store.generation(&key);
    let mut refs = read_refs(repo, favs)?;
    let revs = scope_revs(&scope.refs, refs.head.unborn)?;
    let read_limit = scope.limit.map(|l| l.saturating_add(1));
    let mut records = load_records(repo, &revs, read_limit)?;
    let mut truncated = false;
    if let Some(l) = scope.limit
        && records.len() > l as usize {
            records.truncate(l as usize);
            truncated = true;
        }
    let hash_index: HashMap<String, u32> = records.iter().enumerate().map(|(i, r)| (r.hash.clone(), i as u32)).collect();
    for r in &mut refs.refs {
        r.index = hash_index.get(&r.hash).copied();
    }
    let head_index = refs.head.hash.as_ref().and_then(|h| hash_index.get(h).copied());
    let hashes: Vec<String> = records.iter().map(|r| r.hash.clone()).collect();
    let parents: Vec<Vec<i64>> = records
        .iter()
        .map(|r| r.parents.iter().map(|p| hash_index.get(p).map(|&i| i as i64).unwrap_or(-1)).collect())
        .collect();
    let timestamps: Vec<i64> = records.iter().map(|r| r.committer_time).collect();
    let id = store.next_id();
    let commit_count = records.len() as u32;
    if store.insert_if_current(Snapshot { id, repo_path: repo.to_string(), key, revs, records, hash_index }, gen_at_start).is_none() {
        return Err(AppError::new(ErrorCode::SnapshotExpired, "repository was closed while the log was loading"));
    }
    Ok(LogSnapshot {
        snapshot_id: id,
        repo_path: repo.to_string(),
        scope,
        commit_count,
        hashes,
        parents,
        timestamps,
        refs,
        head_index,
        truncated,
        load_millis: started.elapsed().as_millis() as u32,
    })
}

pub fn commit_rows(snap: &Snapshot, indices: &[u32]) -> Result<Vec<CommitMeta>> {
    indices
        .iter()
        .map(|&i| {
            let r = snap
                .records
                .get(i as usize)
                .ok_or_else(|| AppError::invalid(format!("index {i} out of range")))?;
            Ok(CommitMeta {
                index: i,
                hash: r.hash.clone(),
                subject: r.subject().to_string(),
                author_name: r.author_name.clone(),
                author_email: r.author_email.clone(),
                author_time: r.author_time,
                committer_time: r.committer_time,
                parent_count: r.parents.len() as u32,
            })
        })
        .collect()
}

pub fn authors(snap: &Snapshot) -> Vec<AuthorInfo> {
    let mut m: HashMap<(&str, &str), u32> = HashMap::new();
    for r in &snap.records {
        *m.entry((r.author_name.as_str(), r.author_email.as_str())).or_default() += 1;
    }
    let mut v: Vec<AuthorInfo> = m
        .into_iter()
        .map(|((n, e), c)| AuthorInfo { name: n.into(), email: e.into(), commit_count: c })
        .collect();
    v.sort_by(|a, b| b.commit_count.cmp(&a.commit_count).then_with(|| a.name.cmp(&b.name)).then_with(|| a.email.cmp(&b.email)));
    v
}

fn path_matches(snap: &Snapshot, paths: &[String]) -> Result<HashSet<u32>> {
    if snap.revs.is_empty() {
        // unborn repo: nothing to match (a bare `git log -- paths` would try HEAD and fail)
        return Ok(HashSet::new());
    }
    let mut args: Vec<String> = vec!["--literal-pathspecs".into(), "log".into(), "--format=%H".into(), "--full-history".into(), "--simplify-merges".into()];
    args.extend(snap.revs.iter().cloned());
    args.push("--".into());
    args.extend(paths.iter().cloned());
    let o = run(&snap.repo_path, &args, true)?;
    Ok(o.text().lines().filter_map(|h| snap.hash_index.get(h.trim()).copied()).collect())
}

pub fn filter_commits(snap: &Snapshot, f: &LogFilter) -> Result<FilterResult> {
    let text = f.text.as_ref().filter(|t| !t.text.is_empty());
    let users: Option<Vec<String>> =
        f.users.as_ref().filter(|u| !u.is_empty()).map(|u| u.iter().map(|s| s.to_lowercase()).collect());
    let date = f.date.as_ref().filter(|d| d.since.is_some() || d.until.is_some());
    let paths = f.paths.as_ref().filter(|p| !p.is_empty());
    if text.is_none() && users.is_none() && date.is_none() && paths.is_none() {
        return Ok(FilterResult { matches: None });
    }
    let re = match text {
        Some(t) if t.regex => Some(
            RegexBuilder::new(&t.text)
                .case_insensitive(!t.match_case)
                .build()
                .map_err(|e| AppError::invalid(format!("invalid regex: {e}")))?,
        ),
        _ => None,
    };
    let needle_lower = text.map(|t| t.text.to_lowercase());
    let hash_prefix = text.and_then(|t| {
        let s = t.text.trim().to_lowercase();
        ((4..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_hexdigit())).then_some(s)
    });
    let path_set = match paths {
        Some(p) => Some(path_matches(snap, p)?),
        None => None,
    };
    let mut out = Vec::new();
    for (i, r) in snap.records.iter().enumerate() {
        let i = i as u32;
        if let Some(ps) = &path_set
            && !ps.contains(&i) {
                continue;
            }
        if let Some(d) = date
            && (d.since.is_some_and(|s| r.committer_time < s) || d.until.is_some_and(|u| r.committer_time > u)) {
                continue;
            }
        if let Some(us) = &users {
            let who = format!("{} <{}>", r.author_name, r.author_email).to_lowercase();
            if !us.iter().any(|u| who.contains(u)) {
                continue;
            }
        }
        if let Some(t) = text {
            let hash_hit = hash_prefix.as_ref().is_some_and(|p| r.hash.starts_with(p.as_str()));
            let msg_hit = if let Some(re) = &re {
                re.is_match(&r.message)
            } else if t.match_case {
                r.message.contains(&t.text)
            } else {
                r.message.to_lowercase().contains(needle_lower.as_deref().unwrap_or(""))
            };
            if !hash_hit && !msg_hit {
                continue;
            }
        }
        out.push(i);
    }
    Ok(FilterResult { matches: Some(out) })
}
