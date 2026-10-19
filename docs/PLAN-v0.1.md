# Lanes v0.1.0: implementation plan

This plan covers four groups: (A) release basics, (B) write ops, (C) history exploration, and (D) the menu bar.

Produced by `ecc:planner` and frozen by the coordinator. Every implementation agent follows this document.

**Contract: `src/types.ts` is frozen.** Do not edit it. If you need a change, describe it in your final report.

- Rust structs mirror the TS shapes exactly. Use `#[serde(rename_all = "camelCase")]`. `Option<T>` maps to `T | null`, and the field is always present, never `skip_serializing_if`.
- Type names are identical on both sides.
- See the original `PLAN.md` for the base rules: serde conventions, command style, `blocking(...)`, and the error model.
- Rust toolchain: `export PATH=/opt/homebrew/opt/rustup/bin:$PATH`.
- A dev app (`pnpm tauri dev`) may be running. Do not start another one.
- Agents never commit. The coordinator verifies, commits and pushes.

---

## 0. Findings that shape the plan
- **Repo operation state.** `RepoOperation` and `RefsSnapshot.operation` already exist. `detect_operation` in `git/refs.rs` handles merge, rebase, cherry-pick, revert and bisect.
  - Missing today: step counts, conflicted files, and whether continue/skip is possible.
  - Fix: a new `OperationState`, attached to `get_status` (not to refs).
- **Watcher.** `src-tauri/src/watcher.rs` ignores `index` and does not watch the worktree.
  - Add new scopes `index` and `worktree`.
  - `appStore.init` used to do a full `reload()` on every `repo-changed`. **Phase 0 already routes index/worktree-only events to `commit.refreshStatus()`.**
- **Git path and stdin.** `runner::git_path()` is a `OnceLock`, so it can't follow a settings change.
  - Change it to an `RwLock` override. Lookup order: settings, then env `GIT_LOG_VIEWER_GIT`, then the candidate list.
  - `run_stdin` has no timeout. Add a stdin + timeout variant of `exec`, used by commit (`-F -`), apply, and annotated tags.
- **`git/ops.rs` header.** It says "never reset --hard". Update it: hard reset is allowed only with `discardLocalChanges: true`.
- **Working diffs.** `get_file_diff` runs `norm_hash` on both sides. Sentinels (`REV_INDEX`, `REV_WORKTREE`) must bypass that and map to the git invocations in the `DiffRequest` comment.
  - `DiffWindowApp.tsx` treats `toHash` as a commit in two places: the history button and `shortHash`. Add guards there.
- **Non-UTF-8 lines.** `DiffLine.text` comes from `from_utf8_lossy` split on `\n`, so `\r` survives and non-UTF-8 bytes become U+FFFD.
  - A UI-built patch then fails `git apply --check`. This fails safe: the UI falls back to staging the whole file.
- **`ContextMenu` has no submenus.** Reset modes and merge options go through dialogs.
- **Report Issue.** `@tauri-apps/plugin-opener` with `opener:default` already allows http(s) URLs, so it needs no new dependency.
- **Settings live in the backend** (`state.json`). The native menu language and git path are Rust-side, and the diff, history and quick-commit windows need the same values.

## 1. Contract (in `src/types.ts`, already pasted in Phase 0)
Read these sections of `src/types.ts`. They are authoritative.

| Section heading in types.ts | What |
|---|---|
| `ErrorCode` | New codes: `pushRejected staleLease dirtyWorktree nothingToCommit unmergedFiles patchFailed updateFailed`. `busy` also covers `index.lock`. |
| `LogFilter.revRange` | Branch compare. Rust: `rev_range: Option<RevRange>`, which deserializes as `None` when missing. |
| `DiffRequest` comment | Working-tree sentinels `REV_INDEX` / `REV_WORKTREE` and the git command each pair maps to. |
| `Working tree / staging` | `StatusFile`, `OperationState`, `WorkingTreeStatus` (incl. `branch upstream ahead behind` from porcelain v2 `--branch`), `ApplyPatchRequest`, `DiscardRequest`, `ConflictSide`, `CommitRequest`, `CommitResult` |
| `Push` | `PushCommit`, `PushPreview`, `PushRequest` |
| `Stash` | `StashEntry`, `StashRef`, `StashSaveRequest` |
| `Merge / rebase / sequence` | `MergeMode`, `MergeRequest`, `OpOutcome`, `OperationAction`, `CherryPickRequest`, `RevertRequest`, `ResetMode`, `ResetRequest` |
| `Tags` | `CreateTagRequest`, `RefNameCheck` |
| `History exploration` | `RevRange`, `CompareSummary`, `ReflogEntry`, `Reflog`, `LineRange`, `LineHistoryEntry`, `LineHistory` |
| `App: settings / updates / diagnostics` | `AppSettings` (incl. `menuBarIcon`, `keepRunningInMenuBar`, `backgroundFetchMinutes`), `GitPathCheck`, `UpdateInfo`, `Diagnostics` |
| `Menu bar / Quick Commit` | `QUICK_COMMIT_WINDOW_LABEL`, `RepoSummary` |
| `Events` | `RepoChangeScope` (+`index`, `worktree`), `GitProgressEvent.op` (+push, commit, merge, rebase, cherryPick, revert), `EVENT_SETTINGS_CHANGED`, `EVENT_UPDATE_PROGRESS`, `EVENT_MENU_ACTION` / `MenuAction`, `EVENT_REPO_SUMMARIES`, `EVENT_QUICK_COMMIT_TARGET`, `EVENT_OPEN_REPO_REQUEST` |
| `CommandMap` (after `delete_branch`) | Every new command, with doc comments giving the exact git invocation and limits. |
| Graph contract | `line` on edge/arrow elements, `GraphRow.nodeLine`, and `GraphLayout.lineOf / lineKey / lineOfKey / lineOfRef` |

