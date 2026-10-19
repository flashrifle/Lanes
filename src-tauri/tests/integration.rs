use lanes_lib::error::ErrorCode;
use lanes_lib::git::refs::{Favorites, read_refs};
use lanes_lib::git::{changes, diff, file, log, ops, repo};
use lanes_lib::models::*;
use lanes_lib::snapshot::{self, SnapshotStore};
use lanes_lib::state::AppState;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;
use tempfile::TempDir;

static CLOCK: AtomicI64 = AtomicI64::new(1_700_000_000);

fn git_in(dir: &Path, args: &[&str]) -> String {
    let t = CLOCK.fetch_add(60, Ordering::SeqCst);
    let date = format!("{t} +0000");
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "Test User")
        .env("GIT_AUTHOR_EMAIL", "test@example.com")
        .env("GIT_COMMITTER_NAME", "Test User")
        .env("GIT_COMMITTER_EMAIL", "test@example.com")
        .env("GIT_AUTHOR_DATE", &date)
        .env("GIT_COMMITTER_DATE", &date)
        .env("GIT_EDITOR", "true")
        .output()
        .expect("run git");
    assert!(
        out.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

struct TestRepo {
    _tmp: TempDir,
    dir: PathBuf,
}

impl TestRepo {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().canonicalize().unwrap().join("work");
        std::fs::create_dir_all(&dir).unwrap();
        git_in(&dir, &["init", "-q", "-b", "main"]);
        git_in(&dir, &["config", "user.name", "Test User"]);
        git_in(&dir, &["config", "user.email", "test@example.com"]);
        git_in(&dir, &["config", "commit.gpgsign", "false"]);
        TestRepo { _tmp: tmp, dir }
    }
    fn path(&self) -> &str {
        self.dir.to_str().unwrap()
    }
    fn git(&self, args: &[&str]) -> String {
        git_in(&self.dir, args)
    }
    fn write(&self, name: &str, content: &str) {
        let p = self.dir.join(name);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, content).unwrap();
    }
    fn commit_file(&self, name: &str, content: &str, msg: &str) -> String {
        self.write(name, content);
        self.git(&["add", "-A"]);
        self.git(&["commit", "-q", "-m", msg]);
        self.git(&["rev-parse", "HEAD"])
    }
    fn load(&self, store: &SnapshotStore) -> LogSnapshot {
        snapshot::load_log(store, self.path(), LogScope { refs: None, limit: None }, &Favorites::default()).unwrap()
    }
}

fn no_progress() -> impl FnMut(&str) {
    |_: &str| {}
}

