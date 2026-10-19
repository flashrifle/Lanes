//! Integration tests for the v0.1 write ops, working-tree status, history exploration and settings.
use lanes_lib::app::settings as app_settings;
use lanes_lib::error::ErrorCode;
use lanes_lib::git::ops::RepoLocks;
use lanes_lib::git::refs::Favorites;
use lanes_lib::git::{commit, diff, linehist, ops, push, reflog, runner, sequence, stage, stash, status, tags};
use lanes_lib::models::*;
use lanes_lib::persist::Persist;
use lanes_lib::snapshot::{self, SnapshotStore};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicI64, Ordering};
use tempfile::TempDir;

static CLOCK: AtomicI64 = AtomicI64::new(1_700_000_000);

fn git_in(dir: &Path, args: &[&str]) -> String {
    let out = git_raw(dir, args);
    assert!(out.status.success(), "git {:?} failed: {}", args, String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim_end_matches('\n').to_string()
}

fn git_raw(dir: &Path, args: &[&str]) -> std::process::Output {
    let t = CLOCK.fetch_add(60, Ordering::SeqCst);
    let date = format!("{t} +0000");
    Command::new("git")
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
        .expect("run git")
}

struct TestRepo {
    _tmp: TempDir,
    dir: PathBuf,
    remote: Option<PathBuf>,
    locks: RepoLocks,
}

impl TestRepo {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let dir = root.join("work");
        std::fs::create_dir_all(&dir).unwrap();
        git_in(&dir, &["init", "-q", "-b", "main"]);
        git_in(&dir, &["config", "user.name", "Test User"]);
        git_in(&dir, &["config", "user.email", "test@example.com"]);
        git_in(&dir, &["config", "commit.gpgsign", "false"]);
        git_in(&dir, &["config", "tag.gpgsign", "false"]);
        TestRepo { _tmp: tmp, dir, remote: None, locks: RepoLocks::default() }
    }

    /// Adds a bare remote named origin (next to the work dir).
    fn with_remote(mut self) -> Self {
        let bare = self.dir.parent().unwrap().join("remote.git");
        std::fs::create_dir_all(&bare).unwrap();
        git_in(&bare, &["init", "-q", "--bare", "-b", "main"]);
        git_in(&self.dir, &["remote", "add", "origin", bare.to_str().unwrap()]);
        self.remote = Some(bare);
        self
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
    fn read(&self, name: &str) -> String {
        std::fs::read_to_string(self.dir.join(name)).unwrap()
    }
    fn commit_file(&self, name: &str, content: &str, msg: &str) -> String {
        self.write(name, content);
        self.git(&["add", "-A"]);
        self.git(&["commit", "-q", "-m", msg]);
        self.git(&["rev-parse", "HEAD"])
    }
    fn head(&self) -> String {
        self.git(&["rev-parse", "HEAD"])
    }
    fn status(&self) -> WorkingTreeStatus {
        status::read(self.path()).unwrap()
    }
    fn file(&self, st: &WorkingTreeStatus, p: &str) -> StatusFile {
        st.files.iter().find(|f| f.path == p).unwrap_or_else(|| panic!("{p} not in status: {:?}", st.files)).clone()
    }
    fn stage(&self, paths: &[&str]) {
        stage::stage_files(&self.locks, self.path(), &strs(paths)).unwrap();
    }
    /// Two branches that conflict on f.txt: main changes line 1, `feature` changes line 1 differently.
    fn conflict_setup(&self) -> (String, String) {
        self.commit_file("f.txt", "base\nsecond\n", "base");
        self.git(&["checkout", "-q", "-b", "feature"]);
        let f = self.commit_file("f.txt", "feature\nsecond\n", "feature change");
        self.git(&["checkout", "-q", "main"]);
        let m = self.commit_file("f.txt", "main\nsecond\n", "main change");
        (m, f)
    }
}

fn strs(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

fn quiet() -> impl FnMut(&str) {
    |_: &str| {}
}

fn code<T: std::fmt::Debug>(r: lanes_lib::error::Result<T>) -> ErrorCode {
    r.expect_err("expected an error").code
}

// ───────────── status ─────────────

#[test]
fn status_records_and_branch_fields() {
    let r = TestRepo::new().with_remote();
    r.commit_file("a.txt", "a\n", "one");
    r.commit_file("keep.txt", "k\n", "two");
    r.git(&["push", "-q", "-u", "origin", "main"]);
    r.commit_file("c.txt", "c\n", "ahead");
    // working tree changes
    r.write("a.txt", "a changed\n");
    r.write("new staged.txt", "n\n");
    r.git(&["add", "new staged.txt"]);
    r.git(&["mv", "keep.txt", "moved.txt"]);
    r.write("untracked/deep/u.txt", "u\n");
    let st = r.status();
    assert_eq!(st.branch.as_deref(), Some("main"));
    assert_eq!(st.upstream.as_deref(), Some("refs/remotes/origin/main"));
    assert_eq!((st.ahead, st.behind), (Some(1), Some(0)));
    assert_eq!(st.head_hash.as_deref(), Some(r.head().as_str()));
    assert!(!st.truncated && st.operation.is_none());
    assert_eq!(r.file(&st, "a.txt").unstaged, Some(FileStatus::Modified));
    assert_eq!(r.file(&st, "new staged.txt").staged, Some(FileStatus::Added));
    let mv = r.file(&st, "moved.txt");
    assert_eq!((mv.staged, mv.old_path.as_deref()), (Some(FileStatus::Renamed), Some("keep.txt")));
    let u = r.file(&st, "untracked/deep/u.txt");
    assert!(u.untracked && u.staged.is_none());
    let paths: Vec<&str> = st.files.iter().map(|f| f.path.as_str()).collect();
    let mut sorted = paths.clone();
    sorted.sort();
    assert_eq!(paths, sorted);
}

#[test]
fn status_unborn_and_detached() {
    let r = TestRepo::new();
    r.write("x.txt", "x\n");
    let st = r.status();
    assert_eq!((st.head_hash.clone(), st.branch.clone()), (None, Some("main".into())));
    assert!(r.file(&st, "x.txt").untracked);
    r.commit_file("x.txt", "x\n", "c");
    r.git(&["checkout", "-q", "--detach"]);
    let st = r.status();
    assert_eq!(st.branch, None);
    assert!(st.head_hash.is_some());
}

#[test]
fn status_submodule_flag() {
    let r = TestRepo::new();
    let sub = TestRepo::new();
    sub.commit_file("s.txt", "s\n", "sub");
    r.commit_file("a.txt", "a\n", "one");
    r.git(&["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub.path(), "vendor"]);
    let st = r.status();
    let f = r.file(&st, "vendor");
    assert!(f.submodule, "{f:?}");
    assert_eq!(f.staged, Some(FileStatus::Added));
}

#[test]
fn status_conflict_kinds() {
    let r = TestRepo::new();
    r.conflict_setup();
    let _ = git_raw(&r.dir, &["merge", "feature"]);
    let st = r.status();
    assert_eq!(r.file(&st, "f.txt").conflict, Some(ConflictKind::BothModified));
    let op = st.operation.unwrap();
    assert_eq!(op.operation, RepoOperation::Merge);
    assert!(!op.can_continue && !op.can_skip);
    assert!(op.stopped_at.is_some());
}

// ───────────── operation state ─────────────

#[test]
fn operation_state_rebase_step_total() {
    let r = TestRepo::new();
    r.commit_file("f.txt", "base\nsecond\nthird\n", "base");
    r.git(&["checkout", "-q", "-b", "feature"]);
    r.commit_file("one.txt", "1\n", "f1");
    r.commit_file("f.txt", "feature\nsecond\nthird\n", "f2 conflicts");
    r.commit_file("three.txt", "3\n", "f3");
    r.git(&["checkout", "-q", "main"]);
    let onto = r.commit_file("f.txt", "main\nsecond\nthird\n", "main change");
    r.git(&["checkout", "-q", "feature"]);
    let out = sequence::rebase(&r.locks, r.path(), "main", &mut quiet()).unwrap();
    assert!(out.conflicts);
    assert_eq!(out.operation, Some(RepoOperation::Rebase));
    let op = r.status().operation.unwrap();
    assert_eq!(op.operation, RepoOperation::Rebase);
    assert_eq!((op.step, op.total), (Some(2), Some(3)));
    assert_eq!(op.head_name.as_deref(), Some("feature"));
    assert_eq!(op.onto_hash.as_deref(), Some(onto.as_str()));
    assert!(op.stopped_at.is_some());
    assert!(!op.can_continue && op.can_skip);
}

#[test]
fn operation_state_cherry_pick_sequence() {
    let r = TestRepo::new();
    r.commit_file("f.txt", "base\nsecond\n", "base");
    r.git(&["checkout", "-q", "-b", "feature"]);
    let c1 = r.commit_file("one.txt", "1\n", "c1");
    let c2 = r.commit_file("f.txt", "feature\nsecond\n", "c2 conflicts");
    let c3 = r.commit_file("three.txt", "3\n", "c3");
    r.git(&["checkout", "-q", "main"]);
    r.commit_file("f.txt", "main\nsecond\n", "main change");
    let out = sequence::cherry_pick(
        &r.locks,
        r.path(),
        &CherryPickRequest { hashes: vec![c1, c2.clone(), c3], record_origin: false, mainline: None },
        &mut quiet(),
    )
    .unwrap();
    assert!(out.conflicts);
    assert_eq!(out.operation, Some(RepoOperation::CherryPick));
    let op = r.status().operation.unwrap();
    assert_eq!(op.stopped_at.as_deref(), Some(c2.as_str()));
    assert_eq!((op.step, op.total), (Some(2), Some(3)));
    assert!(op.can_skip && !op.can_continue);
}

// ───────────── stage / unstage / discard ─────────────

#[test]
fn stage_unstage_including_unborn_and_deletions() {
    let r = TestRepo::new();
    r.write("a.txt", "a\n");
    // unborn: stage then unstage (git rm --cached)
    r.stage(&["a.txt"]);
    assert_eq!(r.file(&r.status(), "a.txt").staged, Some(FileStatus::Added));
    stage::unstage_files(&r.locks, r.path(), &strs(&["a.txt"])).unwrap();
    assert!(r.file(&r.status(), "a.txt").untracked);
    r.stage(&["a.txt"]);
    r.git(&["commit", "-q", "-m", "one"]);
    // deletion
    std::fs::remove_file(r.dir.join("a.txt")).unwrap();
    assert_eq!(r.file(&r.status(), "a.txt").unstaged, Some(FileStatus::Deleted));
    r.stage(&["a.txt"]);
    assert_eq!(r.file(&r.status(), "a.txt").staged, Some(FileStatus::Deleted));
    stage::unstage_files(&r.locks, r.path(), &strs(&["a.txt"])).unwrap();
    assert_eq!(r.file(&r.status(), "a.txt").unstaged, Some(FileStatus::Deleted));
    // path validation
    assert_eq!(code(stage::stage_files(&r.locks, r.path(), &strs(&["../x"]))), ErrorCode::InvalidArgument);
    assert_eq!(code(stage::stage_files(&r.locks, r.path(), &strs(&[""]))), ErrorCode::InvalidArgument);
    assert_eq!(code(stage::stage_files(&r.locks, r.path(), &[])), ErrorCode::InvalidArgument);
    assert_eq!(code(stage::stage_files(&r.locks, r.path(), &strs(&["/etc/passwd"]))), ErrorCode::InvalidArgument);
}

#[test]
fn literal_pathspecs_for_glob_names() {
    let r = TestRepo::new();
    r.commit_file("keep.txt", "k\n", "one");
    r.write("*.txt", "star\n");
    r.write("other.txt", "o\n");
    r.stage(&["*.txt"]);
    let st = r.status();
    assert_eq!(r.file(&st, "*.txt").staged, Some(FileStatus::Added));
    assert!(r.file(&st, "other.txt").untracked, "glob must not match other files");
}

#[test]
fn discard_tracked_staged_and_untracked() {
    let r = TestRepo::new();
    r.commit_file("a.txt", "a\n", "one");
    r.commit_file("b.txt", "b\n", "two");
    // worktree-only discard restores from the index
    r.write("a.txt", "staged change\n");
    r.stage(&["a.txt"]);
    r.write("a.txt", "worktree change\n");
    stage::discard_files(
        &r.locks,
        r.path(),
        &DiscardRequest { paths: strs(&["a.txt"]), untracked_paths: vec![], include_staged: false },
    )
    .unwrap();
    assert_eq!(r.read("a.txt"), "staged change\n");
    assert_eq!(r.file(&r.status(), "a.txt").staged, Some(FileStatus::Modified));
    // includeStaged resets index and worktree to HEAD; staged-new files are removed
    r.write("new.txt", "n\n");
    r.stage(&["new.txt"]);
    stage::discard_files(
        &r.locks,
        r.path(),
        &DiscardRequest { paths: strs(&["a.txt", "new.txt"]), untracked_paths: vec![], include_staged: true },
    )
    .unwrap();
    assert_eq!(r.read("a.txt"), "a\n");
    assert!(!r.dir.join("new.txt").exists());
    assert!(r.status().files.is_empty());
    // untracked
    r.write("junk/x.txt", "x\n");
    r.write("junk2.txt", "y\n");
    stage::discard_files(
        &r.locks,
        r.path(),
        &DiscardRequest { paths: vec![], untracked_paths: strs(&["junk/x.txt", "junk2.txt"]), include_staged: false },
    )
    .unwrap();
    assert!(!r.dir.join("junk/x.txt").exists() && !r.dir.join("junk2.txt").exists());
    // tracked file is not "untracked": refused, and nothing deleted
    assert_eq!(
        code(stage::discard_files(
            &r.locks,
            r.path(),
            &DiscardRequest { paths: vec![], untracked_paths: strs(&["b.txt"]), include_staged: false }
        )),
        ErrorCode::InvalidArgument
    );
    assert!(r.dir.join("b.txt").exists());
    // ignored files are refused
    r.commit_file(".gitignore", "ignored.log\n", "ignore");
    r.write("ignored.log", "log\n");
    assert_eq!(
        code(stage::discard_files(
            &r.locks,
            r.path(),
            &DiscardRequest { paths: vec![], untracked_paths: strs(&["ignored.log"]), include_staged: false }
        )),
        ErrorCode::InvalidArgument
    );
    assert!(r.dir.join("ignored.log").exists());
}

// ───────────── apply_patch ─────────────

fn raw_diff(r: &TestRepo, args: &[&str]) -> String {
    let mut a = vec!["diff", "--no-color", "--no-ext-diff"];
    a.extend_from_slice(args);
    let o = git_raw(&r.dir, &a);
    String::from_utf8_lossy(&o.stdout).into_owned()
}

const HUNK_B: &str = "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n";

fn patch_req(path: &str, patch: &str, target: PatchTarget, reverse: bool) -> ApplyPatchRequest {
    ApplyPatchRequest { path: path.into(), patch: patch.into(), target, reverse }
}

#[test]
fn apply_patch_forward_reverse_and_worktree() {
    let r = TestRepo::new();
    r.commit_file("f.txt", "a\nb\nc\nd\ne\n", "base");
    r.write("f.txt", "a\nB\nc\nD\ne\n");
    // stage only the first change
    stage::apply_patch(&r.locks, r.path(), &patch_req("f.txt", HUNK_B, PatchTarget::Index, false)).unwrap();
    assert_eq!(r.git(&["show", ":f.txt"]), "a\nB\nc\nd\ne");
    let unstaged = raw_diff(&r, &[]);
    assert!(unstaged.contains("-d") && unstaged.contains("+D") && !unstaged.contains("+B"));
    // unstage it again: the staged diff applied in reverse to the index
    stage::apply_patch(&r.locks, r.path(), &patch_req("f.txt", HUNK_B, PatchTarget::Index, true)).unwrap();
    assert_eq!(r.git(&["show", ":f.txt"]), "a\nb\nc\nd\ne");
    // discard the first hunk from the worktree (reverse, worktree)
    stage::apply_patch(&r.locks, r.path(), &patch_req("f.txt", HUNK_B, PatchTarget::Worktree, true)).unwrap();
    assert_eq!(r.read("f.txt"), "a\nb\nc\nD\ne\n");
    // a forward worktree patch is not allowed
    assert_eq!(
        code(stage::apply_patch(&r.locks, r.path(), &patch_req("f.txt", HUNK_B, PatchTarget::Worktree, false))),
        ErrorCode::InvalidArgument
    );
}

#[test]
fn apply_patch_stale_and_mismatched_paths() {
    let r = TestRepo::new();
    r.commit_file("f.txt", "a\nb\nc\nd\ne\n", "base");
    r.write("f.txt", "a\nX\nc\nd\ne\n"); // line b no longer matches the patch in the index
    r.stage(&["f.txt"]);
    assert_eq!(
        code(stage::apply_patch(&r.locks, r.path(), &patch_req("f.txt", HUNK_B, PatchTarget::Index, false))),
        ErrorCode::PatchFailed
    );
    assert_eq!(
        code(stage::apply_patch(&r.locks, r.path(), &patch_req("other.txt", HUNK_B, PatchTarget::Index, false))),
        ErrorCode::InvalidArgument
    );
    let two = format!("{HUNK_B}diff --git a/g.txt b/g.txt\n--- a/g.txt\n+++ b/g.txt\n@@ -1 +1 @@\n-x\n+y\n");
    // header scan stops at the first hunk, so a second file is caught by git (patchFailed) or by validation
    let c = code(stage::apply_patch(&r.locks, r.path(), &patch_req("f.txt", &two, PatchTarget::Index, false)));
    assert!(matches!(c, ErrorCode::PatchFailed | ErrorCode::InvalidArgument));
    assert_eq!(
        code(stage::apply_patch(&r.locks, r.path(), &patch_req("f.txt", "not a patch\n", PatchTarget::Index, false))),
        ErrorCode::InvalidArgument
    );
    // index untouched by every failure
    assert_eq!(r.git(&["show", ":f.txt"]), "a\nX\nc\nd\ne");
}

#[test]
fn apply_patch_no_newline_and_crlf() {
    let r = TestRepo::new();
    r.commit_file("n.txt", "x\ny", "no newline at eof");
    r.write("n.txt", "x\nz");
    let patch = raw_diff(&r, &["--", "n.txt"]);
    assert!(patch.contains("\\ No newline at end of file"));
    stage::apply_patch(&r.locks, r.path(), &patch_req("n.txt", &patch, PatchTarget::Index, false)).unwrap();
    assert_eq!(r.git(&["show", ":n.txt"]), "x\nz");
    stage::apply_patch(&r.locks, r.path(), &patch_req("n.txt", &patch, PatchTarget::Index, true)).unwrap();
    assert_eq!(r.git(&["show", ":n.txt"]), "x\ny");

    r.git(&["config", "core.autocrlf", "false"]);
    r.commit_file("c.txt", "one\r\ntwo\r\nthree\r\n", "crlf");
    r.write("c.txt", "one\r\nTWO\r\nthree\r\n");
    let patch = raw_diff(&r, &["--", "c.txt"]);
    assert!(patch.contains("-two\r\n"));
    stage::apply_patch(&r.locks, r.path(), &patch_req("c.txt", &patch, PatchTarget::Index, false)).unwrap();
    assert_eq!(r.git(&["show", ":c.txt"]), "one\r\nTWO\r\nthree\r");
    stage::apply_patch(&r.locks, r.path(), &patch_req("c.txt", &patch, PatchTarget::Worktree, true)).unwrap();
    assert_eq!(r.read("c.txt"), "one\r\ntwo\r\nthree\r\n");
}

#[test]
fn apply_patch_quoted_path() {
    let r = TestRepo::new();
    r.commit_file("a b.txt", "a\nb\nc\n", "base");
    r.write("a b.txt", "a\nB\nc\n");
    let patch = raw_diff(&r, &["--", "a b.txt"]);
    stage::apply_patch(&r.locks, r.path(), &patch_req("a b.txt", &patch, PatchTarget::Index, false)).unwrap();
    assert_eq!(r.git(&["show", ":a b.txt"]), "a\nB\nc");
}

/// Golden patches written by the TS patch builder (vitest). Skips when there are none.
#[test]
fn golden_patches_from_ts_apply_cleanly() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/ui/commit/__fixtures__");
    let Ok(rd) = std::fs::read_dir(&dir) else {
        eprintln!("no golden fixtures directory; skipping");
        return;
    };
    let mut files: Vec<PathBuf> = rd.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "json")).collect();
    files.sort();
    if files.is_empty() {
        eprintln!("no golden fixtures; skipping");
        return;
    }
    for f in files {
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&f).unwrap()).unwrap();
        let name = f.file_name().unwrap().to_string_lossy().into_owned();
        let Some(patch) = v["patch"].as_str().filter(|p| !p.is_empty()) else { continue };
        let path = v["diff"]["path"].as_str().unwrap_or("f.txt").to_string();
        // before/after = content of the patched target (index for stage/unstage, worktree for discard)
        let (before, after) = (v["before"].as_str().unwrap_or(""), v["after"].as_str().unwrap_or(""));
        let mode = v["mode"].as_str().unwrap_or("stage");
        let r = TestRepo::new();
        r.commit_file("seed.txt", "seed\n", "seed");
        let (target, reverse) = match mode {
            "stage" => {
                r.commit_file(&path, before, "target at before");
                (PatchTarget::Index, false)
            }
            "unstage" => {
                r.write(&path, before);
                r.stage(&[&path]);
                (PatchTarget::Index, true)
            }
            "discard" => {
                r.commit_file(&path, before, "target at before");
                r.write(&path, before);
                (PatchTarget::Worktree, true)
            }
            other => panic!("{name}: unknown mode {other}"),
        };
        stage::apply_patch(&r.locks, r.path(), &patch_req(&path, patch, target, reverse))
            .unwrap_or_else(|e| panic!("{name}: patch from the TS builder was rejected: {e:?}"));
        let result = if mode == "discard" {
            std::fs::read(r.dir.join(&path)).unwrap()
        } else {
            git_raw(&r.dir, &["show", &format!(":{path}")]).stdout
        };
        assert_eq!(String::from_utf8_lossy(&result), after, "{name}: result differs from the fixture's `after`");
    }
}

