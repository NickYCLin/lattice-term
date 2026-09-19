//! System notifications for chat replies that finished while the window was
//! in the background, and the way back to that conversation.
//!
//! On Linux the notification is sent straight over D-Bus with a default
//! action, so clicking it focuses LatticeTerm and opens the conversation.
//! On macOS and Windows the notification plugin shows it; clicking there
//! brings the app forward the way the system does for any notification.

use tauri::{AppHandle, Emitter, Manager};

/// Emitted with the conversation id when a notification was clicked.
pub const EVENT_OPEN: &str = "chat-notification-open";
const MAX_TITLE_CHARS: usize = 80;
const MAX_BODY_CHARS: usize = 200;

/// Notification text is shown by another program; control characters and
/// markup would only confuse it.
pub fn clean(text: &str, limit: usize) -> String {
    let flat: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let flat = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out: String = flat.chars().take(limit).collect();
    if flat.chars().count() > limit {
        out.push('…');
    }
    out
}

/// The freedesktop body may contain simple markup; plain text must not.
#[cfg(any(target_os = "linux", test))]
fn escape_markup(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn open_conversation(app: &AppHandle, thread_id: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    let _ = app.emit(EVENT_OPEN, thread_id.to_string());
}

pub fn show(app: &AppHandle, thread_id: &str, title: &str, body: &str) -> Result<(), String> {
    let title = clean(title, MAX_TITLE_CHARS);
    let body = clean(body, MAX_BODY_CHARS);
    platform::show(app.clone(), thread_id.to_string(), title, body)
}

#[cfg(target_os = "linux")]
mod platform {
    use super::open_conversation;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tauri::AppHandle;
    use zbus::zvariant::Value;

    /// Waiting threads for clicks; beyond this, notifications still show but
    /// nobody listens for their click.
    const MAX_LISTENERS: usize = 8;
    static LISTENERS: AtomicUsize = AtomicUsize::new(0);

    pub fn show(
        app: AppHandle,
        thread_id: String,
        title: String,
        body: String,
    ) -> Result<(), String> {
        std::thread::Builder::new()
            .name("latticeterm-notification".into())
            .spawn(move || {
                let connection = match zbus::blocking::Connection::session() {
                    Ok(connection) => connection,
                    Err(_) => return,
                };
                let _ = notify(&connection, &title, &body, move || {
                    open_conversation(&app, &thread_id)
                });
            })
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    /// Keeps the listener count right however `notify` returns.
    struct Listening(bool);

    impl Drop for Listening {
        fn drop(&mut self) {
            if self.0 {
                LISTENERS.fetch_sub(1, Ordering::AcqRel);
            }
        }
    }

    /// Shows one notification and, while listener slots last, waits for it
    /// to be clicked (running `on_click`) or closed.
    pub(super) fn notify(
        connection: &zbus::blocking::Connection,
        title: &str,
        body: &str,
        on_click: impl FnOnce(),
    ) -> zbus::Result<()> {
        let body = super::escape_markup(body);
        let proxy = zbus::blocking::Proxy::new(
            connection,
            "org.freedesktop.Notifications",
            "/org/freedesktop/Notifications",
            "org.freedesktop.Notifications",
        )?;
        let listening = Listening(LISTENERS.fetch_add(1, Ordering::AcqRel) < MAX_LISTENERS);
        if !listening.0 {
            LISTENERS.fetch_sub(1, Ordering::AcqRel);
        }
        let signals = if listening.0 {
            Some(proxy.receive_all_signals()?)
        } else {
            None
        };
        let mut hints: HashMap<&str, Value> = HashMap::new();
        // The installed launcher is LatticeTerm.desktop; the server uses it for the icon.
        hints.insert("desktop-entry", Value::from("LatticeTerm"));
        let actions: Vec<&str> = vec!["default", "Open"];
        let id: u32 = proxy.call(
            "Notify",
            &(
                "LatticeTerm",
                0u32,
                "",
                title,
                body.as_str(),
                actions,
                hints,
                -1i32,
            ),
        )?;
        if let Some(signals) = signals {
            for message in signals {
                let header = message.header();
                match header.member().map(|member| member.as_str()) {
                    Some("ActionInvoked") => {
                        if let Ok((notification, _action)) =
                            message.body().deserialize::<(u32, String)>()
                        {
                            if notification == id {
                                on_click();
                                break;
                            }
                        }
                    }
                    Some("NotificationClosed") => {
                        if let Ok((notification, _reason)) =
                            message.body().deserialize::<(u32, u32)>()
                        {
                            if notification == id {
                                break;
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        Ok(())
    }
}

#[cfg(any(target_os = "macos", windows))]
mod platform {
    use tauri::AppHandle;
    use tauri_plugin_notification::NotificationExt;

    pub fn show(
        app: AppHandle,
        _thread_id: String,
        title: String,
        body: String,
    ) -> Result<(), String> {
        app.notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|error| error.to_string())
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
mod platform {
    use tauri::AppHandle;

    pub fn show(
        _app: AppHandle,
        _thread_id: String,
        _title: String,
        _body: String,
    ) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(all(test, target_os = "linux"))]
mod dbus_tests {
    use std::collections::HashMap;
    use std::sync::mpsc;
    use std::time::Duration;
    use zbus::object_server::SignalEmitter;
    use zbus::zvariant::OwnedValue;

    struct FakeServer {
        seen: mpsc::Sender<(String, String, Vec<String>)>,
    }

    #[zbus::interface(name = "org.freedesktop.Notifications")]
    impl FakeServer {
        #[allow(clippy::too_many_arguments)]
        fn notify(
            &self,
            _app: &str,
            _replaces: u32,
            _icon: &str,
            summary: &str,
            body: &str,
            actions: Vec<String>,
            _hints: HashMap<String, OwnedValue>,
            _timeout: i32,
        ) -> u32 {
            let _ = self.seen.send((summary.into(), body.into(), actions));
            42
        }

        #[zbus(signal)]
        async fn action_invoked(
            emitter: &SignalEmitter<'_>,
            id: u32,
            key: &str,
        ) -> zbus::Result<()>;
    }

    /// Needs a session bus: `dbus-run-session -- cargo test --lib
    /// desktop_notification -- --ignored`.
    #[test]
    #[ignore]
    fn clicking_the_notification_runs_the_open_action() {
        let (seen_tx, seen_rx) = mpsc::channel();
        let server = zbus::blocking::connection::Builder::session()
            .unwrap()
            .name("org.freedesktop.Notifications")
            .unwrap()
            .serve_at(
                "/org/freedesktop/Notifications",
                FakeServer { seen: seen_tx },
            )
            .unwrap()
            .build()
            .unwrap();
        let (clicked_tx, clicked_rx) = mpsc::channel();
        let client = std::thread::spawn(move || {
            let connection = zbus::blocking::Connection::session().unwrap();
            super::platform::notify(&connection, "Plan", "a <b> & c", move || {
                clicked_tx.send(()).unwrap();
            })
            .unwrap();
        });
        let (summary, body, actions) = seen_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(summary, "Plan");
        assert_eq!(body, "a &lt;b&gt; &amp; c");
        assert_eq!(actions[0], "default");
        let emitter = SignalEmitter::new(server.inner(), "/org/freedesktop/Notifications").unwrap();
        // A click on some other notification must not open this one.
        zbus::block_on(FakeServer::action_invoked(&emitter, 7, "default")).unwrap();
        zbus::block_on(FakeServer::action_invoked(&emitter, 42, "default")).unwrap();
        clicked_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        client.join().unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::{clean, escape_markup};

    #[test]
    fn notification_text_is_flat_short_and_escaped() {
        assert_eq!(clean("a\nb\t c", 80), "a b c");
        assert_eq!(clean("<b>x</b> & y", 80), "<b>x</b> & y");
        assert_eq!(
            escape_markup("<b>x</b> & y"),
            "&lt;b&gt;x&lt;/b&gt; &amp; y"
        );
        assert_eq!(clean("abcdef", 3), "abc…");
    }
}