#[test]
fn linear_history() {
    let r = TestRepo::new();
    let h1 = r.commit_file("a.txt", "one\n", "first");
    let h2 = r.commit_file("a.txt", "one\ntwo\n", "second\n\nbody text");
    let h3 = r.commit_file("b.txt", "b\n", "third");
    let store = SnapshotStore::default();
    let s = r.load(&store);
    assert_eq!(s.hashes, vec![h3.clone(), h2.clone(), h1.clone()]);
    assert_eq!(s.parents, vec![vec![1], vec![2], vec![]]);
    assert_eq!(s.head_index, Some(0));
    assert!(!s.truncated);
    assert_eq!(s.timestamps.len(), 3);
    let head_ref = s.refs.refs.iter().find(|x| x.ref_type == RefType::Head).unwrap();
    assert_eq!(head_ref.index, Some(0));
    let main = s.refs.refs.iter().find(|x| x.full_name == "refs/heads/main").unwrap();
    assert!(main.is_current && main.is_favorite);
    assert!(main.upstream.is_none() && main.ahead.is_none());

    let snap = store.get(s.snapshot_id).unwrap();
    let rows = snapshot::commit_rows(&snap, &[2, 1]).unwrap();
    assert_eq!(rows[0].subject, "first");
    assert_eq!(rows[1].subject, "second");
    assert_eq!(rows[1].parent_count, 1);
    assert_eq!(snapshot::commit_rows(&snap, &[3]).unwrap_err().code, ErrorCode::InvalidArgument);
    assert_eq!(store.get(9999).err().unwrap().code, ErrorCode::SnapshotExpired);

    let authors = snapshot::authors(&snap);
    assert_eq!(authors.len(), 1);
    assert_eq!(authors[0].commit_count, 3);

    let d = log::commit_details(r.path(), &h2).unwrap();
    assert_eq!(d.subject, "second");
    assert_eq!(d.body, "body text");
    assert_eq!(d.parents, vec![h1.clone()]);
    assert_eq!(d.author_email, "test@example.com");

    // limit + truncation
    let lim = snapshot::load_log(&store, r.path(), LogScope { refs: None, limit: Some(2) }, &Favorites::default()).unwrap();
    assert_eq!(lim.commit_count, 2);
    assert!(lim.truncated);
    assert_eq!(lim.parents[1], vec![-1]);

    // filters
    let f = |text: &str, regex: bool, case: bool| LogFilter {
        text: Some(TextFilter { text: text.into(), regex, match_case: case }),
        users: None,
        date: None,
        paths: None,
    };
    let m = snapshot::filter_commits(&snap, &f("BODY", false, false)).unwrap().matches;
    assert_eq!(m, Some(vec![1]));
    let m = snapshot::filter_commits(&snap, &f("BODY", false, true)).unwrap().matches;
    assert_eq!(m, Some(vec![]));
    let m = snapshot::filter_commits(&snap, &f("^(first|third)$", true, true)).unwrap().matches;
    assert_eq!(m, Some(vec![0, 2]));
    assert_eq!(snapshot::filter_commits(&snap, &f("(", true, true)).unwrap_err().code, ErrorCode::InvalidArgument);
    let m = snapshot::filter_commits(&snap, &f(&h2[..8], false, false)).unwrap().matches;
    assert_eq!(m, Some(vec![1]));
    let by_path = LogFilter { text: None, users: None, date: None, paths: Some(vec!["b.txt".into()]) };
    assert_eq!(snapshot::filter_commits(&snap, &by_path).unwrap().matches, Some(vec![0]));
    let by_user = LogFilter { text: None, users: Some(vec!["TEST@example".into()]), date: None, paths: None };
    assert_eq!(snapshot::filter_commits(&snap, &by_user).unwrap().matches.unwrap().len(), 3);
    let by_user = LogFilter { text: None, users: Some(vec!["nobody".into()]), date: None, paths: None };
    assert_eq!(snapshot::filter_commits(&snap, &by_user).unwrap().matches, Some(vec![]));
    let by_date = LogFilter {
        text: None,
        users: None,
        date: Some(DateRange { since: Some(s.timestamps[1]), until: Some(s.timestamps[1]) }),
        paths: None,
    };
    assert_eq!(snapshot::filter_commits(&snap, &by_date).unwrap().matches, Some(vec![1]));
    let empty = LogFilter { text: None, users: None, date: None, paths: None };
    assert_eq!(snapshot::filter_commits(&snap, &empty).unwrap().matches, None);

    // changes
    let c = changes::changed_files(r.path(), std::slice::from_ref(&h2)).unwrap();
    assert_eq!(c.mode, ChangesMode::Single);
    assert!(!c.is_merge);
    assert_eq!(c.files.len(), 1);
    assert_eq!(c.files[0].status, FileStatus::Modified);
    assert_eq!((c.files[0].additions, c.files[0].deletions), (Some(1), Some(0)));
    assert_eq!(c.files[0].from_hash.as_deref(), Some(h1.as_str()));
    // range: newest first, linear chain
    let c = changes::changed_files(r.path(), &[h3.clone(), h2.clone()]).unwrap();
    assert_eq!(c.mode, ChangesMode::Range);
    assert_eq!(c.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["a.txt", "b.txt"]);
    assert_eq!(c.files[0].to_hash, h3);
    assert_eq!(c.files[0].from_hash.as_deref(), Some(h1.as_str()));
    // union: non adjacent
    let c = changes::changed_files(r.path(), &[h3.clone(), h1.clone()]).unwrap();
    assert_eq!(c.mode, ChangesMode::Union);
    assert_eq!(c.files.len(), 2);
    assert_eq!(c.files.iter().find(|f| f.path == "a.txt").unwrap().to_hash, h1);

    // diff
    let fd = diff::file_diff(
        r.path(),
        &DiffRequest { path: "a.txt".into(), old_path: None, from_hash: Some(h1.clone()), to_hash: h2.clone(), context_lines: None },
    )
    .unwrap();
    assert_eq!(fd.hunks.len(), 1);
    assert!(fd.hunks[0].lines.iter().any(|l| l.kind == DiffLineKind::Add && l.text == "two"));

    // signatures
    let sigs = log::signatures(r.path(), &[h1.clone(), h3.clone()]).unwrap();
    assert_eq!(sigs.len(), 2);
    assert_eq!(sigs[0].hash, h1);
    assert_eq!(sigs[0].status, SignatureStatus::None);

    // containing refs
    assert_eq!(lanes_lib::git::refs::containing_refs(r.path(), &h1).unwrap(), vec!["refs/heads/main"]);
}

#[test]
fn branch_and_merge() {
    let r = TestRepo::new();
    let c1 = r.commit_file("a.txt", "a\n", "base");
    r.git(&["checkout", "-q", "-b", "feat"]);
    let c2 = r.commit_file("f.txt", "f\n", "feat work");
    r.git(&["checkout", "-q", "main"]);
    let c3 = r.commit_file("m.txt", "m\n", "main work");
    r.git(&["merge", "--no-ff", "-q", "-m", "merge feat", "feat"]);
    let merge = r.git(&["rev-parse", "HEAD"]);
    let store = SnapshotStore::default();
    let s = r.load(&store);
    assert_eq!(s.commit_count, 4);
    assert_eq!(s.hashes[0], merge);
    let idx = |h: &str| s.hashes.iter().position(|x| x == h).unwrap() as i64;
    assert_eq!(s.parents[0], vec![idx(&c3), idx(&c2)]);
    assert_eq!(s.parents[idx(&c2) as usize], vec![idx(&c1)]);
    // topo-valid: parents appear after children
    for (i, ps) in s.parents.iter().enumerate() {
        for &p in ps {
            assert!(p > i as i64);
        }
    }
    let snap = store.get(s.snapshot_id).unwrap();
    assert_eq!(snapshot::commit_rows(&snap, &[0]).unwrap()[0].parent_count, 2);

    // merge: single mode vs first parent
    let c = changes::changed_files(r.path(), std::slice::from_ref(&merge)).unwrap();
    assert!(c.is_merge);
    assert_eq!(c.files.len(), 1);
    assert_eq!(c.files[0].path, "f.txt");
    // scope: only feat
    let only = snapshot::load_log(
        &store,
        r.path(),
        LogScope { refs: Some(vec!["refs/heads/feat".into()]), limit: None },
        &Favorites::default(),
    )
    .unwrap();
    assert_eq!(only.commit_count, 2);
    assert_eq!(
        snapshot::load_log(&store, r.path(), LogScope { refs: Some(vec!["--all".into()]), limit: None }, &Favorites::default())
            .unwrap_err()
            .code,
        ErrorCode::InvalidArgument
    );

    // containing branches
    let cont = lanes_lib::git::refs::containing_refs(r.path(), &c2).unwrap();
    assert_eq!(cont, vec!["refs/heads/feat", "refs/heads/main"]);
}