// ───────────── sentinel diffs ─────────────

fn dreq(path: &str, from: Option<&str>, to: &str) -> DiffRequest {
    DiffRequest { path: path.into(), old_path: None, from_hash: from.map(String::from), to_hash: to.into(), context_lines: None }
}

#[test]
fn sentinel_diffs() {
    let r = TestRepo::new();
    let head = r.commit_file("f.txt", "a\nb\n", "base");
    r.write("f.txt", "a\nstaged\n");
    r.stage(&["f.txt"]);
    r.write("f.txt", "a\nstaged\nworktree\n");
    let staged = diff::file_diff(r.path(), &dreq("f.txt", Some(&head), REV_INDEX)).unwrap();
    let adds: Vec<&str> = staged.hunks[0].lines.iter().filter(|l| l.kind == DiffLineKind::Add).map(|l| l.text.as_str()).collect();
    assert_eq!(adds, vec!["staged"]);
    let unstaged = diff::file_diff(r.path(), &dreq("f.txt", Some(REV_INDEX), REV_WORKTREE)).unwrap();
    let adds: Vec<&str> = unstaged.hunks[0].lines.iter().filter(|l| l.kind == DiffLineKind::Add).map(|l| l.text.as_str()).collect();
    assert_eq!(adds, vec!["worktree"]);
    let combined = diff::file_diff(r.path(), &dreq("f.txt", Some(&head), REV_WORKTREE)).unwrap();
    assert_eq!(combined.hunks[0].lines.iter().filter(|l| l.kind == DiffLineKind::Add).count(), 2);
    // untracked: (null, WORKTREE) => --no-index against /dev/null, exit 1 is fine
    r.write("fresh.txt", "one\ntwo\n");
    let fresh = diff::file_diff(r.path(), &dreq("fresh.txt", None, REV_WORKTREE)).unwrap();
    assert_eq!(fresh.hunks[0].lines.len(), 2);
    assert!(fresh.hunks[0].lines.iter().all(|l| l.kind == DiffLineKind::Add));
    // staged new file against the empty tree on an unborn-like base
    r.stage(&["fresh.txt"]);
    let added = diff::file_diff(r.path(), &dreq("fresh.txt", Some(&head), REV_INDEX)).unwrap();
    assert_eq!(added.hunks[0].lines.len(), 2);
    // bad requests
    assert_eq!(code(diff::file_diff(r.path(), &dreq("f.txt", Some(REV_INDEX), &head))), ErrorCode::InvalidArgument);
    assert_eq!(code(diff::file_diff(r.path(), &dreq("../f.txt", None, REV_WORKTREE))), ErrorCode::InvalidArgument);
}

