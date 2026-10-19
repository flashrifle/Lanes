//! Writes one serialized sample per shared struct to tests/fixtures/contract/<Type>.json
//! so the TS side can verify the key sets match `src/types.ts`.
use lanes_lib::error::{AppError, ErrorCode};
use lanes_lib::models::*;
use serde::Serialize;
use std::path::PathBuf;

fn write<T: Serialize>(name: &str, v: &T) {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/contract");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(format!("{name}.json")), serde_json::to_string_pretty(v).unwrap() + "\n").unwrap();
}

fn sample_ref() -> Ref {
    Ref {
        name: "main".into(),
        full_name: "refs/heads/main".into(),
        ref_type: RefType::LocalBranch,
        hash: "a".repeat(40),
        index: Some(0),
        remote: None,
        upstream: Some("refs/remotes/origin/main".into()),
        ahead: Some(1),
        behind: Some(2),
        upstream_gone: false,
        is_current: true,
        is_favorite: true,
    }
}

fn sample_head() -> HeadState {
    HeadState {
        detached: false,
        unborn: false,
        branch: Some("main".into()),
        full_name: Some("refs/heads/main".into()),
        hash: Some("a".repeat(40)),
    }
}

fn sample_refs() -> RefsSnapshot {
    RefsSnapshot { head: sample_head(), refs: vec![sample_ref()], operation: Some(RepoOperation::CherryPick) }
}

fn sample_changed() -> ChangedFile {
    ChangedFile {
        path: "src/new.ts".into(),
        old_path: Some("src/old.ts".into()),
        status: FileStatus::Renamed,
        additions: Some(3),
        deletions: Some(1),
        binary: false,
        from_hash: Some("b".repeat(40)),
        to_hash: "a".repeat(40),
    }
}

fn sample_line() -> DiffLine {
    DiffLine { kind: DiffLineKind::Add, old_line: None, new_line: Some(4), text: "hello".into() }
}

fn sample_hunk() -> DiffHunk {
    DiffHunk {
        header: "@@ -1,3 +1,4 @@ fn x".into(),
        old_start: 1,
        old_lines: 3,
        new_start: 1,
        new_lines: 4,
        lines: vec![sample_line()],
    }
}