#[test]
fn rename_root_and_binary() {
    let r = TestRepo::new();
    let root = r.commit_file("old name.txt", "line1\nline2\nline3\nline4\nline5\n", "root");
    std::fs::write(r.dir.join("bin.dat"), [0u8, 159, 146, 150, 0, 1, 2]).unwrap();
    r.git(&["add", "-A"]);
    r.git(&["commit", "-q", "-m", "add binary"]);
    let bin_commit = r.git(&["rev-parse", "HEAD"]);
    std::fs::create_dir_all(r.dir.join("new")).unwrap();
    r.git(&["mv", "old name.txt", "new/name.txt"]);
    r.git(&["commit", "-q", "-m", "rename"]);
    let ren = r.git(&["rev-parse", "HEAD"]);

    let c = changes::changed_files(r.path(), std::slice::from_ref(&root)).unwrap();
    assert_eq!(c.files.len(), 1);
    assert_eq!(c.files[0].status, FileStatus::Added);
    assert_eq!(c.files[0].from_hash, None);
    assert_eq!(c.files[0].additions, Some(5));
    // root diff vs empty tree
    let fd = diff::file_diff(
        r.path(),
        &DiffRequest { path: "old name.txt".into(), old_path: None, from_hash: None, to_hash: root.clone(), context_lines: Some(1) },
    )
    .unwrap();
    assert_eq!(fd.hunks[0].lines.len(), 5);
    assert_eq!(fd.new_mode.as_deref(), Some("100644"));

    let c = changes::changed_files(r.path(), std::slice::from_ref(&bin_commit)).unwrap();
    assert!(c.files[0].binary);
    assert_eq!(c.files[0].additions, None);
    let fd = diff::file_diff(
        r.path(),
        &DiffRequest { path: "bin.dat".into(), old_path: None, from_hash: Some(root.clone()), to_hash: bin_commit, context_lines: None },
    )
    .unwrap();
    assert!(fd.binary);
    assert!(fd.hunks.is_empty());

    let c = changes::changed_files(r.path(), std::slice::from_ref(&ren)).unwrap();
    assert_eq!(c.files.len(), 1);
    let f = &c.files[0];
    assert_eq!(f.status, FileStatus::Renamed);
    assert_eq!(f.path, "new/name.txt");
    assert_eq!(f.old_path.as_deref(), Some("old name.txt"));
    assert_eq!((f.additions, f.deletions), (Some(0), Some(0)));
    let fd = diff::file_diff(
        r.path(),
        &DiffRequest {
            path: f.path.clone(),
            old_path: f.old_path.clone(),
            from_hash: f.from_hash.clone(),
            to_hash: f.to_hash.clone(),
            context_lines: None,
        },
    )
    .unwrap();
    assert_eq!(fd.old_path.as_deref(), Some("old name.txt"));
    assert!(fd.hunks.is_empty());
}

#[test]
fn unborn_repo() {
    let r = TestRepo::new();
    let refs = read_refs(r.path(), &Favorites::default()).unwrap();
    assert!(refs.head.unborn);
    assert!(!refs.head.detached);
    assert_eq!(refs.head.branch.as_deref(), Some("main"));
    assert!(refs.head.hash.is_none());
    assert!(refs.refs.is_empty());
    let store = SnapshotStore::default();
    let s = r.load(&store);
    assert_eq!(s.commit_count, 0);
    assert_eq!(s.head_index, None);
    assert!(s.hashes.is_empty());
    let s2 = snapshot::load_log(&store, r.path(), LogScope { refs: Some(vec!["HEAD".into()]), limit: None }, &Favorites::default()).unwrap();
    assert_eq!(s2.commit_count, 0);
    let info = repo::open_repo_info(r.path()).unwrap();
    assert_eq!(info.path, r.path());
}

#[test]
fn not_a_repo_error() {
    let tmp = tempfile::tempdir().unwrap();
    let e = repo::open_repo_info(tmp.path().to_str().unwrap()).unwrap_err();
    assert_eq!(e.code, ErrorCode::NotARepo);
}