#[test]
fn sentinel_diff_on_unborn_repo() {
    let r = TestRepo::new();
    r.write("a.txt", "x\n");
    r.stage(&["a.txt"]);
    let staged = diff::file_diff(r.path(), &dreq("a.txt", None, REV_INDEX)).unwrap();
    assert_eq!(staged.hunks[0].lines.len(), 1);
    // tracked-in-index file, null base: combined diff against the empty tree
    let combined = diff::file_diff(r.path(), &dreq("a.txt", None, REV_WORKTREE)).unwrap();
    assert_eq!(combined.hunks[0].lines.len(), 1);
    r.write("b.txt", "y\n");
    let untracked = diff::file_diff(r.path(), &dreq("b.txt", None, REV_WORKTREE)).unwrap();
    assert_eq!(untracked.hunks[0].lines.len(), 1);
}

// ───────────── commit ─────────────

fn creq(msg: &str) -> CommitRequest {
    CommitRequest { message: msg.into(), amend: false, sign_off: false, allow_empty: false }
}

#[test]
fn commit_basic_amend_and_errors() {
    let r = TestRepo::new();
    r.write("a.txt", "a\n");
    // nothing staged on an unborn repo
    assert_eq!(code(commit::commit(&r.locks, r.path(), &creq("x"), &mut quiet())), ErrorCode::NothingToCommit);
    assert_eq!(code(commit::commit(&r.locks, r.path(), &creq("  \n"), &mut quiet())), ErrorCode::InvalidArgument);
    let mut amend = creq("x");
    amend.amend = true;
    assert_eq!(code(commit::commit(&r.locks, r.path(), &amend, &mut quiet())), ErrorCode::InvalidArgument);
    r.stage(&["a.txt"]);
    // a message starting with '-' travels via stdin
    let res = commit::commit(&r.locks, r.path(), &creq("--not-an-option\n\nbody line"), &mut quiet()).unwrap();
    assert_eq!(res.hash, r.head());
    assert_eq!(r.git(&["log", "-1", "--format=%s"]), "--not-an-option");
    assert_eq!(r.git(&["log", "-1", "--format=%b"]).trim(), "body line");
    // nothing staged now
    r.write("a.txt", "a2\n");
    assert_eq!(code(commit::commit(&r.locks, r.path(), &creq("again"), &mut quiet())), ErrorCode::NothingToCommit);
    // amend + sign-off
    r.stage(&["a.txt"]);
    let before = r.head();
    let mut req = creq("amended");
    req.amend = true;
    req.sign_off = true;
    let res = commit::commit(&r.locks, r.path(), &req, &mut quiet()).unwrap();
    assert_ne!(res.hash, before);
    assert_eq!(r.git(&["rev-list", "--count", "HEAD"]), "1");
    assert!(r.git(&["log", "-1", "--format=%B"]).contains("Signed-off-by: Test User"));
    // allow-empty
    let mut empty = creq("empty one");
    empty.allow_empty = true;
    commit::commit(&r.locks, r.path(), &empty, &mut quiet()).unwrap();
    assert_eq!(r.git(&["rev-list", "--count", "HEAD"]), "2");
}