Rust-side mirrors:
- `GitOp` gains `Push, Commit, Merge, Rebase, CherryPick, Revert`.
- `RepoChangeScope` gains `Index, Worktree`.
- New consts for `REV_INDEX` / `REV_WORKTREE` and the event names.
- The graph types are TS-only.

### 1.1 Patch transport (line / hunk staging)
`src/ui/commit/patch.ts` is pure:

```ts
buildPatch(diff: FileDiff, selected: ReadonlySet<string> /* "h:l" = hunk index:line index */, mode: 'stage'|'unstage'|'discard'): string | null
```

- **Header:** `diff --git a/P b/P\n--- a/P\n+++ b/P\n`. Quote P in C style if it contains `"`, `\`, a control char, or a leading/trailing space.
- **Forward patch (stage):** drop an unselected `add`; turn an unselected `del` into context.
- **Reverse patch (unstage / discard):** build it in the diff's own direction; the backend applies it with `--reverse`. Turn an unselected `add` into context; drop an unselected `del`.
- **`noNewline` line:** emit it only if the line before it was emitted.
- **Hunks:** omit a hunk with no selected change and recompute the counts. Let `delta` = cumulative `newCount - oldCount` of the hunks emitted before this one, and let a side's *first* line be `start + 1` when that side has 0 lines, else `start`.
  - stage: keep `oldStart`; `newFirst = oldFirst + delta`.
  - unstage / discard (reverse): `first = newFirst(diff hunk) - delta`, and both sides start at `first` (the patch is applied with `--reverse` against the diff's new side, so it must be anchored there).
  - Then a side with 0 emitted lines is written as `first - 1`.
- **Empty selection:** return `null`.
- **When line-level ops are allowed:** only if `!binary && !truncated && oldPath == null && oldMode == newMode`, and the file is *modified* on that side. Added, deleted, untracked, conflicted and submodule files get file-level ops only.
- **Request mapping:**
  - stage = unstaged diff, `target 'index'`, `reverse false`
  - unstage = staged diff, `'index'`, `reverse true`
  - discard = unstaged diff, `'worktree'`, `reverse true`
- **Backend:** checks the path against the header paths, runs `git apply --check`, then `git apply [--cached] [--reverse] --recount --whitespace=nowarn -` over stdin.
- **On `patchFailed`:** the UI re-fetches the diff and offers to stage the whole file.
- **Ordering:** every write op of a repo (RepoStore.runOp and the commit store's stage / commit / stash ops) runs in one per-repo queue (`RepoStore.queue`) with one retry on `busy`, so fast clicking doesn't hit `busy` and a checkout can't race a stage.

### 1.2 Coordinator decisions
- **Hook PATH.** Git hooks (husky, npx) fail under the GUI's minimal PATH. At startup the backend resolves the login-shell PATH once: a fixed command with no user input, a 2 s timeout, and a fallback of `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`. It passes this as `PATH` to hook-running write ops (commit, merge, rebase, cherry-pick, revert, push).
- **Min git version: 2.23** (`git restore`). The UI warns based on `RepoInfo.gitVersion`.
- **The tray reuses group B's Rust functions.** There is no duplicate git logic.

---

## 2. Features

### A. Release basics
1. **Auto-update.** Uses `tauri-plugin-updater` against `https://github.com/flashrifle/Lanes/releases/latest/download/latest.json`.
   - Checks on launch if `checkForUpdates` is on. Also available from the app menu as "Check for Updates…".
   - `check_for_update` / `install_update` / `restart_app`, plus the `update-progress` event.
   - Debug-only env override `LANES_UPDATER_ENDPOINT` (`cfg(debug_assertions)`).