#[test]
fn branch_ops() {
    let r = TestRepo::new();
    let locks = ops::RepoLocks::default();
    r.commit_file("a.txt", "a\n", "base");

    let v = ops::validate_branch_name(r.path(), "feature/x").unwrap();
    assert!(v.valid && !v.exists);
    let v = ops::validate_branch_name(r.path(), "main").unwrap();
    assert!(v.valid && v.exists && v.message.is_some());
    let v = ops::validate_branch_name(r.path(), "bad name").unwrap();
    assert!(!v.valid && v.message.is_some());
    assert!(!ops::validate_branch_name(r.path(), "-x").unwrap().valid);

    ops::create_branch(&locks, r.path(), "topic", "HEAD", true).unwrap();
    assert_eq!(r.git(&["symbolic-ref", "--short", "HEAD"]), "topic");
    let c2 = r.commit_file("t.txt", "t\n", "topic only");
    ops::checkout(&locks, r.path(), &CheckoutTarget::LocalBranch { name: "main".into() }, &mut no_progress()).unwrap();
    assert_eq!(
        ops::create_branch(&locks, r.path(), "topic", "HEAD", false).unwrap_err().code,
        ErrorCode::InvalidArgument
    );

    // unmerged -> notFullyMerged, force works
    let e = ops::delete_branch(&locks, r.path(), "topic", false).unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFullyMerged);
    ops::delete_branch(&locks, r.path(), "topic", true).unwrap();
    assert!(!ops::validate_branch_name(r.path(), "topic").unwrap().exists);
    // current branch refuses
    assert_eq!(ops::delete_branch(&locks, r.path(), "main", true).unwrap_err().code, ErrorCode::InvalidArgument);
    // merged -> -d works
    ops::create_branch(&locks, r.path(), "merged", "HEAD", false).unwrap();
    ops::delete_branch(&locks, r.path(), "merged", false).unwrap();

    // detached checkout of commit / tag
    r.git(&["tag", "v1"]);
    ops::checkout(&locks, r.path(), &CheckoutTarget::Tag { name: "v1".into() }, &mut no_progress()).unwrap();
    let refs = read_refs(r.path(), &Favorites::default()).unwrap();
    assert!(refs.head.detached);
    ops::checkout(&locks, r.path(), &CheckoutTarget::Commit { hash: c2.clone() }, &mut no_progress()).unwrap();
    assert_eq!(r.git(&["rev-parse", "HEAD"]), c2);
    assert_eq!(
        ops::checkout(&locks, r.path(), &CheckoutTarget::Commit { hash: "--force".into() }, &mut no_progress())
            .unwrap_err()
            .code,
        ErrorCode::InvalidArgument
    );
}

#[test]
fn checkout_would_overwrite() {
    let r = TestRepo::new();
    let locks = ops::RepoLocks::default();
    r.commit_file("a.txt", "a\n", "base");
    r.git(&["checkout", "-q", "-b", "other"]);
    r.commit_file("a.txt", "other\n", "other change");
    r.git(&["checkout", "-q", "main"]);
    r.write("a.txt", "dirty local\n");
    let e = ops::checkout(&locks, r.path(), &CheckoutTarget::LocalBranch { name: "other".into() }, &mut no_progress()).unwrap_err();
    assert_eq!(e.code, ErrorCode::WouldOverwrite);
}

#[test]
fn busy_when_locked() {
    let locks = Arc::new(ops::RepoLocks::default());
    let l2 = locks.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    let (tx2, rx2) = std::sync::mpsc::channel::<()>();
    let t = std::thread::spawn(move || {
        l2.run("/x", || {
            tx.send(()).unwrap();
            rx2.recv().unwrap();
            Ok(())
        })
    });
    rx.recv().unwrap();
    assert_eq!(locks.run("/x", || Ok(())).unwrap_err().code, ErrorCode::Busy);
    locks.run("/y", || Ok(())).unwrap();
    tx2.send(()).unwrap();
    t.join().unwrap().unwrap();
    locks.run("/x", || Ok(())).unwrap();
}

/// bare remote + two clones
fn remote_setup() -> (TempDir, PathBuf, PathBuf, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let bare = base.join("remote.git");
    let a = base.join("a");
    let b = base.join("b");
    std::fs::create_dir_all(&bare).unwrap();
    git_in(&bare, &["init", "-q", "--bare", "-b", "main"]);
    for d in [&a, &b] {
        std::fs::create_dir_all(d).unwrap();
        git_in(d, &["init", "-q", "-b", "main"]);
        git_in(d, &["remote", "add", "origin", bare.to_str().unwrap()]);
    }
    std::fs::write(a.join("f.txt"), "1\n").unwrap();
    git_in(&a, &["add", "-A"]);
    git_in(&a, &["commit", "-q", "-m", "c1"]);
    git_in(&a, &["push", "-q", "-u", "origin", "main"]);
    git_in(&b, &["fetch", "-q", "origin"]);
    git_in(&b, &["reset", "-q", "--hard", "origin/main"]);
    git_in(&b, &["branch", "-q", "--set-upstream-to=origin/main", "main"]);
    (tmp, bare, a, b)
}