#[test]
fn commit_with_unmerged_files() {
    let r = TestRepo::new();
    r.conflict_setup();
    let _ = git_raw(&r.dir, &["merge", "feature"]);
    assert_eq!(code(commit::commit(&r.locks, r.path(), &creq("try"), &mut quiet())), ErrorCode::UnmergedFiles);
}

#[test]
fn commit_runs_hooks_and_reports_failure() {
    let r = TestRepo::new();
    r.commit_file("a.txt", "a\n", "base");
    let hook = r.dir.join(".git/hooks/pre-commit");
    std::fs::write(&hook, "#!/bin/sh\necho hook-says-no >&2\nexit 1\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    r.write("a.txt", "a2\n");
    r.stage(&["a.txt"]);
    let mut lines: Vec<String> = Vec::new();
    let err = commit::commit(&r.locks, r.path(), &creq("blocked"), &mut |l: &str| lines.push(l.to_string())).unwrap_err();
    assert_eq!(err.code, ErrorCode::GitFailed);
    assert!(err.stderr.unwrap_or_default().contains("hook-says-no"));
    assert!(lines.iter().any(|l| l.contains("hook-says-no")), "hook output is streamed: {lines:?}");
}

// ───────────── push ─────────────

fn preq(branch: &str) -> PushRequest {
    PushRequest {
        remote: "origin".into(),
        local_branch: branch.into(),
        remote_branch: branch.into(),
        set_upstream: false,
        force_with_lease: None,
        follow_tags: false,
    }
}

#[test]
fn push_preview_and_new_branch_with_upstream() {
    let r = TestRepo::new().with_remote();
    let c1 = r.commit_file("a.txt", "a\n", "one");
    r.commit_file("a.txt", "a2\n", "two");
    let pv = push::preview(r.path(), None).unwrap();
    assert_eq!(pv.local_branch, "main");
    assert_eq!(pv.remote.as_deref(), Some("origin"));
    assert_eq!(pv.remote_branch, "main");
    assert_eq!(pv.upstream, None);
    assert_eq!(pv.remote_hash, None);
    assert_eq!(pv.outgoing.len(), 2);
    assert_eq!(pv.outgoing[1].hash, c1);
    let mut req = preq("main");
    req.set_upstream = true;
    push::push(&r.locks, r.path(), &req, &mut quiet()).unwrap();
    assert_eq!(r.git(&["rev-parse", "main@{upstream}"]), r.head());
    let pv = push::preview(r.path(), None).unwrap();
    assert_eq!(pv.upstream.as_deref(), Some("refs/remotes/origin/main"));
    assert!(pv.outgoing.is_empty());
    assert_eq!(pv.remote_hash.as_deref(), Some(r.head().as_str()));
    // pushing again is a no-op
    let res = push::push(&r.locks, r.path(), &preq("main"), &mut quiet()).unwrap();
    assert!(res.message.contains("up-to-date"));
    // detached HEAD has no default branch
    r.git(&["checkout", "-q", "--detach"]);
    assert_eq!(code(push::preview(r.path(), None)), ErrorCode::InvalidArgument);
}

/// A second clone pushes a commit, so the first one is behind.
fn other_clone_pushes(r: &TestRepo) -> String {
    let other = r.dir.parent().unwrap().join("other");
    let o = Command::new("git").args(["clone", "-q", r.remote.as_ref().unwrap().to_str().unwrap(), other.to_str().unwrap()]).output().unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    git_in(&other, &["config", "user.name", "Other"]);
    git_in(&other, &["config", "user.email", "o@example.com"]);
    git_in(&other, &["config", "commit.gpgsign", "false"]);
    std::fs::write(other.join("other.txt"), "o\n").unwrap();
    git_in(&other, &["add", "-A"]);
    git_in(&other, &["commit", "-q", "-m", "from other"]);
    git_in(&other, &["push", "-q", "origin", "main"]);
    git_in(&other, &["rev-parse", "HEAD"])
}

#[test]
fn push_rejected_stale_lease_and_valid_lease() {
    let r = TestRepo::new().with_remote();
    r.commit_file("a.txt", "a\n", "one");
    let mut req = preq("main");
    req.set_upstream = true;
    push::push(&r.locks, r.path(), &req, &mut quiet()).unwrap();
    let stale_remote_hash = r.head();
    let their = other_clone_pushes(&r);
    r.commit_file("b.txt", "b\n", "local diverges");
    // plain push: rejected (non-fast-forward / fetch first)
    assert_eq!(code(push::push(&r.locks, r.path(), &preq("main"), &mut quiet())), ErrorCode::PushRejected);
    // lease with a hash the remote no longer has: stale
    let mut lease = preq("main");
    lease.force_with_lease = Some(stale_remote_hash);
    assert_eq!(code(push::push(&r.locks, r.path(), &lease, &mut quiet())), ErrorCode::StaleLease);
    // after fetching, the preview shows the real remote hash; a lease with it succeeds
    r.git(&["fetch", "-q", "origin"]);
    let pv = push::preview(r.path(), None).unwrap();
    assert_eq!(pv.remote_hash.as_deref(), Some(their.as_str()));
    assert_eq!(pv.behind, 1);
    let mut lease = preq("main");
    lease.force_with_lease = pv.remote_hash.clone();
    push::push(&r.locks, r.path(), &lease, &mut quiet()).unwrap();
    assert_eq!(r.git(&["--git-dir", r.remote.as_ref().unwrap().to_str().unwrap(), "rev-parse", "main"]), r.head());
    // a non-hash lease is refused before git runs
    let mut bad = preq("main");
    bad.force_with_lease = Some("main".into());
    assert_eq!(code(push::push(&r.locks, r.path(), &bad, &mut quiet())), ErrorCode::InvalidArgument);
    let mut opt = preq("main");
    opt.remote = "--force".into();
    assert_eq!(code(push::push(&r.locks, r.path(), &opt, &mut quiet())), ErrorCode::InvalidArgument);
}

#[test]
fn push_tag() {
    let r = TestRepo::new().with_remote();
    r.commit_file("a.txt", "a\n", "one");
    tags::create_tag(&r.locks, r.path(), &CreateTagRequest { name: "v1".into(), target: r.head(), message: None }).unwrap();
    push::push_tag(&r.locks, r.path(), "origin", "v1", &mut quiet()).unwrap();
    let remote = r.remote.as_ref().unwrap().to_str().unwrap();
    assert_eq!(r.git(&["--git-dir", remote, "tag", "-l"]), "v1");
    assert_eq!(code(push::push_tag(&r.locks, r.path(), "origin", "bad..name", &mut quiet())), ErrorCode::InvalidArgument);
}

// ───────────── stash ─────────────

fn sref(r: &TestRepo, index: u32) -> StashRef {
    StashRef { index, hash: r.git(&["rev-parse", &format!("stash@{{{index}}}")]) }
}

#[test]
fn stash_save_list_apply_drop() {
    let r = TestRepo::new();
    r.commit_file("a.txt", "a\n", "base");
    r.write("a.txt", "a changed\n");
    r.write("u.txt", "untracked\n");
    let res = stash::save(
        &r.locks,
        r.path(),
        &StashSaveRequest { message: Some("my stash".into()), include_untracked: true, keep_index: false, paths: None },
    )
    .unwrap();
    assert!(!res.message.is_empty());
    assert!(r.status().files.is_empty(), "-u stashes untracked files too: {:?} / {:?}", r.status().files, res);
    let list = stash::list(r.path()).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].index, 0);
    assert!(list[0].message.contains("my stash"));
    assert_eq!(list[0].branch.as_deref(), Some("main"));
    // apply keeps the entry; pop removes it
    let out = stash::apply(&r.locks, r.path(), &sref(&r, 0), false, false).unwrap();
    assert!(!out.conflicts);
    assert_eq!(r.read("a.txt"), "a changed\n");
    assert_eq!(stash::list(r.path()).unwrap().len(), 1);
    r.git(&["checkout", "--", "a.txt"]);
    r.git(&["clean", "-fq"]);
    stash::apply(&r.locks, r.path(), &sref(&r, 0), true, false).unwrap();
    assert!(stash::list(r.path()).unwrap().is_empty());
    // keep index (-k)
    r.stage(&["a.txt"]);
    stash::save(&r.locks, r.path(), &StashSaveRequest { message: None, include_untracked: false, keep_index: true, paths: None }).unwrap();
    assert_eq!(r.file(&r.status(), "a.txt").staged, Some(FileStatus::Modified), "index kept");
    // paths
    r.git(&["checkout", "-q", "HEAD", "--", "."]);
    r.write("a.txt", "p1\n");
    r.write("b.txt", "p2\n");
    r.commit_file("b.txt", "b\n", "add b");
    r.write("a.txt", "p1\n");
    r.write("b.txt", "p2\n");
    stash::save(
        &r.locks,
        r.path(),
        &StashSaveRequest { message: None, include_untracked: false, keep_index: false, paths: Some(strs(&["a.txt"])) },
    )
    .unwrap();
    let st = r.status();
    assert_eq!(st.files.len(), 1);
    assert_eq!(st.files[0].path, "b.txt");
}