2. **Working-tree status row.** "Uncommitted changes (N)" sits at the top of the log, like IntelliJ's Local Changes.
   - Selecting it (`RepoStore.selectWorking()`) shows `LocalChangesPanel` in the right column.
   - ↑ from row 0 selects it.
3. **Settings dialog.** Opened with ⌘, from the app menu, which emits `menu-action` `settings`.
   - Language (system / ko / en override), row density, git path (validate first), date format (relative / absolute), external editor, update check, menu bar icon, keep running in menu bar, background fetch.
4. **Report Issue.** Help menu → "Report Issue…" opens a prefilled GitHub issue URL with app version, OS, arch, git version and the last error. There is no telemetry.

### B. Write ops
- **Commit and staging**
  - Stage/unstage at file level (`stage_files`, `unstage_files`) and at hunk/line level (`apply_patch`).
  - Discard, after a confirm (`discard_files`).
  - Commit message, amend and sign-off (`commit`).
- **Push.** `get_push_preview` lists outgoing commits. Push sets the upstream if missing. Force is only `--force-with-lease=<ref>:<expected hash>` after an explicit confirm, never `--force`.
- **Stash.** Save (untracked and keep-index options, optional paths), list, apply, pop and drop. Apply and pop verify `StashRef.hash`.
- **Merge and rebase**
  - Branch menu: "Merge into current" and "Rebase current onto".
  - In-progress banner with step N/M and Continue / Skip / Abort (`control_operation`).
  - Conflicts: list the files, then Accept Ours/Theirs (`resolve_conflict`), Open in Editor (`open_in_editor`), Reveal in Finder, and Mark Resolved (`stage_files`). There is no 3-way merge UI.
  - During a rebase the ours/theirs labels are swapped.
- **Cherry-pick and revert.** From the commit context menu, with multi-select. Cherry-pick applies oldest first, revert newest first. Merge commits need a mainline.
- **Reset.** Soft, mixed or hard. Hard requires typing a confirmation and `discardLocalChanges: true`, and the dialog mentions reflog recovery.
- **Tags.** Create lightweight or annotated at a commit (`validate_tag_name`, `create_tag`), delete locally, and push.

### C. History exploration
- **Branch compare.** "Compare with current" shows `CompareSummary` counts and filters the log through `LogFilter.revRange` (commits only in A, or only in B).
  - The UI sets the scope to all refs while compare is active.
- **Branch line highlight.** Clicking a graph node or edge, or a ref badge, highlights that line and dims everything else to alpha ≈0.25. Off-line row subjects are dimmed too.
  - Esc or a click on empty space clears it.
  - Stored as `RepoState.highlightKey` (a `lineKey`), which survives reloads.
  - No relayout.
- **Reflog view.** `get_reflog` on HEAD. Entries can be checked out or used to create a branch.
- **Selection history.** `git log -L` from the history window's blame or diff selection: "Show History for Selection" calls `get_line_history`, and the window has a line-history mode.

### D. Menu bar (tray) and Quick Commit
**Tray (git-backend).**
- Template icon (`icon_as_template`). The coordinator supplies the asset at `src-tauri/icons/tray-template.png` (+ `@2x`). Agents leave it out.
- Menu layout:
  - one submenu per repo, titled "name — branch ↑a ↓b • N changed", containing Pull, Push, Fetch, Quick Commit… and Open in Lanes;
  - then Open Lanes, Settings…, Check for Updates…, and Quit Lanes.
- The menu is rebuilt with a 1 s debounce.
- Repos come from `get_repo_summaries`: open repos first, sorted by name, then existing recents. At most 8. Recents are cached for at most 60 s.
- Each `RepoSummary` is derived from `status::read`, never from a separate walk. The tray emits `repo-summaries` (debounced 1 s) to all windows.
- Strings are ko/en, following `settings.language`.
- **Pull** is `ffOnly`. On `nonFastForward`, show a notification: "Open Lanes to choose rebase/merge".
- **Push** uses the `PushPreview` defaults and sets the upstream if missing. Never force.
- Results are shown as macOS notifications via `tauri-plugin-notification`, sent from Rust.
- Settings… / Check for Updates… emit the same `menu-action` events as the native menu, to "main" after showing it.