#[test]
fn fetch_pull_ff_only_refusal() {
    let (_tmp, _bare, a, b) = remote_setup();
    let locks = ops::RepoLocks::default();
    let bp = b.to_str().unwrap();
    // A pushes, B diverges locally
    std::fs::write(a.join("g.txt"), "g\n").unwrap();
    git_in(&a, &["add", "-A"]);
    git_in(&a, &["commit", "-q", "-m", "from a"]);
    git_in(&a, &["push", "-q", "origin", "main"]);
    std::fs::write(b.join("h.txt"), "h\n").unwrap();
    git_in(&b, &["add", "-A"]);
    git_in(&b, &["commit", "-q", "-m", "local b"]);

    let mut lines = Vec::new();
    ops::fetch(&locks, bp, None, &mut |l: &str| lines.push(l.to_string())).unwrap();
    let refs = read_refs(bp, &Favorites::default()).unwrap();
    let main = refs.refs.iter().find(|r| r.full_name == "refs/heads/main").unwrap();
    assert_eq!(main.upstream.as_deref(), Some("refs/remotes/origin/main"));
    assert_eq!((main.ahead, main.behind), (Some(1), Some(1)));
    assert!(refs.refs.iter().any(|r| r.full_name == "refs/remotes/origin/main" && r.remote.as_deref() == Some("origin")));

    let e = ops::pull(&locks, bp, PullMode::FfOnly, &mut no_progress()).unwrap_err();
    assert_eq!(e.code, ErrorCode::NonFastForward, "{e:?}");
    ops::pull(&locks, bp, PullMode::Rebase, &mut no_progress()).unwrap();
    let main = read_refs(bp, &Favorites::default()).unwrap().refs.into_iter().find(|r| r.full_name == "refs/heads/main").unwrap();
    assert_eq!((main.ahead, main.behind), (Some(1), Some(0)));
}

#[test]
fn pull_merge_and_no_upstream_and_remote_checkout() {
    let (_tmp, _bare, a, b) = remote_setup();
    let locks = ops::RepoLocks::default();
    let bp = b.to_str().unwrap();
    // remote-only branch
    git_in(&a, &["checkout", "-q", "-b", "fix/login"]);
    std::fs::write(a.join("l.txt"), "l\n").unwrap();
    git_in(&a, &["add", "-A"]);
    git_in(&a, &["commit", "-q", "-m", "login fix"]);
    git_in(&a, &["push", "-q", "origin", "fix/login"]);
    ops::fetch(&locks, bp, Some("origin"), &mut no_progress()).unwrap();
    ops::checkout(
        &locks,
        bp,
        &CheckoutTarget::RemoteBranch { name: "origin/fix/login".into(), local_name: None },
        &mut no_progress(),
    )
    .unwrap();
    assert_eq!(git_in(&b, &["symbolic-ref", "--short", "HEAD"]), "fix/login");
    assert_eq!(git_in(&b, &["rev-parse", "--abbrev-ref", "fix/login@{upstream}"]), "origin/fix/login");
    // checking out again reuses the tracking local branch
    ops::checkout(&locks, bp, &CheckoutTarget::LocalBranch { name: "main".into() }, &mut no_progress()).unwrap();
    ops::checkout(
        &locks,
        bp,
        &CheckoutTarget::RemoteBranch { name: "origin/fix/login".into(), local_name: None },
        &mut no_progress(),
    )
    .unwrap();
    // conflicting local name
    git_in(&b, &["branch", "-q", "other-local", "main"]);
    let e = ops::checkout(
        &locks,
        bp,
        &CheckoutTarget::RemoteBranch { name: "origin/fix/login".into(), local_name: Some("other-local".into()) },
        &mut no_progress(),
    )
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidArgument);

    // no upstream
    git_in(&b, &["checkout", "-q", "-b", "lonely"]);
    let e = ops::pull(&locks, bp, PullMode::FfOnly, &mut no_progress()).unwrap_err();
    assert_eq!(e.code, ErrorCode::NoUpstream, "{e:?}");

    // merge pull creates merge commit
    git_in(&b, &["checkout", "-q", "main"]);
    std::fs::write(a.join("z.txt"), "z\n").unwrap();
    git_in(&a, &["checkout", "-q", "main"]);
    git_in(&a, &["add", "-A"]);
    git_in(&a, &["commit", "-q", "-m", "a again"]);
    git_in(&a, &["push", "-q", "origin", "main"]);
    std::fs::write(b.join("y.txt"), "y\n").unwrap();
    git_in(&b, &["add", "-A"]);
    git_in(&b, &["commit", "-q", "-m", "b again"]);
    ops::pull(&locks, bp, PullMode::Merge, &mut no_progress()).unwrap();
    assert_eq!(git_in(&b, &["rev-list", "--merges", "--count", "HEAD"]), "1");
}

