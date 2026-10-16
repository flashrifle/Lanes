# Lanes — Implementation Plan

Standalone macOS Tauri 2 app that reimplements the JetBrains IDE (WebStorm 2026.2) Git tool window **Log** tab.
Produced by the ecc:planner agent; orchestrated by the main session.

**Shared contract: `src/types.ts` (frozen).** All three agents code against it. If you believe it must change, do NOT edit it — describe the change in your final report.

## Architecture
- Rust runs system `git`, keeps a full in-memory `Snapshot` per log load. Frontend receives a compact skeleton (hashes, parent indices, timestamps, refs) for ≤~100k commits in one call, then pages row text (subject/author/date) for visible rows via `get_commit_rows`.
- Pure TS graph engine (port of IntelliJ `platform/vcs-log/graph`, Apache-2.0) turns the skeleton into per-row print elements lazily. React draws each row's graph on a small per-row canvas inside a virtualized table.

## Key decisions
1. `load_log`: one `git log -z --date-order` over the selected refs. Skeleton `parents` are snapshot indices (-1 = not loaded). Row text via `get_commit_rows(snapshotId, indices)` in batches ≤500 for visible range ±50. No streaming in v1. Target 100k commits: backend < 2s, ~6 MB JSON.
2. Branch filter = `LogScope.refs` → reload `load_log`.
3. Text/User/Date/Path filters → `filter_commits` returns matching snapshot indices; engine gets a `visible` mask and connects remaining commits with dotted edges (like IntelliJ DottedFilterEdgesGenerator). Text/user/date in Rust memory; paths via `git log --format=%H --full-history --simplify-merges <scope revs> -- <paths>` intersected.
4. Sort: backend always returns `--date-order` (topo-valid). Engine re-sorts per `GraphSortType`: `normal` = identity, `bek` = IntelliJ BekSorter ("Standard", default), `linearBek` = IntelliSort (stretch; falls back to `bek`). Visible row ≠ snapshot index — UI always maps via `layout.commitIndexAt(row)`.
5. Lazy on demand: containing branches (`for-each-ref --contains`), signatures (visible rows only, cache by hash), diffs.
6. Graph engine runs sync on the main thread (O(n) layout, lazy rows with block cache). Pure API so it can move to a Worker later.
7. Watcher: `notify` (FSEvents) with a hand-rolled 400 ms trailing debounce → emits `repo-changed`. UI does single-flight reload (dirty flag if an event arrives mid-reload).
8. Errors: every command returns `Result<T, AppError>`; `invoke` rejects with the serialized `AppError`. `api.ts` normalizes anything else to `{code:'internal'}`.

## Dependencies (already installed by orchestrator)
npm: `@tanstack/react-virtual ^3`, `@tauri-apps/plugin-dialog ^2`, dev `vitest` (`pnpm test` = `vitest run`, includes `src/**/*.test.ts`).
Cargo: `tauri-plugin-dialog 2`, `notify 8`, `thiserror 2`, `regex 1`, dev `tempfile 3`. Capability `dialog:default` added.
Rust toolchain: `export PATH=/opt/homebrew/opt/rustup/bin:$PATH`.

## File ownership (strict)
- orchestrator: `PLAN.md`, `src/types.ts`, `package.json`, `vite.config.ts`, `tsconfig*.json`, `src/contract.test.ts`.
- graph-engine: `src/graph/**` (replaces the stub `src/graph/index.ts`).
- git-backend: `src-tauri/**` incl. `Cargo.toml`, `tauri.conf.json` (window 1400×900, minWidth 900, title "Lanes"), capabilities.
- ui-frontend: `src/ui/**`, `src/App.tsx`, `src/App.css`, `src/main.tsx`, `src/api.ts`.
Need a new dependency? Report it instead of installing (except git-backend may edit Cargo.toml).

## Tauri commands (Rust)
All: `#[tauri::command] async fn name(state: State<'_, AppState>, app: AppHandle, ...) -> Result<T, AppError>`; owned args; snake_case params auto-map to camelCase JS keys (`repo_path`↔`repoPath`, `snapshot_id`↔`snapshotId`, `start_point`↔`startPoint`). Git work inside `tauri::async_runtime::spawn_blocking`.
Rust type names = TS type names. serde: every struct `rename_all = "camelCase"`; unit enums `rename_all = "camelCase"`; `Ref.ref_type` → `#[serde(rename = "type")]`; `CheckoutTarget` → `#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]`; `GitProgressEvent.op` = enum `GitOp {Fetch, Pull, Checkout}` camelCase; never `skip_serializing_if` on Option; indices `u32` except `parents: Vec<Vec<i64>>`.