**Quick Commit window (Rust lifecycle in git-backend, UI in ui-app).**
- Label `quick-commit`, URL `index.html?quickCommit=1`, about 380×520.
- Created once, hidden. No decorations, not resizable, always on top, skip taskbar.
- Positioned with `tauri-plugin-positioner` at `TrayBottomCenter` by `open_quick_commit { repoPath }`, which emits `quick-commit-target { repoPath }` each time the window is shown.
- **Hiding**
  - It hides on blur, except while an op is in flight.
  - A show within 250 ms of a blur-hide is ignored, so clicking the tray icon again toggles the window.
  - Esc hides it.
- UI behaviour:
  - file-level checklist using `get_status` with `stage_files` / `unstage_files`;
  - a message box;
  - Commit, and Commit & Push.
  - The message is cleared only after the commit succeeds.
  - A push failure is shown inline with an "Open Lanes" button (`show_main_window`).
  - It always shows the file list before committing. There is no blind "commit all".

**Lifecycle (git-backend).**
- If `keepRunningInMenuBar` is on (it requires `menuBarIcon`), closing the main window calls `prevent_close`, hides the window, and switches to the Accessory activation policy.
- Open Lanes, or `RunEvent::Reopen`, switches back to Regular, then shows and focuses the window.
- `show_main_window { repoPath }` does the same. A non-null `repoPath` also emits `open-repo-request`; Phase 0 already wires that to `appStore.openRepo`.
- ⌘Q and tray Quit really exit.
- The first time the window is hidden, show a one-time notification explaining that Lanes is still in the menu bar.

**Background fetch.**
- A background thread handles `backgroundFetchMinutes` (15, 30 or 60; null means off).
- It fetches each open repo that has remotes, and skips a repo whose lock is busy.
- On `authFailed` it pauses that repo and sends one notification.

**Out of scope for v0.1:** launch at login (planned for v0.2).

---

## 3. File ownership (no overlaps)

| Agent | Model | Owns |
|---|---|---|
| **git-backend** | Sonnet | **All of `src-tauri/**`**, including:<ul><li>Cargo: `tauri-plugin-updater = "2"`, `tauri-plugin-notification = "2"`, `tauri-plugin-positioner = { version = "2", features = ["tray-icon"] }`, tauri features `tray-icon` + `image-png`</li><li>`tauri.conf.json`: updater config + `createUpdaterArtifacts`</li><li>capabilities: `quick-commit` is already added; add `core:window:allow-hide` and any plugin permissions</li><li>`menu.rs`: Settings… ⌘, and "Check for Updates…" under the app name, "Report Issue…" in Help. Emits `emit_to("main", EVENT_MENU_ACTION)`. Rebuilt with `app.set_menu` when the language changes.</li><li>runner: git path `RwLock` override, stdin+timeout exec, hook PATH</li><li>watcher: `index` + `worktree` scopes. Worktree root is recursive with gitDir paths excluded, 1000 ms debounce.</li><li>persist: settings</li><li>new modules: `git/{status,stage,commit,push,stash,sequence,reset,tags,reflog,linehist}.rs`, `app/{settings,updater,diag}.rs`, `tray/{mod.rs, model.rs (pure, tested), summary.rs, quick_window.rs, background.rs, lifecycle.rs}`</li><li>contract fixtures and tests</li></ul> |
| **ui-commit** | Opus | <ul><li>`src/ui/commit/**`: `commitStore.ts`, `patch.ts`, `workingFiles.ts`, `WorkingTreeRow.tsx`, `LocalChangesPanel.tsx`, `OperationBanner.tsx`, `CommitOverlays.tsx`, `commit.css`.<br>`LocalChangesPanel` has staged / unstaged / untracked / conflicts groups with checkboxes, the commit message with amend and sign-off, discard confirm, and stash save/list/apply/pop/drop. `OperationBanner` shows Continue / Abort / Skip and step N/M.</li><li>`src/diffwindow/**`: sentinel support, hunk/line gutter checkboxes for stage/unstage/discard, refresh on `repo-changed`</li><li>i18n part `commit.{ko,en}.ts`</li></ul> |
| **ui-ops** | Sonnet | <ul><li>`src/ui/ops/**`: `opsStore.ts`, `menus.ts`, `OpsOverlays.tsx`; dialogs for Push, Merge/Rebase, CherryPick/Revert, Reset (typed confirm for hard), Tag create/delete/push; `ReflogPanel`; Compare</li><li>`src/ui/branches/**`: BranchPanel push button, menu items, ref click → `setHighlightKey(layout.lineKey(layout.lineOfRef(fullName)))`</li><li>`src/ui/dialogs/**`</li><li>`src/ui/log/FilterBar.tsx`: compare chip, `revRange`. ui-ops also owns the `revRange` field of `FilterUi` / `toLogFilter` in `src/ui/state/logic.ts`; that is the only edit allowed in that file.</li><li>i18n part `ops.{ko,en}.ts`</li></ul> |
| **ui-app** | Sonnet | <ul><li>`src/ui/app/**`: `settingsStore.ts`, `SettingsDialog.tsx`, `UpdateDialog.tsx` (with the launch check), `reportIssue.ts` (pure URL builder), `lastError.ts`, `AppOverlays.tsx` (handles `menu-action`)</li><li>`src/i18n/index.ts`: `initI18n` honours `settings.language` and listens to `settings-changed`</li><li>`src/ui/log/density.ts`: backed by settings, same API</li><li>`src/ui/format/**`: absolute mode, same signatures</li><li>`src/historywindow/**`: "Show History for Selection" in BlameView/HistoryDiff, `HistorySession.lineRange`, line-history mode</li><li>`src/ui/welcome/**`</li><li>`src/quickcommit/**`: `QuickCommitApp.tsx`, `quickModel.ts` with a serialized stage queue and commit→push sequencing, `quickcommit.css`</li><li>i18n parts `app.{ko,en}.ts` and `quick.{ko,en}.ts`</li></ul> |
| **graph-engine** | Opus | <ul><li>`src/graph/**`: `line` on elements, `nodeLine`, `lineOf` / `lineKey` / `lineOfKey` / `lineOfRef`, and an `edgeLine` next to `edgeColor` in `colors.ts`. Replaces the Phase 0 stubs (`line: 0`, `nodeLine: 0`, `-1` / `''`).</li><li>`src/ui/log/{LogTable.tsx, GraphCell.tsx, palette.ts, refLabels.ts, graphHit.ts (new), log-ext.css (new)}`:<ul><li>hit-test: a click on a node or edge calls `setHighlightKey`;</li><li>badge click uses `lineOfRef`;</li><li>Esc or a click on empty space clears;</li><li>non-line elements drawn at alpha ≈0.25, off-line row subjects dimmed;</li><li>↑ from row 0 calls `selectWorking()`.</li></ul></li><li>i18n part `graph.{ko,en}.ts`</li></ul> |
| **coordinator** | – | Frozen after Phase 0: `types.ts`, `contract.test.ts`, `PLAN.md`, `docs/**`, `package.json`, `App.tsx`, `App.css`, `main.tsx`, `api.ts`, `ui/state/{repoStore,appStore,repoContext,logic,createStore}.ts` (except the `revRange` exception above), `i18n/{ko,en}.ts`, `ui/details/**`, `ui/layout/**`, `ui/tabs/**`, `ui/common/**`, `scripts/release.sh`, `README.md`, tray icon assets. |