#[test]
fn state_open_repo_recents_favorites_and_watcher() {
    let r = TestRepo::new();
    r.commit_file("a.txt", "a\n", "base");
    let state_dir = tempfile::tempdir().unwrap();
    let state = AppState::new(Some(state_dir.path().join("state.json")));
    let (tx, rx) = std::sync::mpsc::channel::<RepoChangedEvent>();
    let tx = std::sync::Mutex::new(tx);
    let info = state
        .open_repo(
            r.path(),
            Arc::new(move |ev| {
                let _ = tx.lock().unwrap().send(ev);
            }),
        )
        .unwrap();
    assert_eq!(info.path, r.path());
    assert_eq!(info.name, "work");
    assert_eq!(info.user.name.as_deref(), Some("Test User"));
    assert!(!info.git_version.is_empty());
    let recents = state.persist.recents();
    assert_eq!(recents.len(), 1);
    assert!(recents[0].exists);

    state.persist.set_favorite(r.path(), "refs/heads/main", false);
    let s = snapshot::load_log(&state.snapshots, r.path(), LogScope { refs: None, limit: None }, &state.persist.favorites(r.path())).unwrap();
    assert!(!s.refs.refs.iter().find(|x| x.full_name == "refs/heads/main").unwrap().is_favorite);

    std::thread::sleep(Duration::from_millis(600)); // let FSEvents settle
    while rx.try_recv().is_ok() {}
    r.git(&["commit", "-q", "--allow-empty", "-m", "touch"]);
    let ev = rx.recv_timeout(Duration::from_secs(5)).expect("repo-changed event");
    assert_eq!(ev.repo_path, r.path());
    assert!(ev.scopes.contains(&RepoChangeScope::Refs) || ev.scopes.contains(&RepoChangeScope::Head));

    state.snapshots.get(s.snapshot_id).unwrap();
    state.close_repo(r.path());
    assert_eq!(state.snapshots.get(s.snapshot_id).err().unwrap().code, ErrorCode::SnapshotExpired);
}

#[test]
fn merge_operation_detected() {
    let r = TestRepo::new();
    r.commit_file("a.txt", "base\n", "base");
    r.git(&["checkout", "-q", "-b", "x"]);
    r.commit_file("a.txt", "x\n", "x");
    r.git(&["checkout", "-q", "main"]);
    r.commit_file("a.txt", "main\n", "main");
    let out = Command::new("git")
        .arg("-C")
        .arg(&r.dir)
        .args(["merge", "x"])
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@e")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@e")
        .output()
        .unwrap();
    assert!(!out.status.success());
    let refs = read_refs(r.path(), &Favorites::default()).unwrap();
    assert_eq!(refs.operation, Some(RepoOperation::Merge));
}

// ---------- multi-repo / hardening ----------

fn diff_req(path: &str, from: Option<&str>, to: &str) -> DiffRequest {
    DiffRequest {
        path: path.into(),
        old_path: None,
        from_hash: from.map(str::to_string),
        to_hash: to.into(),
        context_lines: None,
    }
}

#[test]
fn literal_pathspecs() {
    let r = TestRepo::new();
    let base = r.commit_file("base.txt", "b\n", "base");
    r.write("f*.txt", "star\n");
    r.write("fa.txt", "fa\n");
    r.git(&["add", "-A"]);
    r.git(&["commit", "-q", "-m", "both"]);
    let both = r.git(&["rev-parse", "HEAD"]);
    r.commit_file("fa.txt", "fa2\n", "only fa");
    let d = diff::file_diff(r.path(), &diff_req("f*.txt", Some(&base), &both)).unwrap();
    let text: Vec<&str> = d.hunks.iter().flat_map(|h| h.lines.iter().map(|l| l.text.as_str())).collect();
    assert_eq!(text, vec!["star"], "glob must not pull in fa.txt");
    let d = diff::file_diff(r.path(), &diff_req(":(top)fa.txt", Some(&base), &both)).unwrap();
    assert!(d.hunks.is_empty(), "pathspec magic must be literal");

    let store = SnapshotStore::default();
    let snap = r.load(&store);
    let s = store.get(snap.snapshot_id).unwrap();
    let f = LogFilter { text: None, users: None, date: None, paths: Some(vec!["f*.txt".into()]) };
    let m = snapshot::filter_commits(&s, &f).unwrap().matches.unwrap();
    assert_eq!(m.len(), 1);
    assert_eq!(snap.hashes[m[0] as usize], both);
}

#[test]
fn diff_is_truncated_while_streaming() {
    let r = TestRepo::new();
    let base = r.commit_file("a.txt", "x\n", "base");
    let line = "y".repeat(999);
    let big: String = (0..4000).map(|_| format!("{line}\n")).collect(); // ~4 MB, 4000 lines
    let h = r.commit_file("big.txt", &big, "big");
    let d = diff::file_diff(r.path(), &diff_req("big.txt", Some(&base), &h)).unwrap();
    assert!(d.truncated);
    let n: usize = d.hunks.iter().map(|h| h.lines.len()).sum();
    assert!(n > 0 && n < 4000, "got {n} lines");
    // small diffs are not flagged
    let d = diff::file_diff(r.path(), &diff_req("a.txt", None, &base)).unwrap();
    assert!(!d.truncated);
}

#[test]
fn hash_validation() {
    let r = TestRepo::new();
    let h = r.commit_file("a.txt", "x\n", "c");
    for bad in [&h[..4], &h[..12], "", "zz", &"g".repeat(40)] {
        let e = diff::file_diff(r.path(), &diff_req("a.txt", None, bad)).unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidArgument, "{bad}");
        assert_eq!(changes::changed_files(r.path(), &[bad.to_string()]).unwrap_err().code, ErrorCode::InvalidArgument);
    }
    let locks = ops::RepoLocks::default();
    let e = ops::checkout(&locks, r.path(), &CheckoutTarget::Commit { hash: h[..8].into() }, &mut no_progress()).unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidArgument);
    // uppercase full hash is normalised
    diff::file_diff(r.path(), &diff_req("a.txt", None, &h.to_uppercase())).unwrap();
}