| command | rust args | returns | impl notes |
|---|---|---|---|
| open_repo | path | RepoInfo | `rev-parse --show-toplevel --absolute-git-dir --git-common-dir`; push to recents (max 15); start watcher (replace existing for path) |
| close_repo | repo_path | () | stop watcher, drop snapshots for repo |
| get_recent_repos | – | Vec<RecentRepo> | `app_config_dir()/state.json`, newest first |
| remove_recent_repo | path | () | |
| get_refs | repo_path | RefsSnapshot | `for-each-ref --format=%(refname)%00%(objectname)%00%(*objectname)%00%(upstream)%00%(upstream:track,nobracket)%00%(HEAD) refs/heads refs/remotes refs/tags`; `symbolic-ref -q HEAD`; `rev-parse -q --verify HEAD`; operation from MERGE_HEAD / rebase-merge / rebase-apply / CHERRY_PICK_HEAD / REVERT_HEAD / BISECT_LOG |
| set_favorite | repo_path, full_name, favorite | () | persisted per repo in state.json (explicit added/removed sets over defaults main/master) |
| load_log | repo_path, scope | LogSnapshot | see backend modules |
| release_snapshot | snapshot_id | () | |
| get_commit_rows | snapshot_id, indices | Vec<CommitMeta> | same order as indices; OOR → invalidArgument; unknown id → snapshotExpired |
| filter_commits | snapshot_id, filter | FilterResult | AND across criteria; bad regex → invalidArgument |
| get_authors | snapshot_id | Vec<AuthorInfo> | |
| get_commit_details | repo_path, hash | CommitDetails | `log -1 -z --format=...` |
| get_containing_refs | repo_path, hash | Vec<String> fullNames | `for-each-ref --contains <hash> --format=%(refname) refs/heads refs/remotes refs/tags` |
| get_signatures | repo_path, hashes | Vec<SignatureInfo> | `log --no-walk=unsorted --stdin -z --format=%H%x1f%G?%x1f%GS` |
| get_changed_files | repo_path, hashes (UI row order newest first) | ChangesResult | `diff-tree -r -z -M --name-status` + `diff -z -M --numstat` (binary `-\t-`); root commit vs empty tree (`git hash-object -t tree --stdin` with empty stdin) |
| get_file_diff | repo_path, request | FileDiff | `diff --no-color --no-ext-diff -M -U<n> <from\|emptytree> <to> -- [oldPath] path`, parsed |
| validate_branch_name | repo_path, name | BranchNameCheck | `check-ref-format --branch`; `show-ref --verify --quiet refs/heads/<n>` |
| checkout | repo_path, target | OpResult | local: `checkout <name>`; remote: if local `localName` exists → checkout it (invalidArgument if its upstream differs) else `checkout -b <local> --track <remote/x>`; tag/commit: `checkout --detach <x>` |
| fetch | repo_path, remote: Option | OpResult | `fetch --prune --progress (--all\|<remote>)`; stderr streamed as `git-progress` |
| pull | repo_path, mode | OpResult | `pull --progress --ff-only \| --rebase \| --no-rebase` |
| create_branch | repo_path, name, start_point, checkout | OpResult | validate; `branch <name> <start>` or `checkout -b <name> <start>` |
| delete_branch | repo_path, name, force | OpResult | refuse current branch (invalidArgument); `branch -d`/`-D`; "not fully merged" → notFullyMerged |

Events: `"repo-changed"` → RepoChangedEvent; `"git-progress"` → GitProgressEvent.

## Graph engine (`src/graph/`)
Public API: `export function buildGraph(snapshot: LogSnapshot, options: GraphOptions): GraphLayout;`
Uses `parents`, `timestamps`, `refs.refs` (`index`, `type`, `isCurrent`, `isFavorite`, `fullName`).
Head priority for layout (IntelliJ GitBranchLayoutComparator): origin/main|master > other remote branches > local main|master > other local branches > tags > HEAD > childless commits; ties by name. Current branch (else main/master) is pinned to color 0.