**Rules**
- Each agent imports its own CSS file. No edits to `App.css`.
- Each agent keeps its dialog state in its own sub-store (`repo.commit`, `repo.ops`, or the ui-app module store), not in `DialogState`. Reusing `store.openDialog({ kind: 'confirm', ... })` is fine.
- Write ops go through `RepoStore.runOp(label, fn)` / `failToast(o)`. Both are public now: progress toast → info toast + reload.
- i18n key prefixes, so the parts never collide:
  - ui-commit: `commit.* stage.* stash.* conflict.*`
  - ui-ops: `ops.* push.* merge.* reset.* tag.* reflog.* compare.*`
  - ui-app: `settings.* update.* report.* history.* quick.*`
  - graph-engine: `graph.*`
  - Parts live in `src/i18n/parts/<area>.{ko,en}.ts`, and the en part is typed against the ko part's keys.
- Need a new npm dependency? Report it. git-backend may edit `Cargo.toml`.
- UI agents mock `call` in vitest until the backend milestones land.

### 3.1 Phase 0 hooks already in place (coordinator)
- **`src/types.ts`:** the full contract above. **`src/contract.test.ts`:** expected keys for every new struct. These stay red until the backend writes the fixtures.
- **Graph stubs:** `line: 0`, `nodeLine: 0`, `lineOf/lineOfKey/lineOfRef → -1`, `lineKey → ''` in `src/graph/{printElements,index}.ts`. Tests use `toMatchObject` for element shapes.
- **`src/ui/state/logic.ts`:** `toLogFilter` returns `revRange: null`.
- **i18n:** empty parts `src/i18n/parts/{commit,ops,app,graph,quick}.{ko,en}.ts`, spread into `ko` / `en`. `Key` includes the part keys. `koBase` holds the original keys.
- **`src/api.ts`:** `onEvent<T>(name, cb)`.
- **`RepoStore`:**
  - `readonly commit: CommitStore` and `readonly ops: OpsStore`, both disposed in `dispose()`;
  - state `workingSelected` + `selectWorking()`; `selectRowAt` / `moveFocus` / `selectAllRows` / `jumpTo*` clear it;
  - state `highlightKey` + `setHighlightKey(k)`, kept across reloads;
  - `runOp` and `failToast` are public;
  - `showError` and `failToast` call `recordError` (`ui/app/lastError.ts`);
  - `reload()` also calls `commit.refreshStatus()`.