#[test]
fn stash_wrong_hash_conflict_and_drop() {
    let r = TestRepo::new();
    r.commit_file("a.txt", "a\n", "base");
    r.write("a.txt", "stashed\n");
    stash::save(&r.locks, r.path(), &StashSaveRequest { message: None, include_untracked: false, keep_index: false, paths: None }).unwrap();
    let good = sref(&r, 0);
    // wrong hash / index out of range => invalidArgument, nothing happens
    let wrong = StashRef { index: 0, hash: "f".repeat(40) };
    assert_eq!(code(stash::apply(&r.locks, r.path(), &wrong, true, false)), ErrorCode::InvalidArgument);
    assert_eq!(code(stash::drop_entry(&r.locks, r.path(), &wrong)), ErrorCode::InvalidArgument);
    assert_eq!(code(stash::drop_entry(&r.locks, r.path(), &StashRef { index: 5, hash: good.hash.clone() })), ErrorCode::InvalidArgument);
    assert_eq!(stash::list(r.path()).unwrap().len(), 1);
    // conflicting pop: outcome with conflicts, entry kept
    r.commit_file("a.txt", "different\n", "diverge");
    let out = stash::apply(&r.locks, r.path(), &good, true, false).unwrap();
    assert!(out.conflicts);
    assert_eq!(stash::list(r.path()).unwrap().len(), 1, "a conflicting pop keeps the entry");
    r.git(&["checkout", "-q", "HEAD", "--", "."]);
    r.git(&["reset", "-q", "--hard"]);
    // dirty tree blocks apply => error, not an outcome
    r.write("a.txt", "dirty\n");
    assert_eq!(code(stash::apply(&r.locks, r.path(), &good, false, false)), ErrorCode::WouldOverwrite);
    r.git(&["checkout", "--", "a.txt"]);
    stash::drop_entry(&r.locks, r.path(), &good).unwrap();
    assert!(stash::list(r.path()).unwrap().is_empty());
}

// ───────────── merge ─────────────

fn mreq(r: &str, mode: MergeMode) -> MergeRequest {
    MergeRequest { ref_name: r.into(), mode, message: None }
}

#[test]
fn merge_ff_noff_and_conflict_flow() {
    let r = TestRepo::new();
    r.commit_file("a.txt", "a\n", "base");
    r.git(&["checkout", "-q", "-b", "side"]);
    let side = r.commit_file("side.txt", "s\n", "side");
    r.git(&["checkout", "-q", "main"]);
    // ff-only fast-forwards
    let out = sequence::merge(&r.locks, r.path(), &mreq("refs/heads/side", MergeMode::FfOnly), &mut quiet()).unwrap();
    assert!(!out.conflicts && out.operation.is_none());
    assert_eq!(r.head(), side);
    // --no-ff creates a merge commit
    r.git(&["checkout", "-q", "-b", "side2"]);
    r.commit_file("s2.txt", "s2\n", "side2");
    r.git(&["checkout", "-q", "main"]);
    sequence::merge(&r.locks, r.path(), &mreq("refs/heads/side2", MergeMode::NoFf), &mut quiet()).unwrap();
    assert_eq!(r.git(&["rev-list", "--parents", "-n1", "HEAD"]).split(' ').count(), 3);
    // ff-only that cannot ff
    r.git(&["checkout", "-q", "-b", "diverged", "HEAD~1"]);
    r.commit_file("d.txt", "d\n", "diverged");
    r.git(&["checkout", "-q", "main"]);
    r.commit_file("m.txt", "m\n", "main moves");
    assert_eq!(
        code(sequence::merge(&r.locks, r.path(), &mreq("refs/heads/diverged", MergeMode::FfOnly), &mut quiet())),
        ErrorCode::NonFastForward
    );
    assert_eq!(code(sequence::merge(&r.locks, r.path(), &mreq("--evil", MergeMode::Default), &mut quiet())), ErrorCode::InvalidArgument);
}