Pipeline (port of intellij-community `platform/vcs-log/graph`):
1. PermanentLinearGraph: CSR Int32Arrays for down edges (parents) and up edges (children). Parent -1 → "not loaded" edge: down segment + down arrow.
2. Sort per sortType (`bek` = BekSorter via BekBranchCreator/BekBranchMerger using timestamps). Produces `rowToCommit`/`commitToRow`.
3. Filter (if `visible`): reduced graph over visible nodes. Reverse row order; `reach(n)` = {n} if visible else dedup union of reach(parents) capped at 8. Visible node parents = ∪ reach(p). Edges skipping hidden nodes are `dotted`. No transitive reduction.
4. GraphLayoutBuilder: ITERATIVE DFS (no recursion) from heads by priority, assigning `layoutIndex`; a new index for each non-first-parent branch; record `headOf(layoutIndex)`.
5. EdgesInRowGenerator: block cache of pass-through edges every 1000 rows; row r computed from nearest block forward.
6. PrintElementGenerator: elements = node + passing edges, sorted by GraphElementComparatorByLayoutIndex; position = rank. Long edges (≥30 rows, `collapseLongEdges`) keep 1 visible row at each end + arrows. LRU of ~2000 rows for `getRow`.
7. Colors (GraphColorGetterByHead): color by layoutIndex; head's first fragment → `hash(head fullName) % 16`, else `hash(layoutIndex) % 16`; current branch (else main/master) pinned to color 0; edge color = its layoutIndex color; stable across reloads for same refs.

**Invariant (tested):** for every row r and each `down` element (lane=a, otherLane=b), row r+1 has an `up` element with lane=b, otherLane=a, same color and dotted — and vice versa.
Perf: `buildGraph` < 300 ms for 100k commits; `getRow` amortized < 50 µs.
Tests in `src/graph/__tests__/*.test.ts`: linear, branch+merge diamond, octopus, criss-cross, missing parent arrow, mask/dotted, invariant on seeded random DAGs, long-edge arrows, Bek keeps merged branch contiguous, perf 100k (only when `PERF=1`).