- **`appStore`:**
  - `repo-changed` with scopes ⊆ {index, worktree} only refreshes status;
  - window focus refreshes the active tab's status;
  - `open-repo-request` calls `openRepo(path)`.
- **Stubs with their final export signatures:**
  - `ui/commit/commitStore.ts`: `CommitStore { refreshStatus(): Promise<void>; dispose(); state { status, statusLoading, statusError } }`, `useWorkingRowVisible(store): boolean`
  - `ui/commit/WorkingTreeRow.tsx`: `WorkingTreeRow({ height })`
  - `ui/commit/LocalChangesPanel.tsx`, `ui/commit/OperationBanner.tsx`, `ui/commit/CommitOverlays.tsx`
  - `ui/ops/opsStore.ts`: `OpsStore { dispose() }`
  - `ui/ops/menus.ts`: `commitMenuItems({ store, hashes, focusHash }): MenuItem[]` (hashes in row order, newest first) and `branchMenuItems(ref, store): MenuItem[]`
  - `ui/ops/OpsOverlays.tsx`
  - `ui/app/AppOverlays.tsx`
  - `ui/app/lastError.ts`: `recordError(e)` / `getLastError()`
  - `quickcommit/QuickCommitApp.tsx`: default export
- **Wiring:**
  - `App.tsx`: `<OperationBanner/>` in RepoBar; the right column is `workingSelected ? <LocalChangesPanel/> : ChangesTree + CommitDetailsPanel`; TabOverlays gets `<CommitOverlays/><OpsOverlays/>`; the root gets `<AppOverlays/>`.
  - `LogTable.tsx`: `<WorkingTreeRow/>` is the first child of the scroll container. The virtualizer uses `scrollMargin = visible ? rowH : 0` and rows render at `top = v.start - scrollMargin`. `commitMenuItems(...)` is appended to the row menu, and `highlightLine` is passed to GraphCell (accepted, not drawn yet).
  - `BranchPanel.tsx`: `branchMenuItems(ref, store)` appended.
  - `main.tsx`: `?quickCommit` → `QuickCommitApp`.
  - capabilities: window `quick-commit`.

## 4. Ordering and milestones
**Phase 1 (parallel).** The backend is the critical path at about 40 commands. Its milestones, in order, are what unblock the UI agents.
- **M1:**
  - `get_status` with the porcelain v2 `--branch` fields and operation state;
  - sentinel diffs;
  - stage / unstage / discard / apply_patch, and commit;
  - settings plus `menu-action` menu items;
  - watcher scopes;
  - error classification;
  - hook PATH.
- **M2:** push / preview, stash, merge / rebase / control, cherry-pick / revert, reset, tags, resolve_conflict, open_in_editor / reveal.
- **M3:** reflog, `compare_refs` + `revRange` in `filter_commits`, line history, diagnostics, updater.
- **M4 (tray, after M2):** summary → menu → notifications → lifecycle → quick window → background fetch.

Dependencies:
- graph-engine is independent.
- ui-commit needs M1.
- ui-ops needs M2.
- ui-app needs M1 (settings), M3 (updater, diagnostics, line history) and M4 (quick commit).

**Phase 2 (coordinator).**
1. Merge.
2. Run `pnpm test && pnpm tsc --noEmit && pnpm vite build && (cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings)`.
3. Manual QA (§6).

## 5. Release checklist
1. **Versions.** Set 0.1.0 in `package.json`, `src-tauri/Cargo.toml` and `tauri.conf.json`.
2. **Updater keys.** `pnpm tauri signer generate -w ~/.tauri/lanes-updater.key`, with a password.
   - The private key and its password never go into the repo.
   - Store the password in Keychain: `security add-generic-password -s lanes-updater-key-password -a lanes -w`. Back up the key offline. If the key is lost, existing installs can never update.
   - Add `*.key` and `.tauri/` to `.gitignore`.
   - At build time:
     ```
     export TAURI_SIGNING_PRIVATE_KEY=~/.tauri/lanes-updater.key
     export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=$(security find-generic-password -s lanes-updater-key-password -w)
     ```