#[test]
fn merge_conflict_continue_and_abort() {
    let r = TestRepo::new();
    let (main_tip, _feature) = r.conflict_setup();
    let out = sequence::merge(&r.locks, r.path(), &mreq("refs/heads/feature", MergeMode::Default), &mut quiet()).unwrap();
    assert!(out.conflicts);
    assert_eq!(out.operation, Some(RepoOperation::Merge));
    // continue with unresolved conflicts is refused
    assert_eq!(
        code(sequence::control_operation(&r.locks, r.path(), RepoOperation::Merge, OperationAction::Continue, &mut quiet())),
        ErrorCode::UnmergedFiles
    );
    // wrong operation / unsupported actions
    assert_eq!(
        code(sequence::control_operation(&r.locks, r.path(), RepoOperation::Rebase, OperationAction::Abort, &mut quiet())),
        ErrorCode::InvalidArgument
    );
    assert_eq!(
        code(sequence::control_operation(&r.locks, r.path(), RepoOperation::Merge, OperationAction::Skip, &mut quiet())),
        ErrorCode::InvalidArgument
    );
    // abort restores
    let out = sequence::control_operation(&r.locks, r.path(), RepoOperation::Merge, OperationAction::Abort, &mut quiet()).unwrap();
    assert!(!out.conflicts && out.operation.is_none());
    assert_eq!(r.head(), main_tip);
    // do it again, resolve with "theirs", continue
    sequence::merge(&r.locks, r.path(), &mreq("refs/heads/feature", MergeMode::Default), &mut quiet()).unwrap();
    stage::resolve_conflict(&r.locks, r.path(), &strs(&["f.txt"]), ConflictSide::Theirs).unwrap();
    assert_eq!(r.read("f.txt"), "feature\nsecond\n");
    let st = r.status();
    assert!(st.operation.as_ref().unwrap().can_continue);
    let out = sequence::control_operation(&r.locks, r.path(), RepoOperation::Merge, OperationAction::Continue, &mut quiet()).unwrap();
    assert!(!out.conflicts && out.operation.is_none());
    assert_eq!(r.git(&["rev-list", "--parents", "-n1", "HEAD"]).split(' ').count(), 3);
}

#[test]
fn resolve_conflict_ours_and_deleted_side() {
    let r = TestRepo::new();
    r.commit_file("f.txt", "base\n", "base");
    r.commit_file("gone.txt", "g\n", "gone");
    r.git(&["checkout", "-q", "-b", "feature"]);
    r.commit_file("f.txt", "feature\n", "f");
    r.git(&["rm", "-q", "gone.txt"]);
    r.git(&["commit", "-q", "-m", "delete gone"]);
    r.git(&["checkout", "-q", "main"]);
    r.commit_file("f.txt", "main\n", "m");
    r.commit_file("gone.txt", "g modified\n", "modify gone");
    let out = sequence::merge(&r.locks, r.path(), &mreq("refs/heads/feature", MergeMode::Default), &mut quiet()).unwrap();
    assert!(out.conflicts);
    let st = r.status();
    assert_eq!(r.file(&st, "gone.txt").conflict, Some(ConflictKind::DeletedByThem));
    stage::resolve_conflict(&r.locks, r.path(), &strs(&["f.txt"]), ConflictSide::Ours).unwrap();
    assert_eq!(r.read("f.txt"), "main\n");
    // "theirs" for a file they deleted removes it
    stage::resolve_conflict(&r.locks, r.path(), &strs(&["gone.txt"]), ConflictSide::Theirs).unwrap();
    assert!(!r.dir.join("gone.txt").exists());
    assert!(r.status().files.iter().all(|f| f.conflict.is_none()));
    assert_eq!(code(stage::resolve_conflict(&r.locks, r.path(), &strs(&["nope.txt"]), ConflictSide::Ours)), ErrorCode::InvalidArgument);
}

// ───────────── rebase ─────────────

#[test]
fn rebase_dirty_conflict_skip_and_abort() {
    let r = TestRepo::new();
    r.commit_file("f.txt", "base\nsecond\n", "base");
    r.git(&["checkout", "-q", "-b", "feature"]);
    r.commit_file("f.txt", "feature\nsecond\n", "feature change");
    r.commit_file("extra.txt", "e\n", "extra");
    r.git(&["checkout", "-q", "main"]);
    r.commit_file("f.txt", "main\nsecond\n", "main change");
    r.git(&["checkout", "-q", "feature"]);
    let feature_tip = r.head();
    // dirty worktree
    r.write("f.txt", "dirty\n");
    assert_eq!(code(sequence::rebase(&r.locks, r.path(), "main", &mut quiet())), ErrorCode::DirtyWorktree);
    r.git(&["checkout", "--", "f.txt"]);
    // conflict, then skip the conflicting commit => finishes
    let out = sequence::rebase(&r.locks, r.path(), "main", &mut quiet()).unwrap();
    assert!(out.conflicts && out.operation == Some(RepoOperation::Rebase));
    let out = sequence::control_operation(&r.locks, r.path(), RepoOperation::Rebase, OperationAction::Skip, &mut quiet()).unwrap();
    assert!(!out.conflicts && out.operation.is_none(), "{out:?}");
    assert_eq!(r.git(&["log", "-1", "--format=%s"]), "extra");
    assert_eq!(r.git(&["rev-list", "--count", "main..HEAD"]), "1");
    // again and abort
    r.git(&["reset", "-q", "--hard", &feature_tip]);
    let out = sequence::rebase(&r.locks, r.path(), "main", &mut quiet()).unwrap();
    assert!(out.conflicts);
    sequence::control_operation(&r.locks, r.path(), RepoOperation::Rebase, OperationAction::Abort, &mut quiet()).unwrap();
    assert_eq!(r.head(), feature_tip);
    assert!(r.status().operation.is_none());
}

// ───────────── cherry-pick / revert ─────────────

#[test]
fn cherry_pick_several_oldest_first_and_merge_needs_mainline() {
    let r = TestRepo::new();
    r.commit_file("a.txt", "a\n", "base");
    r.git(&["checkout", "-q", "-b", "feature"]);
    let c1 = r.commit_file("one.txt", "1\n", "c1");
    let c2 = r.commit_file("two.txt", "2\n", "c2");
    r.git(&["checkout", "-q", "main"]);
    let out = sequence::cherry_pick(
        &r.locks,
        r.path(),
        &CherryPickRequest { hashes: vec![c1, c2], record_origin: true, mainline: None },
        &mut quiet(),
    )
    .unwrap();
    assert!(!out.conflicts && out.operation.is_none());
    assert_eq!(r.git(&["log", "--format=%s", "-2"]), "c2\nc1", "oldest first, so c2 ends up on top");
    assert!(r.git(&["log", "-1", "--format=%B"]).contains("cherry picked from commit"));
    // a merge commit needs a mainline
    r.git(&["checkout", "-q", "-b", "m2", "HEAD~2"]);
    r.git(&["merge", "-q", "--no-ff", "-m", "merge feature", "feature"]);
    let merge = r.head();
    r.git(&["checkout", "-q", "main"]);
    assert_eq!(
        code(sequence::cherry_pick(&r.locks, r.path(), &CherryPickRequest { hashes: vec![merge], record_origin: false, mainline: None }, &mut quiet())),
        ErrorCode::InvalidArgument
    );
    assert_eq!(
        code(sequence::cherry_pick(&r.locks, r.path(), &CherryPickRequest { hashes: vec![], record_origin: false, mainline: None }, &mut quiet())),
        ErrorCode::InvalidArgument
    );
    assert_eq!(
        code(sequence::cherry_pick(&r.locks, r.path(), &CherryPickRequest { hashes: vec!["abc".into()], record_origin: false, mainline: None }, &mut quiet())),
        ErrorCode::InvalidArgument
    );
}

