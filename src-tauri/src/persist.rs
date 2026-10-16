use crate::git::refs::{DEFAULT_FAVORITES, Favorites};
use crate::models::RecentRepo;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const MAX_RECENTS: usize = 15;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
struct StoredRecent {
    path: String,
    name: String,
    last_opened: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
struct StoredFavs {
    added: Vec<String>,
    removed: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct StateFile {
    recents: Vec<StoredRecent>,
    favorites: BTreeMap<String, StoredFavs>,
}

pub struct Persist {
    path: Option<PathBuf>,
    state: Mutex<StateFile>,
}

pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

impl Persist {
    /// `path` = state.json location; None = in-memory only.
    pub fn new(path: Option<PathBuf>) -> Self {
        let state = path
            .as_deref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Persist { path, state: Mutex::new(state) }
    }

    fn save(&self, st: &StateFile) {
        let Some(p) = &self.path else { return };
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = p.with_extension("json.tmp");
        if let Ok(json) = serde_json::to_string_pretty(st)
            && std::fs::write(&tmp, json).is_ok() {
                let _ = std::fs::rename(&tmp, p);
            }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, StateFile> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn push_recent(&self, path: &str, name: &str) {
        let mut st = self.lock();
        st.recents.retain(|r| r.path != path);
        st.recents.insert(0, StoredRecent { path: path.into(), name: name.into(), last_opened: now_secs() });
        st.recents.truncate(MAX_RECENTS);
        self.save(&st);
    }

    pub fn remove_recent(&self, path: &str) {
        let mut st = self.lock();
        st.recents.retain(|r| r.path != path);
        self.save(&st);
    }

    pub fn recents(&self) -> Vec<RecentRepo> {
        let st = self.lock();
        let mut v: Vec<&StoredRecent> = st.recents.iter().collect();
        v.sort_by_key(|a| std::cmp::Reverse(a.last_opened));
        v.into_iter()
            .map(|r| RecentRepo {
                path: r.path.clone(),
                name: r.name.clone(),
                last_opened: r.last_opened,
                exists: Path::new(&r.path).exists(),
            })
            .collect()
    }

    pub fn favorites(&self, repo: &str) -> Favorites {
        let st = self.lock();
        match st.favorites.get(repo) {
            Some(f) => Favorites { added: f.added.iter().cloned().collect(), removed: f.removed.iter().cloned().collect() },
            None => Favorites::default(),
        }
    }

    pub fn set_favorite(&self, repo: &str, full_name: &str, favorite: bool) {
        let mut st = self.lock();
        let f = st.favorites.entry(repo.to_string()).or_default();
        f.added.retain(|n| n != full_name);
        f.removed.retain(|n| n != full_name);
        let is_default = DEFAULT_FAVORITES.contains(&full_name);
        if favorite && !is_default {
            f.added.push(full_name.to_string());
        } else if !favorite && is_default {
            f.removed.push(full_name.to_string());
        }
        self.save(&st);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn favorites_and_recents_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("sub").join("state.json");
        let p = Persist::new(Some(file.clone()));
        assert!(p.favorites("/r").is_favorite("refs/heads/main"));
        p.set_favorite("/r", "refs/heads/main", false);
        p.set_favorite("/r", "refs/heads/dev", true);
        for i in 0..20 {
            p.push_recent(&format!("/repo{i}"), "x");
        }
        let p2 = Persist::new(Some(file));
        let f = p2.favorites("/r");
        assert!(!f.is_favorite("refs/heads/main"));
        assert!(f.is_favorite("refs/heads/dev"));
        assert_eq!(p2.recents().len(), MAX_RECENTS);
        p2.set_favorite("/r", "refs/heads/main", true);
        assert!(p2.favorites("/r").is_favorite("refs/heads/main"));
    }
}