3. **`tauri.conf.json`.** Set `bundle.createUpdaterArtifacts: true`, and `plugins.updater = { pubkey: "<contents of .key.pub>", endpoints: ["https://github.com/flashrifle/Lanes/releases/latest/download/latest.json"] }`.
4. **Universal build.** `pnpm tauri build --target universal-apple-darwin` produces:
   - `macos/Lanes.app`
   - `macos/Lanes.app.tar.gz` + `.sig`
   - `dmg/Lanes_0.1.0_universal.dmg`

   Signing identity: "Developer ID Application: jaemin lee (ZHQJ79W867)". Never the company cert.
5. **Notarization.** The keychain profile `lanes-notary` exists.
   - Tauri's built-in notarization reads `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` or the `APPLE_API_*` env vars. **Verify this.**
   - **A:** export them with `APPLE_TEAM_ID=ZHQJ79W867`, so Tauri notarizes and staples the .app before making the tarball and dmg. Then `xcrun notarytool submit <dmg> --keychain-profile lanes-notary --wait && xcrun stapler staple <dmg>`.
   - **B, profile only:**
     1. `ditto -c -k --keepParent Lanes.app L.zip`, then `notarytool submit --keychain-profile lanes-notary --wait`, then `stapler staple Lanes.app`.
     2. Re-tar it, then `pnpm tauri signer sign`.
     3. `hdiutil create -volname Lanes -srcfolder Lanes.app -format UDZO`, then codesign, notarize and staple the dmg.
   - **Verify:**
     - `codesign --verify --deep --strict`
     - `spctl -a -vv Lanes.app`
     - `spctl -a -t open --context context:primary-signature -v <dmg>`
     - `xcrun stapler validate`
6. **`latest.json`.** `version` has no "v". `signature` is the *contents* of the `.sig` file. Both `darwin-aarch64` and `darwin-x86_64` point at the same universal tarball:
   ```json
   {"version":"0.1.0","notes":"First public release.","pub_date":"<RFC3339>",
    "platforms":{
     "darwin-aarch64":{"signature":"<sig>","url":"https://github.com/flashrifle/Lanes/releases/download/v0.1.0/Lanes_0.1.0_universal.app.tar.gz"},
     "darwin-x86_64":{"signature":"<sig>","url":"<same>"}}}
   ```
7. **Local updater test.**
   1. Build 0.0.9 with `LANES_UPDATER_ENDPOINT=http://localhost:8000/latest.json`.
   2. Serve the 0.1.0 artifacts from that address.
   3. Check → install → relaunch, and confirm the version is 0.1.0.
   4. Also run it from the dmg / App Translocation; it should show a "move to /Applications" error.
8. **GitHub.** **Confirm with the user before any public step.**
   1. Tag `v0.1.0`.
   2. `gh release create v0.1.0 --draft ... <dmg> <tar.gz> <tar.gz.sig> latest.json`, with SHA-256 sums in the notes.
   3. Smoke-test the downloads.
   4. `gh release edit v0.1.0 --draft=false --latest`.
   5. `curl -sL .../latest/download/latest.json | jq .`
9. **Homebrew tap.** **Confirm with the user first.**
   1. Set `sha256` in `packaging/homebrew/lanes.rb` with `shasum -a 256 <dmg>`.
   2. Create the public repo `flashrifle/homebrew-tap` and add `Casks/lanes.rb`.
   3. Install command: `brew install --cask flashrifle/tap/lanes`.
10. **README / landing page.**
    - Features, including the write ops and the menu bar.
    - Screenshots.
    - Install: dmg (universal, macOS 11+) or brew. git ≥ 2.23.
    - Shortcuts.
    - Privacy: no telemetry. The only automatic network calls are the update check (can be turned off) and optional background fetch.
    - Apache-2.0 + NOTICE, fonts under OFL, copyright J-Lab.
11. **CSP.** Consider a real CSP before release; it is currently `csp: null`.

## 6. Risks and tests

**Risks**
- **Stale UI before a destructive op.** Each op checks against fresh state:
  - stash ops check index + hash;
  - force-with-lease checks the expected hash shown to the user;
  - hard reset requires its flag;
  - untracked discard re-verifies that the paths are untracked;
  - `control_operation` checks that the operation matches;
  - `apply_patch` checks the path.