#[test]
fn cherry_pick_dirty_and_conflict_flow() {
    let r = TestRepo::new();
    let (_m, feature) = r.conflict_setup();
    r.write("f.txt", "dirty\n");
    assert_eq!(
        code(sequence::cherry_pick(&r.locks, r.path(), &CherryPickRequest { hashes: vec![feature.clone()], record_origin: false, mainline: None }, &mut quiet())),
        ErrorCode::DirtyWorktree
    );
    r.git(&["checkout", "--", "f.txt"]);
    let out = sequence::cherry_pick(&r.locks, r.path(), &CherryPickRequest { hashes: vec![feature], record_origin: false, mainline: None }, &mut quiet()).unwrap();
    assert!(out.conflicts && out.operation == Some(RepoOperation::CherryPick));
    stage::resolve_conflict(&r.locks, r.path(), &strs(&["f.txt"]), ConflictSide::Theirs).unwrap();
    let out = sequence::control_operation(&r.locks, r.path(), RepoOperation::CherryPick, OperationAction::Continue, &mut quiet()).unwrap();
    assert!(!out.conflicts && out.operation.is_none());
    assert_eq!(r.git(&["log", "-1", "--format=%s"]), "feature change");
}

#[test]
fn revert_several_newest_first() {
    let r = TestRepo::new();
    r.commit_file("a.txt", "a\n", "base");
    let c1 = r.commit_file("one.txt", "1\n", "c1");
    let c2 = r.commit_file("two.txt", "2\n", "c2");
    let out = sequence::revert(&r.locks, r.path(), &RevertRequest { hashes: vec![c2, c1], mainline: None }, &mut quiet()).unwrap();
    assert!(!out.conflicts && out.operation.is_none());
    assert!(!r.dir.join("one.txt").exists() && !r.dir.join("two.txt").exists());
    assert_eq!(r.git(&["log", "--format=%s", "-2"]), "Revert \"c1\"\nRevert \"c2\"");
}

// ───────────── reset ─────────────

#[test]
fn reset_modes() {
    let r = TestRepo::new();
    let c1 = r.commit_file("a.txt", "1\n", "c1");
    r.commit_file("a.txt", "2\n", "c2");
    let rq = |mode, discard| ResetRequest { hash: c1.clone(), mode, discard_local_changes: discard };
    sequence::reset(&r.locks, r.path(), &rq(ResetMode::Soft, false)).unwrap();
    assert_eq!(r.head(), c1);
    assert_eq!(r.file(&r.status(), "a.txt").staged, Some(FileStatus::Modified));
    assert_eq!(r.read("a.txt"), "2\n");
    let c2 = r.git(&["rev-parse", "ORIG_HEAD"]);
    sequence::reset(&r.locks, r.path(), &ResetRequest { hash: c2.clone(), mode: ResetMode::Mixed, discard_local_changes: false }).unwrap();
    assert_eq!(r.head(), c2);
    r.write("a.txt", "dirty\n");
    // hard without the flag is rejected and changes nothing
    assert_eq!(code(sequence::reset(&r.locks, r.path(), &rq(ResetMode::Hard, false))), ErrorCode::InvalidArgument);
    assert_eq!(r.head(), c2);
    assert_eq!(r.read("a.txt"), "dirty\n");
    sequence::reset(&r.locks, r.path(), &rq(ResetMode::Hard, true)).unwrap();
    assert_eq!(r.head(), c1);
    assert_eq!(r.read("a.txt"), "1\n");
    assert_eq!(code(sequence::reset(&r.locks, r.path(), &ResetRequest { hash: "f".repeat(40), mode: ResetMode::Soft, discard_local_changes: false })), ErrorCode::InvalidArgument);
    assert_eq!(code(sequence::reset(&r.locks, r.path(), &ResetRequest { hash: "HEAD".into(), mode: ResetMode::Soft, discard_local_changes: false })), ErrorCode::InvalidArgument);
}

// ───────────── tags ─────────────

#[test]
fn tags_create_validate_delete() {
    let r = TestRepo::new();
    let h = r.commit_file("a.txt", "a\n", "one");
    let c = tags::validate_tag_name(r.path(), "v1.0").unwrap();
    assert!(c.valid && !c.exists);
    assert!(!tags::validate_tag_name(r.path(), "bad name").unwrap().valid);
    assert!(!tags::validate_tag_name(r.path(), "a..b").unwrap().valid);
    assert!(!tags::validate_tag_name(r.path(), "").unwrap().valid);
    assert!(!tags::validate_tag_name(r.path(), "-x").unwrap().valid);
    let mk = |name: &str, msg: Option<&str>| CreateTagRequest { name: name.into(), target: h.clone(), message: msg.map(String::from) };
    tags::create_tag(&r.locks, r.path(), &mk("light", None)).unwrap();
    assert_eq!(r.git(&["cat-file", "-t", "refs/tags/light"]), "commit");
    tags::create_tag(&r.locks, r.path(), &mk("annotated", Some("release notes\n\nmore"))).unwrap();
    assert_eq!(r.git(&["cat-file", "-t", "refs/tags/annotated"]), "tag");
    assert!(r.git(&["tag", "-n9", "-l", "annotated"]).contains("release notes"));
    // existing / invalid names are refused (no -f)
    let again = tags::validate_tag_name(r.path(), "light").unwrap();
    assert!(again.valid && again.exists);
    assert_eq!(code(tags::create_tag(&r.locks, r.path(), &mk("light", None))), ErrorCode::InvalidArgument);
    assert_eq!(code(tags::create_tag(&r.locks, r.path(), &mk("bad..name", None))), ErrorCode::InvalidArgument);
    assert_eq!(code(tags::create_tag(&r.locks, r.path(), &CreateTagRequest { name: "t".into(), target: "HEAD".into(), message: None })), ErrorCode::InvalidArgument);
    tags::delete_tag(&r.locks, r.path(), "light").unwrap();
    assert!(!r.git(&["tag", "-l"]).contains("light"));
    assert_eq!(code(tags::delete_tag(&r.locks, r.path(), "light")), ErrorCode::InvalidArgument);
}

// ───────────── history exploration ─────────────

#[test]
fn reflog_parsing_and_limits() {
    let r = TestRepo::new();
    r.commit_file("a.txt", "a\n", "first");
    r.commit_file("a.txt", "b\n", "second");
    r.git(&["commit", "-q", "--amend", "-m", "second amended"]);
    r.git(&["checkout", "-q", "-b", "other"]);
    let log = reflog::reflog(r.path(), None, None).unwrap();
    assert_eq!(log.ref_name, "HEAD");
    assert!(!log.truncated);
    assert_eq!(log.entries[0].selector, "HEAD@{0}");
    assert_eq!(log.entries[0].action, "checkout");
    assert!(log.entries[0].message.contains("moving from main to other"));
    let actions: Vec<&str> = log.entries.iter().map(|e| e.action.as_str()).collect();
    assert!(actions.contains(&"commit (amend)") && actions.contains(&"commit (initial)"), "{actions:?}");
    assert!(log.entries.iter().all(|e| e.hash.len() == 40 && e.time > 0));
    let lim = reflog::reflog(r.path(), None, Some(2)).unwrap();
    assert_eq!(lim.entries.len(), 2);
    assert!(lim.truncated);
    let br = reflog::reflog(r.path(), Some("refs/heads/main"), None).unwrap();
    assert_eq!(br.entries[0].selector, "main@{0}");
    assert_eq!(code(reflog::reflog(r.path(), Some("refs/tags/x"), None)), ErrorCode::InvalidArgument);
    // unborn: empty
    let empty = TestRepo::new();
    assert!(reflog::reflog(empty.path(), None, None).unwrap().entries.is_empty());
}

