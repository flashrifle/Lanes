//! Pure tray menu model: ordering, titles, ids, ko/en strings. No Tauri types, fully unit-tested.
use crate::menu::Lang;
use crate::models::RepoSummary;
use std::path::Path;

pub const MAX_REPOS: usize = 8;

pub struct Strings {
    pub open_lanes: &'static str,
    pub settings: &'static str,
    pub check_updates: &'static str,
    pub quit: &'static str,
    pub pull: &'static str,
    pub push: &'static str,
    pub fetch: &'static str,
    pub quick_commit: &'static str,
    pub open_in_lanes: &'static str,
    pub no_repos: &'static str,
    pub detached: &'static str,
    pub pull_ok: &'static str,
    pub push_ok: &'static str,
    pub fetch_ok: &'static str,
    pub failed: &'static str,
    pub non_ff_hint: &'static str,
    pub no_remote: &'static str,
    pub auth_paused: &'static str,
    pub hidden_notice: (&'static str, &'static str),
    pub to_push: &'static str,
    pub to_pull: &'static str,
    pub up_to_date: &'static str,
    pub no_upstream: &'static str,
    pub last_fetch: &'static str,
    pub never_fetched: &'static str,
}

const KO: Strings = Strings {
    open_lanes: "Lanes 열기",
    settings: "설정…",
    check_updates: "업데이트 확인…",
    quit: "Lanes 종료",
    pull: "풀",
    push: "푸시",
    fetch: "페치",
    quick_commit: "빠른 커밋…",
    open_in_lanes: "Lanes에서 열기",
    no_repos: "열린 저장소 없음",
    detached: "분리됨",
    pull_ok: "풀 완료",
    push_ok: "푸시 완료",
    fetch_ok: "페치 완료",
    failed: "실패",
    non_ff_hint: "Lanes를 열어 리베이스/머지를 선택하세요",
    no_remote: "리모트가 설정되어 있지 않습니다",
    auth_paused: "인증에 실패해 이 저장소의 백그라운드 페치를 일시 중지했습니다",
    hidden_notice: ("Lanes가 메뉴 막대에서 계속 실행 중입니다", "완전히 종료하려면 메뉴 막대 아이콘에서 'Lanes 종료'를 선택하세요."),
    to_push: "보낼 커밋",
    to_pull: "받을 커밋",
    up_to_date: "최신 상태",
    no_upstream: "업스트림 없음",
    last_fetch: "마지막 페치",
    never_fetched: "페치한 적 없음",
};

const EN: Strings = Strings {
    open_lanes: "Open Lanes",
    settings: "Settings…",
    check_updates: "Check for Updates…",
    quit: "Quit Lanes",
    pull: "Pull",
    push: "Push",
    fetch: "Fetch",
    quick_commit: "Quick Commit…",
    open_in_lanes: "Open in Lanes",
    no_repos: "No repositories open",
    detached: "detached",
    pull_ok: "Pull complete",
    push_ok: "Push complete",
    fetch_ok: "Fetch complete",
    failed: "Failed",
    non_ff_hint: "Open Lanes to choose rebase/merge",
    no_remote: "No remote is configured",
    auth_paused: "Authentication failed; background fetch is paused for this repository",
    hidden_notice: ("Lanes is still running in the menu bar", "Choose 'Quit Lanes' from the menu bar icon to quit completely."),
    to_push: "to push",
    to_pull: "to pull",
    up_to_date: "Up to date",
    no_upstream: "No upstream",
    last_fetch: "Last fetch",
    never_fetched: "Never fetched",
};

pub fn strings(lang: Lang) -> &'static Strings {
    match lang {
        Lang::Ko => &KO,
        Lang::En => &EN,
    }
}

/// Open repos first (by name, case-insensitive), then the rest in their given order; at most 8.
pub fn order_and_limit(mut v: Vec<RepoSummary>) -> Vec<RepoSummary> {
    let (mut open, rest): (Vec<_>, Vec<_>) = v.drain(..).partition(|s| s.open);
    open.sort_by_key(|s| (s.name.to_lowercase(), s.path.clone()));
    open.extend(rest);
    open.truncate(MAX_REPOS);
    open
}