#[test]
fn write_contract_fixtures() {
    write("AppError", &AppError { code: ErrorCode::NotFullyMerged, message: "m".into(), stderr: Some("s".into()) });
    write("GitUser", &GitUser { name: Some("N".into()), email: None });
    write(
        "RepoInfo",
        &RepoInfo {
            path: "/r".into(),
            name: "r".into(),
            git_dir: "/r/.git".into(),
            common_dir: "/r/.git".into(),
            user: GitUser { name: None, email: None },
            remotes: vec!["origin".into()],
            git_version: "2.50.1".into(),
        },
    );
    write("RecentRepo", &RecentRepo { path: "/r".into(), name: "r".into(), last_opened: 1, exists: true });
    write("Ref", &sample_ref());
    write("HeadState", &sample_head());
    write("RefsSnapshot", &sample_refs());
    let scope = LogScope { refs: Some(vec!["HEAD".into()]), limit: Some(10) };
    write("LogScope", &scope);
    write(
        "LogSnapshot",
        &LogSnapshot {
            snapshot_id: 1,
            repo_path: "/r".into(),
            scope,
            commit_count: 1,
            hashes: vec!["a".repeat(40)],
            parents: vec![vec![-1]],
            timestamps: vec![1],
            refs: sample_refs(),
            head_index: Some(0),
            truncated: false,
            load_millis: 5,
        },
    );
    write(
        "CommitMeta",
        &CommitMeta {
            index: 0,
            hash: "a".repeat(40),
            subject: "s".into(),
            author_name: "n".into(),
            author_email: "e".into(),
            author_time: 1,
            committer_time: 2,
            parent_count: 1,
        },
    );
    let text = TextFilter { text: "x".into(), regex: false, match_case: true };
    let date = DateRange { since: Some(1), until: None };
    write("TextFilter", &text);
    write("DateRange", &date);
    write(
        "LogFilter",
        &LogFilter { text: Some(text), users: Some(vec!["me".into()]), date: Some(date), paths: Some(vec!["a".into()]), rev_range: Some(RevRange { include: "refs/heads/a".into(), exclude: "refs/heads/b".into() }) },
    );
    write("FilterResult", &FilterResult { matches: Some(vec![0, 2]) });
    write("AuthorInfo", &AuthorInfo { name: "n".into(), email: "e".into(), commit_count: 3 });
    write(
        "CommitDetails",
        &CommitDetails {
            hash: "a".repeat(40),
            parents: vec!["b".repeat(40)],
            author_name: "n".into(),
            author_email: "e".into(),
            author_time: 1,
            committer_name: "cn".into(),
            committer_email: "ce".into(),
            committer_time: 2,
            subject: "s".into(),
            body: "b".into(),
        },
    );
    write("SignatureInfo", &SignatureInfo { hash: "a".repeat(40), status: SignatureStatus::UnknownValidity, signer: None });
    write("ChangedFile", &sample_changed());
    write("ChangesResult", &ChangesResult { mode: ChangesMode::Union, is_merge: false, files: vec![sample_changed()] });
    write(
        "DiffRequest",
        &DiffRequest {
            path: "a".into(),
            old_path: None,
            from_hash: None,
            to_hash: "a".repeat(40),
            context_lines: Some(3),
        },
    );
    write("DiffLine", &sample_line());
    write("DiffHunk", &sample_hunk());
    write(
        "FileDiff",
        &FileDiff {
            path: "a".into(),
            old_path: None,
            binary: false,
            old_mode: Some("100644".into()),
            new_mode: None,
            hunks: vec![sample_hunk()],
            truncated: false,
        },
    );
    let fh = FileHistoryEntry {
        hash: "a".repeat(40),
        parents: vec!["b".repeat(40)],
        author_name: "n".into(),
        author_email: "e".into(),
        author_time: 1,
        subject: "s".into(),
        path: "new".into(),
        old_path: Some("old".into()),
        status: FileStatus::Renamed,
        additions: None,
        deletions: None,
        binary: true,
    };
    write("FileHistoryEntry", &fh);
    write("FileHistory", &FileHistory { path: "new".into(), entries: vec![fh], truncated: false });
    let bc = BlameCommit {
        hash: "a".repeat(40),
        author_name: "n".into(),
        author_email: "e".into(),
        author_time: 1,
        subject: "s".into(),
        boundary: true,
    };
    let bl = BlameLine { hash: "a".repeat(40), orig_line: 1, orig_path: "p".into(), text: "t".into() };
    write("BlameCommit", &bc);
    write("BlameLine", &bl);
    write(
        "BlameResult",
        &BlameResult { path: "p".into(), rev: "HEAD".into(), lines: vec![bl], commits: vec![bc], binary: false, truncated: false },
    );
    write("CheckoutTarget", &CheckoutTarget::RemoteBranch { name: "origin/x".into(), local_name: None });
    write("OpResult", &OpResult { message: "ok".into() });
    write("BranchNameCheck", &BranchNameCheck { valid: true, exists: false, message: None });
    write(
        "RepoChangedEvent",
        &RepoChangedEvent { repo_path: "/r".into(), scopes: vec![RepoChangeScope::Head, RepoChangeScope::FetchHead] },
    );
    write("GitProgressEvent", &GitProgressEvent { repo_path: "/r".into(), op: GitOp::Fetch, line: "x".into() });

    write_v01();

    // spot-check critical shapes
    let v = serde_json::to_value(sample_ref()).unwrap();
    assert_eq!(v["type"], "localBranch");
    assert!(v.get("refType").is_none());
    let v = serde_json::to_value(CheckoutTarget::RemoteBranch { name: "o/x".into(), local_name: None }).unwrap();
    assert_eq!(v["kind"], "remoteBranch");
    assert!(v["localName"].is_null());
    let t: CheckoutTarget = serde_json::from_str(r#"{"kind":"localBranch","name":"x"}"#).unwrap();
    assert_eq!(t, CheckoutTarget::LocalBranch { name: "x".into() });
    assert_eq!(serde_json::to_value(GitOp::Pull).unwrap(), "pull");
    assert_eq!(serde_json::to_value(PullMode::FfOnly).unwrap(), "ffOnly");
    assert_eq!(serde_json::to_value(ErrorCode::GitNotFound).unwrap(), "gitNotFound");
}

fn sample_status_file() -> StatusFile {
    StatusFile {
        path: "src/a.ts".into(),
        old_path: Some("src/old.ts".into()),
        staged: Some(FileStatus::Renamed),
        unstaged: Some(FileStatus::Modified),
        untracked: false,
        conflict: None,
        submodule: false,
    }
}

fn write_v01() {
    let h = "a".repeat(40);
    let op = OperationState {
        operation: RepoOperation::Rebase,
        head_name: Some("feature".into()),
        onto_hash: Some(h.clone()),
        stopped_at: Some(h.clone()),
        step: Some(2),
        total: Some(5),
        can_continue: false,
        can_skip: true,
    };
    write("StatusFile", &sample_status_file());
    write("OperationState", &op);
    write(
        "WorkingTreeStatus",
        &WorkingTreeStatus {
            head_hash: Some(h.clone()),
            branch: Some("main".into()),
            upstream: Some("refs/remotes/origin/main".into()),
            ahead: Some(1),
            behind: Some(0),
            files: vec![sample_status_file()],
            truncated: false,
            operation: Some(op),
        },
    );
    write("ApplyPatchRequest", &ApplyPatchRequest { path: "a".into(), patch: "diff --git a/a b/a\n".into(), target: PatchTarget::Index, reverse: true });
    write("DiscardRequest", &DiscardRequest { paths: vec!["a".into()], untracked_paths: vec!["b".into()], include_staged: false });
    write("CommitRequest", &CommitRequest { message: "m".into(), amend: false, sign_off: true, allow_empty: false });
    write("CommitResult", &CommitResult { hash: h.clone(), message: "[main abc] m".into() });
    write("PushCommit", &PushCommit { hash: h.clone(), subject: "s".into(), author_name: "n".into(), author_time: 1 });
    write(
        "PushPreview",
        &PushPreview {
            local_branch: "main".into(),
            remotes: vec!["origin".into()],
            remote: Some("origin".into()),
            remote_branch: "main".into(),
            upstream: None,
            remote_hash: None,
            outgoing: vec![PushCommit { hash: h.clone(), subject: "s".into(), author_name: "n".into(), author_time: 1 }],
            behind: 0,
        },
    );
    write(
        "PushRequest",
        &PushRequest {
            remote: "origin".into(),
            local_branch: "main".into(),
            remote_branch: "main".into(),
            set_upstream: true,
            force_with_lease: None,
            follow_tags: false,
        },
    );
    write("StashEntry", &StashEntry { index: 0, hash: h.clone(), message: "WIP on main: x".into(), branch: Some("main".into()), time: 1 });
    write("StashRef", &StashRef { index: 0, hash: h.clone() });
    write("StashSaveRequest", &StashSaveRequest { message: None, include_untracked: true, keep_index: false, paths: None });
    write("MergeRequest", &MergeRequest { ref_name: "refs/heads/x".into(), mode: MergeMode::NoFf, message: None });
    write("OpOutcome", &OpOutcome { message: "m".into(), conflicts: true, operation: Some(RepoOperation::Merge) });
    write("CherryPickRequest", &CherryPickRequest { hashes: vec![h.clone()], record_origin: true, mainline: None });
    write("RevertRequest", &RevertRequest { hashes: vec![h.clone()], mainline: Some(1) });
    write("ResetRequest", &ResetRequest { hash: h.clone(), mode: ResetMode::Hard, discard_local_changes: true });
    write("CreateTagRequest", &CreateTagRequest { name: "v1".into(), target: h.clone(), message: Some("m".into()) });
    write("RevRange", &RevRange { include: "refs/heads/a".into(), exclude: "refs/heads/b".into() });
    write("CompareSummary", &CompareSummary { a_only: 1, b_only: 2, merge_base: None });
    let re = ReflogEntry { selector: "HEAD@{0}".into(), hash: h.clone(), action: "commit".into(), message: "m".into(), time: 1 };
    write("ReflogEntry", &re);
    write("Reflog", &Reflog { ref_name: "HEAD".into(), entries: vec![re], truncated: false });
    write("LineRange", &LineRange { start: 1, end: 2 });
    let lhe = LineHistoryEntry {
        hash: h.clone(),
        parents: vec![],
        author_name: "n".into(),
        author_email: "e".into(),
        author_time: 1,
        subject: "s".into(),
        path: "a".into(),
        hunks: vec![sample_hunk()],
    };
    write("LineHistoryEntry", &lhe);
    write("LineHistory", &LineHistory { path: "a".into(), rev: h.clone(), range: LineRange { start: 1, end: 2 }, entries: vec![lhe], truncated: false });
    write("AppSettings", &AppSettings::default());
    write("GitPathCheck", &GitPathCheck { ok: true, path: Some("/usr/bin/git".into()), version: Some("2.50.1".into()), message: None });
    write("UpdateInfo", &UpdateInfo { version: "0.2.0".into(), current_version: "0.1.0".into(), notes: None, pub_date: None });
    write(
        "Diagnostics",
        &Diagnostics { app_version: "0.1.0".into(), os: "macOS 15.1".into(), arch: "aarch64".into(), git_version: None, git_path: None, locale: None },
    );
    write("UpdateProgressEvent", &UpdateProgressEvent { downloaded: 1, total: None, finished: false });
    write("MenuActionEvent", &MenuActionEvent { action: MenuAction::CheckForUpdates });
    write(
        "RepoSummary",
        &RepoSummary {
            path: "/r".into(),
            name: "r".into(),
            open: true,
            branch: Some("main".into()),
            head_hash: Some(h),
            upstream: None,
            ahead: None,
            behind: None,
            changed_count: 1,
            staged_count: 0,
            conflict_count: 0,
            operation: None,
            last_fetch: None,
            error: None,
        },
    );
    write("QuickCommitTargetEvent", &QuickCommitTargetEvent { repo_path: "/r".into() });
    write("OpenRepoRequestEvent", &OpenRepoRequestEvent { path: "/r".into() });

    // value spot checks
    let v = serde_json::to_value(MergeRequest { ref_name: "x".into(), mode: MergeMode::FfOnly, message: None }).unwrap();
    assert_eq!(v["ref"], "x");
    assert_eq!(v["mode"], "ffOnly");
    assert_eq!(serde_json::to_value(RepoChangeScope::Worktree).unwrap(), "worktree");
    assert_eq!(serde_json::to_value(GitOp::CherryPick).unwrap(), "cherryPick");
    assert_eq!(serde_json::to_value(ErrorCode::StaleLease).unwrap(), "staleLease");
    assert_eq!(serde_json::to_value(ErrorCode::UpdateFailed).unwrap(), "updateFailed");
    assert_eq!(serde_json::to_value(ConflictKind::DeletedByThem).unwrap(), "deletedByThem");
    assert_eq!(serde_json::to_value(LanguageSetting::System).unwrap(), "system");
    assert_eq!(serde_json::to_value(RepoOperation::CherryPick).unwrap(), "cherryPick");
    // a missing revRange deserializes as None
    let f: LogFilter = serde_json::from_str(r#"{"text":null,"users":null,"date":null,"paths":null}"#).unwrap();
    assert!(f.rev_range.is_none());
    assert_eq!(REV_INDEX, "INDEX");
    assert_eq!(REV_WORKTREE, "WORKTREE");
    assert_eq!(QUICK_COMMIT_WINDOW_LABEL, "quick-commit");
}