#[test]
fn path_filter_on_unborn_repo() {
    let r = TestRepo::new();
    let store = SnapshotStore::default();
    let snap = snapshot::load_log(
        &store,
        r.path(),
        LogScope { refs: Some(vec!["HEAD".into()]), limit: None },
        &Favorites::default(),
    )
    .unwrap();
    let s = store.get(snap.snapshot_id).unwrap();
    let f = LogFilter { text: None, users: None, date: None, paths: Some(vec!["a.txt".into()]) };
    assert_eq!(snapshot::filter_commits(&s, &f).unwrap().matches, Some(vec![]));
}

#[test]
fn two_repos_independent_snapshots_and_eviction() {
    let a = TestRepo::new();
    a.commit_file("a.txt", "a\n", "a1");
    let b = TestRepo::new();
    b.commit_file("b.txt", "b\n", "b1");
    let store = SnapshotStore::default();
    let a1 = a.load(&store).snapshot_id;
    let b1 = b.load(&store).snapshot_id;
    let a2 = a.load(&store).snapshot_id;
    let a3 = a.load(&store).snapshot_id;
    let a4 = a.load(&store).snapshot_id;
    // A keeps only its 2 newest; B's snapshot is untouched by A's churn
    assert_eq!(store.get(a1).err().unwrap().code, ErrorCode::SnapshotExpired);
    assert_eq!(store.get(a2).err().unwrap().code, ErrorCode::SnapshotExpired);
    store.get(a3).unwrap();
    store.get(a4).unwrap();
    let sb = store.get(b1).unwrap();
    assert_eq!(sb.repo_path, b.path());
    // trailing-slash alias maps to the same repo budget
    let alias = format!("{}/", b.path());
    let b2 = snapshot::load_log(&store, &alias, LogScope { refs: None, limit: None }, &Favorites::default()).unwrap().snapshot_id;
    let b3 = b.load(&store).snapshot_id;
    assert_eq!(store.get(b1).err().unwrap().code, ErrorCode::SnapshotExpired);
    store.get(b2).unwrap();
    store.get(b3).unwrap();
    // closing A leaves B alone
    store.release_repo(a.path());
    assert!(store.get(a3).is_err() && store.get(a4).is_err());
    store.get(b3).unwrap();
}

#[test]
fn load_finishing_after_close_is_dropped() {
    let r = TestRepo::new();
    r.commit_file("a.txt", "a\n", "c");
    let store = SnapshotStore::default();
    let key = lanes_lib::git::repo::canonical_key(r.path());
    let gen_at_start = store.generation(&key);
    store.release_repo(r.path()); // tab closed while the load was in flight
    let id = store.next_id();
    let snap = snapshot::Snapshot {
        id,
        repo_path: r.path().into(),
        key: key.clone(),
        revs: vec![],
        records: vec![],
        hash_index: Default::default(),
    };
    assert!(store.insert_if_current(snap, gen_at_start).is_none());
    assert_eq!(store.get(id).err().unwrap().code, ErrorCode::SnapshotExpired);
    // a load that starts after the close works normally
    let ok = r.load(&store);
    store.get(ok.snapshot_id).unwrap();
}

#[test]
fn locks_are_per_canonical_repo() {
    let a = TestRepo::new();
    let locks = ops::RepoLocks::default();
    let alias = format!("{}/", a.path());
    let r = locks.run(a.path(), || locks.run(&alias, || Ok(())));
    assert_eq!(r.unwrap_err().code, ErrorCode::Busy);
}

#[cfg(unix)]
#[test]
fn write_op_timeout_kills_git_and_releases_lock() {
    use std::os::unix::fs::PermissionsExt;
    let r = TestRepo::new();
    r.commit_file("a.txt", "a\n", "base");
    r.git(&["branch", "other"]);
    let hook = r.dir.join(".git/hooks/post-checkout");
    std::fs::write(&hook, "#!/bin/sh\nsleep 30\n").unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    let locks = ops::RepoLocks::with_timeouts(Duration::from_millis(500), Duration::from_millis(500));
    let t = std::time::Instant::now();
    let e = ops::checkout(&locks, r.path(), &CheckoutTarget::LocalBranch { name: "other".into() }, &mut no_progress()).unwrap_err();
    assert_eq!(e.code, ErrorCode::GitFailed);
    assert!(e.message.contains("timed out"), "{}", e.message);
    assert!(t.elapsed() < Duration::from_secs(10));
    // lock released: next op is not `busy`
    std::fs::remove_file(&hook).unwrap();
    let _ = std::fs::remove_file(r.dir.join(".git/index.lock"));
    let e = ops::delete_branch(&locks, r.path(), "nonexistent", false).unwrap_err();
    assert_ne!(e.code, ErrorCode::Busy);
}