#[test]
fn compare_counts_and_rev_range_filter() {
    let r = TestRepo::new();
    let base = r.commit_file("a.txt", "a\n", "base");
    r.git(&["checkout", "-q", "-b", "feature"]);
    let f1 = r.commit_file("f1.txt", "1\n", "f1");
    let f2 = r.commit_file("f2.txt", "2\n", "f2");
    r.git(&["checkout", "-q", "main"]);
    let m1 = r.commit_file("m1.txt", "1\n", "m1");
    let s = reflog::compare_refs(r.path(), "refs/heads/main", "refs/heads/feature").unwrap();
    assert_eq!((s.a_only, s.b_only), (1, 2));
    assert_eq!(s.merge_base.as_deref(), Some(base.as_str()));
    assert_eq!(code(reflog::compare_refs(r.path(), "--all", "main")), ErrorCode::InvalidArgument);
    // revRange through filter_commits, ANDed with the text filter
    let store = SnapshotStore::default();
    let snap = snapshot::load_log(&store, r.path(), LogScope { refs: None, limit: None }, &Favorites::default()).unwrap();
    let s = store.get(snap.snapshot_id).unwrap();
    let filter = |inc: &str, exc: &str, text: Option<&str>| LogFilter {
        text: text.map(|t| TextFilter { text: t.into(), regex: false, match_case: false }),
        users: None,
        date: None,
        paths: None,
        rev_range: Some(RevRange { include: inc.into(), exclude: exc.into() }),
    };
    let idx = |h: &str| snap.hashes.iter().position(|x| x == h).unwrap() as u32;
    let m = snapshot::filter_commits(&s, &filter("refs/heads/feature", "refs/heads/main", None)).unwrap().matches.unwrap();
    let mut want = vec![idx(&f1), idx(&f2)];
    want.sort();
    assert_eq!(m, want);
    let m = snapshot::filter_commits(&s, &filter("refs/heads/main", "refs/heads/feature", None)).unwrap().matches.unwrap();
    assert_eq!(m, vec![idx(&m1)]);
    let m = snapshot::filter_commits(&s, &filter("refs/heads/feature", "refs/heads/main", Some("f2"))).unwrap().matches.unwrap();
    assert_eq!(m, vec![idx(&f2)]);
}

#[test]
fn line_history_follows_a_rename() {
    let r = TestRepo::new();
    r.commit_file("old.txt", "one\ntwo\nthree\n", "create");
    r.commit_file("old.txt", "one\nTWO\nthree\n", "change two");
    r.git(&["mv", "old.txt", "new.txt"]);
    r.git(&["commit", "-q", "-m", "rename"]);
    r.commit_file("new.txt", "one\nTWO!\nthree\n", "change two again");
    let h = linehist::line_history(r.path(), "new.txt", None, LineRange { start: 2, end: 2 }).unwrap();
    assert_eq!(h.rev, r.head());
    assert!(!h.truncated);
    let subjects: Vec<&str> = h.entries.iter().map(|e| e.subject.as_str()).collect();
    assert_eq!(subjects[0], "change two again");
    assert!(subjects.contains(&"change two"), "{subjects:?}");
    assert!(subjects.contains(&"create"), "{subjects:?}");
    assert!(h.entries.iter().all(|e| !e.hunks.is_empty()));
    assert_eq!(h.entries[0].path, "new.txt");
    assert_eq!(h.entries.iter().find(|e| e.subject == "change two").unwrap().path, "old.txt");
    assert_eq!(code(linehist::line_history(r.path(), "new.txt", None, LineRange { start: 0, end: 1 })), ErrorCode::InvalidArgument);
    assert_eq!(code(linehist::line_history(r.path(), "new.txt", Some("--all"), LineRange { start: 1, end: 1 })), ErrorCode::InvalidArgument);
    assert_eq!(code(linehist::line_history(r.path(), "../x", None, LineRange { start: 1, end: 1 })), ErrorCode::InvalidArgument);
}

// ───────────── settings / git path / errors ─────────────

#[test]
fn settings_roundtrip_and_git_path_override() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("state.json");
    let persist = Persist::new(Some(file.clone()));
    let auto = runner::auto_detect().expect("git available");
    let mut s = AppSettings {
        language: LanguageSetting::Ko,
        density: RowDensity::Compact,
        git_path: Some(auto.to_string_lossy().into_owned()),
        background_fetch_minutes: Some(15),
        ..Default::default()
    };
    let stored = app_settings::store(&persist, s.clone()).unwrap();
    assert_eq!(stored, s);
    assert_eq!(runner::git_override(), Some(auto.clone()));
    assert_eq!(runner::git_path().unwrap(), auto);
    assert_eq!(Persist::new(Some(file)).settings(), s);
    // invalid values are refused and not persisted
    let mut bad = s.clone();
    bad.background_fetch_minutes = Some(7);
    assert_eq!(code(app_settings::store(&persist, bad)), ErrorCode::InvalidArgument);
    let mut bad = s.clone();
    bad.git_path = Some("/no/such/git".into());
    assert_eq!(code(app_settings::store(&persist, bad)), ErrorCode::InvalidArgument);
    assert_eq!(persist.settings(), s);
    // back to auto-detect
    s.git_path = None;
    app_settings::store(&persist, s).unwrap();
    assert_eq!(runner::git_override(), None);
    let check = app_settings::validate_git_path(None);
    assert!(check.ok && check.version.is_some());
    assert!(!app_settings::validate_git_path(Some("/etc/hosts")).ok);
}

#[test]
fn hook_path_has_fallback_dirs() {
    let p = runner::login_path();
    for d in runner::FALLBACK_PATH.split(':') {
        assert!(p.split(':').any(|x| x == d), "{d} missing from {p}");
    }
    assert_eq!(runner::parse_login_path("noise__LANES_PATH_BEGIN__/a:/b__LANES_PATH_END__more").as_deref(), Some("/a:/b"));
    assert_eq!(runner::parse_login_path("nothing"), None);
}

#[test]
fn busy_when_another_write_op_runs_and_index_lock() {
    let r = TestRepo::new();
    r.commit_file("a.txt", "a\n", "base");
    // a held lock => busy
    let l = &r.locks;
    let res = l.run(r.path(), || stage::stage_files(l, r.path(), &strs(&["a.txt"])));
    assert_eq!(res.unwrap_err().code, ErrorCode::Busy);
    // a stale index.lock (IDE holding it) => busy
    std::fs::write(r.dir.join(".git/index.lock"), "").unwrap();
    r.write("b.txt", "b\n");
    assert_eq!(code(stage::stage_files(&r.locks, r.path(), &strs(&["b.txt"]))), ErrorCode::Busy);
    std::fs::remove_file(r.dir.join(".git/index.lock")).unwrap();
    r.stage(&["b.txt"]);
}

#[test]
fn ops_module_still_refuses_unsafe_branch_names() {
    let r = TestRepo::new();
    r.commit_file("a.txt", "a\n", "base");
    assert_eq!(
        code(ops::delete_branch(&r.locks, r.path(), "main", false)),
        ErrorCode::InvalidArgument,
        "current branch cannot be deleted"
    );
}

#[test]
fn head_literal_and_full_context_diffs() {
    let r = TestRepo::new();
    let body: String = (1..=300).map(|i| format!("line {i}\n")).collect();
    r.commit_file("big.txt", &body, "base");
    let changed = body.replace("line 150\n", "LINE 150\n");
    r.write("big.txt", &changed);
    r.stage(&["big.txt"]);
    // "HEAD" resolves at request time
    let mut req = dreq("big.txt", Some("HEAD"), REV_INDEX);
    req.context_lines = Some(1_000_000);
    let d = diff::file_diff(r.path(), &req).unwrap();
    assert!(!d.truncated);
    assert_eq!(d.hunks.len(), 1);
    assert_eq!(d.hunks[0].lines.len(), 301, "full context: every line of the file plus the replaced one");
    let combined = diff::file_diff(r.path(), &dreq("big.txt", Some("HEAD"), REV_WORKTREE)).unwrap();
    assert_eq!(combined.hunks.len(), 1);
    // unborn repo: HEAD means the empty tree
    let u = TestRepo::new();
    u.write("n.txt", "x\n");
    u.stage(&["n.txt"]);
    let d = diff::file_diff(u.path(), &dreq("n.txt", Some("HEAD"), REV_INDEX)).unwrap();
    assert_eq!(d.hunks[0].lines.len(), 1);
}

#[test]
fn discard_staged_rename_restores_old_and_removes_new() {
    let r = TestRepo::new();
    r.commit_file("old.txt", "content\n", "base");
    r.git(&["mv", "old.txt", "new.txt"]);
    let st = r.status();
    assert_eq!(r.file(&st, "new.txt").old_path.as_deref(), Some("old.txt"));
    stage::discard_files(
        &r.locks,
        r.path(),
        &DiscardRequest { paths: strs(&["old.txt", "new.txt"]), untracked_paths: vec![], include_staged: true },
    )
    .unwrap();
    assert!(r.dir.join("old.txt").exists() && !r.dir.join("new.txt").exists());
    assert!(r.status().files.is_empty());
}