- **Hooks / GPG / PATH in a GUI app.** Mitigated by the login PATH, a 300 s timeout, hook output streamed as `git-progress` op `commit`, and the stderr tail on failure.
- **`index.lock` held by an IDE.** Reported as `busy`. The UI retries once after 500 ms.
- **Worktree event storms** (node_modules, target). 1000 ms debounce, status-only refresh, single-flight, status capped at 10k entries.
- **Compare misses commits** outside the scope or beyond `LOG_LIMIT`. Use scope = all, and show the `CompareSummary` counts next to the matched count.
- **Rebase ours/theirs swap.** Labels follow the operation.
- **`--cc` combined diff isn't parsed.** Conflicted files use the (HEAD, WORKTREE) diff instead.
- **Updater key loss or pubkey mismatch.** Back up the key, and run the local updater test before publishing.
- **D.5: activation policy flicker.** Order matters. Hiding: hide the window *then* switch to Accessory. Showing: switch to Regular *then* show and focus.
- **D.5: tray click and blur race.** Two events from one click: the 250 ms toggle guard handles it.
- **D.5: notifications.** Don't send a notification for `busy` on background fetch. Use one per action outcome, and coalesce a repeated `authFailed`.
- **D.5: several repos with the same name.** The menu title disambiguates with the parent folder.

**Rust tests** (`src-tauri/tests/write_ops.rs`)

They use a `TestRepo` helper: a tempdir with `git init -b main`, a local user config, `commit_file()`, and a bare remote for push.

- **status:** porcelain v2 records 1/2/u/?, branch / ahead / behind, renames, unborn, submodule, truncation
- **operation state:** rebase step/total, cherry-pick sequence
- **stage / unstage:** including unborn and deletions
- **discard:** tracked, staged + `includeStaged`, untracked; ignored files are refused
- **apply_patch:**
  - forward, reverse, worktree
  - a stale patch → `patchFailed`; a path mismatch → `invalidArgument`
  - no-newline and CRLF fixtures
- **commit:**
  - amend
  - nothing staged → `nothingToCommit`; unmerged files → `unmergedFiles`
  - a message starting with `-`, passed via stdin
- **push:**
  - a new branch with `-u`
  - rejected → `pushRejected`; a lease with a stale hash → `staleLease`; a valid lease succeeds
  - pushing a tag
- **stash:** save with `-u` / `-k`; an apply/pop conflict keeps the entry; a wrong hash → `invalidArgument`; drop
- **merge:** ff, no-ff, and a conflict → `OpOutcome` + continue/abort
- **rebase:** dirty → `dirtyWorktree`; a conflict → skip/abort
- **cherry-pick:** several commits oldest-first; a merge without mainline → `invalidArgument`
- **revert:** several commits
- **reset:** soft and mixed; hard without the flag is rejected; hard with the flag
- **tags:** lightweight and annotated; existing name rejected; invalid name; delete
- **history:** reflog parsing; compare counts + `revRange` filter; line history across a rename
- **settings:** round-trip, git path override
- **watcher:** classifies index vs worktree changes
- **errors:** classification strings
- **contract fixtures** for every new type
- **D.6:**
  - `tray/model.rs` (pure): menu model from `RepoSummary[]`, titles, ordering, max 8, duplicate-name disambiguation, ko/en strings
  - summary derivation from a status fixture
  - background-fetch scheduling (interval, skip busy, pause on auth)
- **Golden patches:** vitest writes `src/ui/commit/__fixtures__/*.json` (`{before, after, diff, selection, mode, patch}`). A Rust test applies them in a temp repo and checks the result, which catches drift between the TS patch builder and git.

**Vitest**
- **`patch.ts`:** single-line add/del/replace, mixed selection, several hunks with start offsets, no-newline at EOF on either side, CRLF, quoted paths, empty selection → null, ineligible files.
- **`workingFiles.ts`:** `StatusFile` → `ChangedFile` with sentinels.
- **`reportIssue.ts`:** encoding, URL capped at 7500 chars, `$HOME` redacted to `~`, stderr tail.
- **Other UI:**
  - settings store, density, absolute dates
  - `historywindow/session` `lineRange`
  - `quickModel.ts`: stage queue ordering, commit→push sequencing, the message is kept on failure
  - FilterBar compare → `revRange`
- **Graph:**
  - `line` ids match ownership
  - paired up/down elements share `line`
  - `lineKey` is stable across reloads
  - `lineOfRef` falls back for a ref that owns no commits

**Manual QA before tagging**
- every context menu item
- the hard reset warning
- conflict flows for merge, rebase, cherry-pick and stash pop: Open in Editor → mark resolved → continue
- line staging in the diff window
- switching the language: UI, native menu, tray, and the diff, history and quick-commit windows
- Check for Updates: up to date, available, offline
- the contents of the Report Issue URL
- tray:
  - Pull / Push / Fetch notifications
  - Quick Commit toggle and blur behaviour
  - closing to the menu bar and reopening (Dock click)
  - ⌘Q really quits