fn parent_name(path: &str) -> Option<String> {
    Path::new(path).parent().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().into_owned())
}

pub fn changed_text(lang: Lang, n: u32) -> String {
    match lang {
        Lang::Ko => format!("{n}개 변경"),
        Lang::En => format!("{n} changed"),
    }
}

/// "name — branch ↑a ↓b • N changed"; `label` is the (possibly disambiguated) name.
pub fn title(s: &RepoSummary, label: &str, lang: Lang) -> String {
    let st = strings(lang);
    if let Some(e) = &s.error {
        return format!("{label} — {e}");
    }
    let mut t = format!("{label} — {}", s.branch.as_deref().unwrap_or(st.detached));
    if let Some(a) = s.ahead.filter(|&a| a > 0) {
        t += &format!(" ↑{a}");
    }
    if let Some(b) = s.behind.filter(|&b| b > 0) {
        t += &format!(" ↓{b}");
    }
    if s.changed_count > 0 {
        t += &format!(" • {}", changed_text(lang, s.changed_count));
    }
    t
}

/// Titles for the (already ordered) repos; repos sharing a name get "name (parent)".
pub fn titles(repos: &[RepoSummary], lang: Lang) -> Vec<String> {
    repos
        .iter()
        .map(|s| {
            let dup = repos.iter().filter(|o| o.name.to_lowercase() == s.name.to_lowercase()).count() > 1;
            let label = match (dup, parent_name(&s.path)) {
                (true, Some(p)) => format!("{} ({p})", s.name),
                _ => s.name.clone(),
            };
            title(s, &label, lang)
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RepoAction {
    Pull,
    Push,
    Fetch,
    QuickCommit,
    OpenInLanes,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GlobalAction {
    OpenLanes,
    Settings,
    CheckUpdates,
    Quit,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Item {
    /// `info`: disabled first row of the submenu (sync state + last fetch).
    Repo { index: usize, title: String, info: Option<String>, actions: Vec<(RepoAction, String)> },
    Empty(String),
    Separator,
    Global(GlobalAction, String),
}

/// "Pull ↓3" when there is something to pull (same for push), else the plain label.
fn with_count(label: &str, arrow: char, n: Option<u32>) -> String {
    match n.filter(|&n| n > 0) {
        Some(n) => format!("{label}  {arrow}{n}"),
        None => label.to_string(),
    }
}

fn ago(lang: Lang, secs: i64) -> String {
    let m = (secs.max(0) / 60) as u64;
    match (lang, m) {
        (Lang::Ko, 0) => "방금".into(),
        (Lang::Ko, m) if m < 60 => format!("{m}분 전"),
        (Lang::Ko, m) if m < 60 * 24 => format!("{}시간 전", m / 60),
        (Lang::Ko, m) => format!("{}일 전", m / (60 * 24)),
        (Lang::En, 0) => "just now".into(),
        (Lang::En, m) if m < 60 => format!("{m} min ago"),
        (Lang::En, m) if m < 60 * 24 => format!("{} h ago", m / 60),
        (Lang::En, m) => format!("{} d ago", m / (60 * 24)),
    }
}

/// "↑2 to push · ↓3 to pull · Last fetch 5 min ago" (behind counts are only as fresh as the last fetch).
pub fn sync_info(s: &RepoSummary, lang: Lang, now: i64) -> Option<String> {
    if s.error.is_some() {
        return None;
    }
    let st = strings(lang);
    let mut parts = Vec::new();
    if s.upstream.is_none() {
        parts.push(st.no_upstream.to_string());
    } else {
        let (a, b) = (s.ahead.unwrap_or(0), s.behind.unwrap_or(0));
        if a > 0 { parts.push(format!("↑{a} {}", st.to_push)); }
        if b > 0 { parts.push(format!("↓{b} {}", st.to_pull)); }
        if a == 0 && b == 0 { parts.push(st.up_to_date.to_string()); }
    }
    parts.push(match s.last_fetch {
        Some(t) => format!("{} {}", st.last_fetch, ago(lang, now - t)),
        None => st.never_fetched.to_string(),
    });
    Some(parts.join(" · "))
}

/// Text next to the tray icon: totals over all listed repos, e.g. "↑2 ↓5"; None when nothing to sync.
pub fn tray_title(repos: &[RepoSummary]) -> Option<String> {
    let a: u32 = repos.iter().filter_map(|s| s.ahead).sum();
    let b: u32 = repos.iter().filter_map(|s| s.behind).sum();
    let mut parts = Vec::new();
    if a > 0 { parts.push(format!("↑{a}")); }
    if b > 0 { parts.push(format!("↓{b}")); }
    (!parts.is_empty()).then(|| parts.join(" "))
}

pub fn build_model(repos: &[RepoSummary], lang: Lang, now: i64) -> Vec<Item> {
    let st = strings(lang);
    let mut items = Vec::new();
    if repos.is_empty() {
        items.push(Item::Empty(st.no_repos.to_string()));
    }
    for (i, t) in titles(repos, lang).into_iter().enumerate() {
        items.push(Item::Repo {
            index: i,
            title: t,
            info: sync_info(&repos[i], lang, now),
            actions: vec![
                (RepoAction::Pull, with_count(st.pull, '↓', repos[i].behind)),
                (RepoAction::Push, with_count(st.push, '↑', repos[i].ahead)),
                (RepoAction::Fetch, st.fetch.to_string()),
                (RepoAction::QuickCommit, st.quick_commit.to_string()),
                (RepoAction::OpenInLanes, st.open_in_lanes.to_string()),
            ],
        });
    }
    items.push(Item::Separator);
    items.push(Item::Global(GlobalAction::OpenLanes, st.open_lanes.to_string()));
    items.push(Item::Global(GlobalAction::Settings, st.settings.to_string()));
    items.push(Item::Global(GlobalAction::CheckUpdates, st.check_updates.to_string()));
    items.push(Item::Separator);
    items.push(Item::Global(GlobalAction::Quit, st.quit.to_string()));
    items
}

fn action_key(a: RepoAction) -> &'static str {
    match a {
        RepoAction::Pull => "pull",
        RepoAction::Push => "push",
        RepoAction::Fetch => "fetch",
        RepoAction::QuickCommit => "quick",
        RepoAction::OpenInLanes => "open",
    }
}

pub fn repo_item_id(index: usize, a: RepoAction) -> String {
    format!("tray.repo.{index}.{}", action_key(a))
}

pub fn parse_repo_item_id(id: &str) -> Option<(usize, RepoAction)> {
    let rest = id.strip_prefix("tray.repo.")?;
    let (i, a) = rest.split_once('.')?;
    let action = [RepoAction::Pull, RepoAction::Push, RepoAction::Fetch, RepoAction::QuickCommit, RepoAction::OpenInLanes]
        .into_iter()
        .find(|x| action_key(*x) == a)?;
    Some((i.parse().ok()?, action))
}

pub fn global_item_id(a: GlobalAction) -> &'static str {
    match a {
        GlobalAction::OpenLanes => "tray.open",
        GlobalAction::Settings => "tray.settings",
        GlobalAction::CheckUpdates => "tray.updates",
        GlobalAction::Quit => "tray.quit",
    }
}

pub fn parse_global_item_id(id: &str) -> Option<GlobalAction> {
    [GlobalAction::OpenLanes, GlobalAction::Settings, GlobalAction::CheckUpdates, GlobalAction::Quit]
        .into_iter()
        .find(|a| global_item_id(*a) == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(path: &str, name: &str, open: bool) -> RepoSummary {
        RepoSummary {
            path: path.into(),
            name: name.into(),
            open,
            branch: Some("main".into()),
            head_hash: None,
            upstream: None,
            ahead: None,
            behind: None,
            changed_count: 0,
            staged_count: 0,
            conflict_count: 0,
            operation: None,
            last_fetch: None,
            error: None,
        }
    }

    #[test]
    fn ordering_and_cap() {
        let mut v = vec![s("/r/zed", "zed", false), s("/r/beta", "beta", true), s("/r/Alpha", "Alpha", true), s("/r/rec", "rec", false)];
        for i in 0..10 {
            v.push(s(&format!("/x/r{i}"), &format!("r{i}"), false));
        }
        let o = order_and_limit(v);
        assert_eq!(o.len(), MAX_REPOS);
        assert_eq!(o[0].name, "Alpha");
        assert_eq!(o[1].name, "beta");
        assert_eq!(o[2].name, "zed");
        assert_eq!(o[3].name, "rec");
    }

    #[test]
    fn titles_format() {
        let mut a = s("/w/app", "app", true);
        assert_eq!(title(&a, "app", Lang::En), "app — main");
        a.ahead = Some(2);
        a.behind = Some(0);
        a.changed_count = 3;
        assert_eq!(title(&a, "app", Lang::En), "app — main ↑2 • 3 changed");
        a.behind = Some(1);
        assert_eq!(title(&a, "app", Lang::Ko), "app — main ↑2 ↓1 • 3개 변경");
        a.branch = None;
        assert!(title(&a, "app", Lang::En).starts_with("app — detached"));
        a.error = Some("folder missing".into());
        assert_eq!(title(&a, "app", Lang::En), "app — folder missing");
    }

    #[test]
    fn duplicate_names_disambiguated() {
        let v = vec![s("/work/a/app", "app", true), s("/work/b/app", "app", true), s("/work/c/other", "other", false)];
        let t = titles(&v, Lang::En);
        assert_eq!(t[0], "app (a) — main");
        assert_eq!(t[1], "app (b) — main");
        assert_eq!(t[2], "other — main");
    }

    #[test]
    fn model_layout_and_strings() {
        let v = vec![s("/w/app", "app", true)];
        let m = build_model(&v, Lang::Ko, 0);
        assert!(matches!(&m[0], Item::Repo { actions, .. } if actions.len() == 5 && actions[0].1 == "풀"));
        assert_eq!(m[1], Item::Separator);
        assert!(matches!(&m[2], Item::Global(GlobalAction::OpenLanes, t) if t == "Lanes 열기"));
        assert!(matches!(m.last().unwrap(), Item::Global(GlobalAction::Quit, _)));
        let e = build_model(&[], Lang::En, 0);
        assert_eq!(e[0], Item::Empty("No repositories open".into()));
        assert_eq!(strings(Lang::En).non_ff_hint, "Open Lanes to choose rebase/merge");
    }

    #[test]
    fn ids_roundtrip() {
        for a in [RepoAction::Pull, RepoAction::Push, RepoAction::Fetch, RepoAction::QuickCommit, RepoAction::OpenInLanes] {
            assert_eq!(parse_repo_item_id(&repo_item_id(3, a)), Some((3, a)));
        }
        assert_eq!(parse_repo_item_id("tray.repo.x.pull"), None);
        for g in [GlobalAction::OpenLanes, GlobalAction::Settings, GlobalAction::CheckUpdates, GlobalAction::Quit] {
            assert_eq!(parse_global_item_id(global_item_id(g)), Some(g));
        }
    }

    #[test]
    fn sync_counts_and_tray_title() {
        let mut a = s("/x/app", "app", true);
        a.upstream = Some("refs/remotes/origin/main".into());
        a.ahead = Some(2);
        a.behind = Some(3);
        a.last_fetch = Some(1000);
        assert_eq!(sync_info(&a, Lang::Ko, 1000 + 300).as_deref(), Some("↑2 보낼 커밋 · ↓3 받을 커밋 · 마지막 페치 5분 전"));
        let m = build_model(std::slice::from_ref(&a), Lang::En, 0);
        assert!(matches!(&m[0], Item::Repo { actions, .. } if actions[0].1 == "Pull  ↓3" && actions[1].1 == "Push  ↑2"));
        let mut b = s("/x/lib", "lib", true);
        b.upstream = Some("refs/remotes/origin/main".into());
        b.ahead = Some(0);
        b.behind = Some(0);
        assert_eq!(sync_info(&b, Lang::En, 0).as_deref(), Some("Up to date · Never fetched"));
        assert_eq!(tray_title(&[a.clone(), b.clone()]).as_deref(), Some("↑2 ↓3"));
        assert_eq!(tray_title(&[b]), None);
        a.upstream = None;
        assert!(sync_info(&a, Lang::En, 0).unwrap().starts_with("No upstream"));
    }
}
