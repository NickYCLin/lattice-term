//! macOS Quit must request a window close instead of calling NSApp terminate:.
//!
//! Keep these public Tauri APIs type-checked on every desktop platform. Only
//! macOS installs the replacement menu; no Objective-C hooks are introduced.

use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem};
use tauri::{AppHandle, Manager, Runtime};

const GUARDED_QUIT_ID: &str = "latticeterm-guarded-quit";

/// Match only a predefined item, using a label produced by the same Tauri
/// constructor as Menu::default. Never rely on generated menu IDs, a submenu
/// position, or an English/app-name string assembled by this application.
fn unique_quit_location(
    labels: &[Vec<Option<String>>],
    expected_label: &str,
) -> Result<(usize, usize), &'static str> {
    let mut matches = labels.iter().enumerate().flat_map(|(submenu, items)| {
        items.iter().enumerate().filter_map(move |(item, label)| {
            (label.as_deref() == Some(expected_label)).then_some((submenu, item))
        })
    });
    let location = matches
        .next()
        .ok_or("The default application Quit menu item was not found.")?;
    if matches.next().is_some() {
        return Err("The default application Quit menu item is ambiguous.");
    }
    Ok(location)
}

pub fn install_guarded_quit<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<(), Box<dyn std::error::Error>> {
    let menu = Menu::default(app)?;
    // In the locked Tauri/muda version both Menu::default and this probe use
    // PredefinedMenuItem::quit(None), including NSRunningApplication's name.
    // The probe is never attached to a native menu.
    let quit_label = PredefinedMenuItem::quit(app, None)?.text()?;
    let submenus: Vec<_> = menu
        .items()?
        .into_iter()
        .filter_map(|item| match item {
            MenuItemKind::Submenu(submenu) => Some(submenu),
            _ => None,
        })
        .collect();
    let mut labels = Vec::with_capacity(submenus.len());
    for submenu in &submenus {
        let mut items = Vec::new();
        for item in submenu.items()? {
            items.push(match item {
                MenuItemKind::Predefined(predefined) => Some(predefined.text()?),
                _ => None,
            });
        }
        labels.push(items);
    }
    let (submenu_index, item_index) =
        unique_quit_location(&labels, &quit_label).map_err(std::io::Error::other)?;
    let guarded_quit =
        MenuItem::with_id(app, GUARDED_QUIT_ID, quit_label, true, Some("CmdOrCtrl+Q"))?;
    let submenu = &submenus[submenu_index];
    submenu
        .remove_at(item_index)?
        .ok_or_else(|| std::io::Error::other("The default Quit item changed while installing."))?;
    submenu.insert(&guarded_quit, item_index)?;

    app.on_menu_event(|app, event| {
        if event.id() == GUARDED_QUIT_ID {
            if let Some(window) = app.get_webview_window("main") {
                // The editor may cancel this close. Do not seal the clipboard,
                // destroy the window or fall back to app.exit on failure.
                // An allowed last-window close reaches the existing
                // ExitRequested clipboard cleanup without a second pathway.
                let _ = window.close();
            }
        }
    });
    app.set_menu(menu)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::unique_quit_location;

    fn label(value: &str) -> Option<String> {
        Some(value.to_owned())
    }

    #[test]
    fn finds_quit_without_assuming_app_name_language_or_menu_position() {
        let entries = vec![
            vec![label("Close window"), None],
            vec![label("About My App"), None, label("結束 我的應用程式")],
        ];
        assert_eq!(
            unique_quit_location(&entries, "結束 我的應用程式"),
            Ok((1, 2))
        );
        assert_eq!(entries[0][0].as_deref(), Some("Close window"));
        assert_eq!(entries[1][0].as_deref(), Some("About My App"));
    }

    #[test]
    fn does_not_treat_a_custom_item_or_missing_quit_as_the_native_quit() {
        assert!(unique_quit_location(&[vec![None, label("Services")]], "Quit").is_err());
        assert!(unique_quit_location(&[], "Quit").is_err());
    }

    #[test]
    fn rejects_ambiguous_default_menus_instead_of_leaving_an_unguarded_quit() {
        assert!(unique_quit_location(&[vec![label("Quit"), label("Quit")]], "Quit").is_err());
        assert!(unique_quit_location(&[vec![label("Quit")], vec![label("Quit")]], "Quit").is_err());
    }
}