#[test]
fn two_repos_watch_independently() {
    let a = TestRepo::new();
    a.commit_file("a.txt", "a\n", "base");
    let b = TestRepo::new();
    b.commit_file("b.txt", "b\n", "base");
    let state = AppState::new(None);
    let (tx, rx) = std::sync::mpsc::channel::<RepoChangedEvent>();
    let tx = std::sync::Mutex::new(tx);
    let emit: lanes_lib::watcher::Emitter = Arc::new(move |ev| {
        let _ = tx.lock().unwrap().send(ev);
    });
    state.open_repo(a.path(), emit.clone()).unwrap();
    state.open_repo(b.path(), emit).unwrap();
    std::thread::sleep(Duration::from_millis(600));
    while rx.try_recv().is_ok() {}
    a.git(&["commit", "-q", "--allow-empty", "-m", "a-touch"]);
    let ev = rx.recv_timeout(Duration::from_secs(5)).expect("event for A");
    assert_eq!(ev.repo_path, a.path());
    state.close_repo(a.path());
    std::thread::sleep(Duration::from_millis(600));
    while rx.try_recv().is_ok() {}
    a.git(&["commit", "-q", "--allow-empty", "-m", "a-after-close"]);
    b.git(&["commit", "-q", "--allow-empty", "-m", "b-touch"]);
    let ev = rx.recv_timeout(Duration::from_secs(5)).expect("event for B");
    assert_eq!(ev.repo_path, b.path());
    assert!(rx.recv_timeout(Duration::from_millis(900)).is_err(), "A's watcher must be stopped");
}

#[test]
fn file_history_follows_rename_and_blame() {
    let r = TestRepo::new();
    let c1 = r.commit_file("a.txt", "one\ntwo\nthree\n", "create");
    let c2 = r.commit_file("a.txt", "one\ntwo changed\nthree\n", "modify");
    r.commit_file("other.txt", "x\n", "unrelated");
    r.git(&["mv", "a.txt", "dir_b.txt"]);
    r.git(&["commit", "-q", "-m", "rename"]);
    let c3 = r.git(&["rev-parse", "HEAD"]);
    let c4 = r.commit_file("dir_b.txt", "one\ntwo changed\nthree\nfour\n", "append");

    let h = file::file_history(r.path(), "dir_b.txt", None).unwrap();
    assert!(!h.truncated);
    let hashes: Vec<&str> = h.entries.iter().map(|e| e.hash.as_str()).collect();
    assert_eq!(hashes, vec![c4.as_str(), c3.as_str(), c2.as_str(), c1.as_str()]);
    let e = &h.entries;
    assert_eq!((e[0].status, e[0].path.as_str(), e[0].old_path.clone()), (FileStatus::Modified, "dir_b.txt", None));
    assert_eq!((e[0].additions, e[0].deletions), (Some(1), Some(0)));
    assert_eq!(e[1].status, FileStatus::Renamed);
    assert_eq!(e[1].old_path.as_deref(), Some("a.txt"));
    assert_eq!(e[1].path, "dir_b.txt");
    assert_eq!(e[2].path, "a.txt");
    assert_eq!(e[2].status, FileStatus::Modified);
    assert_eq!(e[3].status, FileStatus::Added);
    assert_eq!(e[3].parents.len(), 0);
    assert_eq!(e[0].subject, "append");
    assert_eq!(e[0].parents, vec![c3.clone()]);

    let b = file::blame(r.path(), "dir_b.txt", "HEAD").unwrap();
    assert!(!b.binary && !b.truncated);
    let who: Vec<&str> = b.lines.iter().map(|l| l.hash.as_str()).collect();
    assert_eq!(who, vec![c1.as_str(), c2.as_str(), c1.as_str(), c4.as_str()]);
    assert_eq!(b.lines[1].text, "two changed");
    assert_eq!(b.lines[0].orig_path, "a.txt");
    assert_eq!(b.lines[3].orig_path, "dir_b.txt");
    assert_eq!(b.commits.len(), 3);
    assert_eq!(b.commits[0].hash, c1);
    assert!(b.commits[0].boundary);
    assert_eq!(b.commits[1].subject, "modify");
    assert_eq!(b.commits[0].author_email, "test@example.com");

    let files = file::list_files(r.path(), None).unwrap();
    assert_eq!(files, vec!["dir_b.txt".to_string(), "other.txt".to_string()]);
    assert!(file::blame(r.path(), "nope.txt", "HEAD").is_err());
}

#[test]
fn blame_binary_and_unborn_files() {
    let r = TestRepo::new();
    assert!(file::list_files(r.path(), None).unwrap().is_empty());
    assert!(file::file_history(r.path(), "x", None).unwrap().entries.is_empty());
    let p = r.dir.join("img.bin");
    std::fs::write(&p, [0u8, 1, 2, 0, 255]).unwrap();
    r.git(&["add", "-A"]);
    r.git(&["commit", "-q", "-m", "bin"]);
    let b = file::blame(r.path(), "img.bin", "HEAD").unwrap();
    assert!(b.binary && b.lines.is_empty());
    let h = file::file_history(r.path(), "img.bin", Some("HEAD")).unwrap();
    assert_eq!(h.entries.len(), 1);
    assert!(h.entries[0].binary);
    assert_eq!(h.entries[0].additions, None);
}