## git-backend modules (`src-tauri/src/`)
- `error.rs`: AppError/ErrorCode + stderr classification (LC_ALL=C): "not a git repository"→notARepo; "Authentication failed"/"Permission denied (publickey)"/"could not read Username"→authFailed; "Not possible to fast-forward"→nonFastForward; "would be overwritten"→wouldOverwrite; "no tracking information"→noUpstream; "not fully merged"→notFullyMerged.
- `git/runner.rs`: locate git (env `GIT_LOG_VIEWER_GIT`, `/opt/homebrew/bin/git`, `/usr/local/bin/git`, `/usr/bin/git` — GUI apps get a minimal PATH). Base args `-C <repo> -c core.quotepath=false -c color.ui=false -c log.showSignature=false`; env `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`, `GIT_OPTIONAL_LOCKS=0` for reads; stdin null; bytes + `from_utf8_lossy`. Env only via Command (no `std::env::set_var`, unsafe in 2024). Streaming variant splits stderr on `\r`/`\n` for progress.
- `git/log.rs`: `git log -z --date-order --format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%ct%x1f%B` + revs (scope refs, or `--branches --remotes --tags HEAD`) + `--max-count`. Split on NUL, `splitn(7, 0x1f)`; subject = first line of %B. Validate refs don't start with `-`, then `--`. Read stdout incrementally (BufReader split(0)). Unborn/empty repo → empty snapshot.
- `snapshot.rs`: SnapshotStore (`Mutex<HashMap<u32, Arc<Snapshot>>>`, keep 4 most recent, AtomicU32 ids); CommitRecord {hash, parents, author_name, author_email, author_time, committer_time, message}; hash→index; text/user/date filter, authors, path filter via git.
- `git/refs.rs`, `git/changes.rs`, `git/diff.rs` (unified diff parser: hunks, `\ No newline`, `Binary files`, mode lines, truncation 2MB/20k lines), `git/ops.rs` (write ops serialized per repo by Mutex; held → busy).
- `watcher.rs`: notify RecommendedWatcher recursive on gitDir (+ commonDir if different). Relevant: HEAD, ORIG_HEAD, FETCH_HEAD, MERGE_HEAD, packed-refs, refs/**, rebase-*. Ignore `*.lock`, objects/, logs/, index. 400 ms trailing debounce thread merges scopes then emits.
- `persist.rs`: state.json `{recents, favorites: {repo: {added: [], removed: []}}}`.
- `commands.rs`, `lib.rs`: register `tauri_plugin_dialog::init()`, `.manage(AppState)`, all 22 commands; remove `greet`.
- Tests: parser unit tests (log records, for-each-ref track `ahead 1, behind 2`/`gone`, name-status -z with renames, numstat binary, unified diff); `tests/integration.rs` with tempfile repos (linear, branch+merge, rename, root commit, unborn, delete -d unmerged → notFullyMerged, ff-only refusal with local bare remote). Contract test writes one serialized sample per struct to `tests/fixtures/contract/<Type>.json`.

## ui-frontend files
- `api.ts`: `call<K extends CommandName>(cmd: K, args: CommandMap[K][0]): Promise<CommandMap[K][1]>`, `toAppError(e)`, `onRepoChanged(cb)`, `onGitProgress(cb)`, `pickFolder()` (plugin-dialog `open({directory:true})`).
- `ui/state/store.ts`: small external store + `useSyncExternalStore`: repo, refs, snapshot, layout, filter, sort, selection (Set of commit indices + anchor), CommitMeta cache by snapshot index, single-flight reload; preserve selection & scroll anchor by hash across reloads; on snapshotExpired reload once.
- `ui/welcome/WelcomeScreen.tsx`: recents + Open; auto-open most recent existing repo on start.
- `ui/layout/SplitPane.tsx`: 3 columns, right column split top/bottom, sizes in localStorage.
- `ui/branches/branchTree.ts` (pure, tested): HEAD(현재 브랜치) / 로컬 / 리모트 → remote → folders by `/` / 태그; favorites first (★). `BranchPanel.tsx`: "브랜치 또는 태그" search, vertical toolbar (new branch, fetch, favorite, collapse/expand); click selects + jumps to commit; double-click sets Branch filter; context menu 체크아웃 / 새 브랜치 / 삭제 / 즐겨찾기.
- `ui/log/FilterBar.tsx`: "텍스트 또는 해시" field with `.*` and `Cc` toggles (debounce 300 ms); 브랜치 / 사용자 / 날짜 / 경로 dropdowns (users from get_authors + "me" from RepoInfo.user); sort type menu; refresh.
- `ui/log/LogTable.tsx`: `useVirtualizer` fixed 22 px rows; columns subject+graph, author, date, status; fetch missing meta for visible ±50 (debounce 30 ms); ↑/↓, shift/cmd multi-select; context menu: copy hash, checkout revision (confirm detached), new branch here.
- `ui/log/GraphCell.tsx`: per-row DPR canvas; `LANE_W=14, ROW_H=22, NODE_R=3.5`, line width 1.5; 16-color palette.
- `ui/log/refLabels.ts` (pure, tested): local branch + upstream at same commit → one label "origin & main"; order HEAD/current, favorites, local, remote, tags; right-aligned chips. Merge commits muted.
- `ui/format/date.ts` (tested): 오늘/어제 + `Intl.DateTimeFormat('ko-KR',{hour:'numeric',minute:'2-digit'})` ("오후 5:23"); else "2026. 10. 3.".
- `ui/details/ChangesTree.tsx` ("N개 파일" header, dir tree, double-click → diff); `ui/details/CommitDetailsPanel.tsx` (message, hash copy, author/committer/date, refs, clickable parents, lazy containing branches).
- `ui/diff/DiffView.tsx`: unified diff overlay, Esc closes.
- `ui/dialogs/{CreateBranchDialog,ConfirmDialog}.tsx`: create validates via validate_branch_name + checkout checkbox; delete → notFullyMerged → confirm force; pull nonFastForward → offer rebase/merge; progress toast from git-progress.
- Styling: WebStorm New UI dark — bg `#1E1F22`, panels `#2B2D30`, selection `#2E436E`, text `#DFE1E5`, muted `#6F737A`.
- Tests: vitest for branchTree, refLabels, date, store reducers.

## Verification
`pnpm test` · `PERF=1 pnpm vitest run src/graph` · `pnpm tsc --noEmit && pnpm build` · `cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings` · `pnpm tauri build --debug`.

## Risks
Bek port difficulty (ship `normal` first; invariant test catches drawing bugs) · 100k IPC/memory (default limit 200k + truncated banner if > 3 s) · JS vs Rust regex syntax (tooltip; invalidArgument → red outline) · GUI PATH/credentials (explicit git paths, GIT_TERMINAL_PROMPT=0, null stdin) · watcher feedback loops (GIT_OPTIONAL_LOCKS=0, ignore index/objects/locks) · snapshot eviction (reload once) · contract drift (frozen types.ts + fixture key test).
