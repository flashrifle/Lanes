//! Native app menu, localised from the system locale (Korean or English). Same layout as Tauri's default menu,
//! but with the proper app name ("Lanes", not the crate name) and the app icon in the About panel.

use tauri::menu::{
    AboutMetadata, Menu, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID,
};
use tauri::{AppHandle, Runtime};

const APP_NAME: &str = "Lanes";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    Ko,
    En,
}

/// Picks the menu language from a BCP-47 locale such as "ko-KR" or "en_US".
pub fn lang_from_locale(locale: Option<&str>) -> Lang {
    match locale {
        Some(l) if l.to_ascii_lowercase().starts_with("ko") => Lang::Ko,
        _ => Lang::En,
    }
}

struct Strings {
    about: String,
    hide: String,
    hide_others: &'static str,
    show_all: &'static str,
    services: &'static str,
    quit: String,
    file: &'static str,
    close_window: &'static str,
    edit: &'static str,
    undo: &'static str,
    redo: &'static str,
    cut: &'static str,
    copy: &'static str,
    paste: &'static str,
    select_all: &'static str,
    view: &'static str,
    fullscreen: &'static str,
    window: &'static str,
    minimize: &'static str,
    zoom: &'static str,
    help: &'static str,
    credits: &'static str,
}

fn strings(lang: Lang) -> Strings {
    match lang {
        Lang::Ko => Strings {
            about: format!("{APP_NAME} 정보"),
            hide: format!("{APP_NAME} 가리기"),
            hide_others: "기타 가리기",
            show_all: "모두 보기",
            services: "서비스",
            quit: format!("{APP_NAME} 종료"),
            file: "파일",
            close_window: "윈도우 닫기",
            edit: "편집",
            undo: "실행 취소",
            redo: "실행 복귀",
            cut: "오려두기",
            copy: "복사하기",
            paste: "붙여넣기",
            select_all: "전체 선택",
            view: "보기",
            fullscreen: "전체 화면 시작",
            window: "윈도우",
            minimize: "최소화",
            zoom: "확대/축소",
            help: "도움말",
            credits: "IntelliJ Platform 그래프 엔진 기반 · Apache-2.0",
        },
        Lang::En => Strings {
            about: format!("About {APP_NAME}"),
            hide: format!("Hide {APP_NAME}"),
            hide_others: "Hide Others",
            show_all: "Show All",
            services: "Services",
            quit: format!("Quit {APP_NAME}"),
            file: "File",
            close_window: "Close Window",
            edit: "Edit",
            undo: "Undo",
            redo: "Redo",
            cut: "Cut",
            copy: "Copy",
            paste: "Paste",
            select_all: "Select All",
            view: "View",
            fullscreen: "Enter Full Screen",
            window: "Window",
            minimize: "Minimize",
            zoom: "Zoom",
            help: "Help",
            credits: "Graph engine derived from IntelliJ Platform · Apache-2.0",
        },
    }
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let s = strings(lang_from_locale(sys_locale::get_locale().as_deref()));
    let about = AboutMetadata {
        name: Some(APP_NAME.into()),
        version: Some(app.package_info().version.to_string()),
        copyright: app.config().bundle.copyright.clone(),
        credits: Some(s.credits.into()),
        // The default window icon is the 32px one, which looks tiny in the About panel.
        icon: Some(tauri::include_image!("icons/128x128.png")),
        ..Default::default()
    };

    let app_menu = Submenu::with_items(
        app,
        APP_NAME,
        true,
        &[
            &PredefinedMenuItem::about(app, Some(&s.about), Some(about))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, Some(s.services))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some(&s.hide))?,
            &PredefinedMenuItem::hide_others(app, Some(s.hide_others))?,
            &PredefinedMenuItem::show_all(app, Some(s.show_all))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some(&s.quit))?,
        ],
    )?;
    let file_menu = Submenu::with_items(
        app,
        s.file,
        true,
        &[&PredefinedMenuItem::close_window(app, Some(s.close_window))?],
    )?;
    let edit_menu = Submenu::with_items(
        app,
        s.edit,
        true,
        &[
            &PredefinedMenuItem::undo(app, Some(s.undo))?,
            &PredefinedMenuItem::redo(app, Some(s.redo))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some(s.cut))?,
            &PredefinedMenuItem::copy(app, Some(s.copy))?,
            &PredefinedMenuItem::paste(app, Some(s.paste))?,
            &PredefinedMenuItem::select_all(app, Some(s.select_all))?,
        ],
    )?;
    let view_menu = Submenu::with_items(
        app,
        s.view,
        true,
        &[&PredefinedMenuItem::fullscreen(app, Some(s.fullscreen))?],
    )?;
    let window_menu = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        s.window,
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some(s.minimize))?,
            &PredefinedMenuItem::maximize(app, Some(s.zoom))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, Some(s.close_window))?,
        ],
    )?;
    let help_menu = Submenu::with_id_and_items(app, HELP_SUBMENU_ID, s.help, true, &[])?;

    Menu::with_items(
        app,
        &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu, &help_menu],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_korean_only_for_ko_locales() {
        assert_eq!(lang_from_locale(Some("ko-KR")), Lang::Ko);
        assert_eq!(lang_from_locale(Some("ko")), Lang::Ko);
        assert_eq!(lang_from_locale(Some("KO_kr")), Lang::Ko);
        assert_eq!(lang_from_locale(Some("en-US")), Lang::En);
        assert_eq!(lang_from_locale(Some("ja-JP")), Lang::En);
        assert_eq!(lang_from_locale(None), Lang::En);
    }
}
