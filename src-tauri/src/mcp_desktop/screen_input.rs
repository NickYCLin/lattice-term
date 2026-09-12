//! Discrete input actions: every press has a matching release in the same
//! bounded batch. Coordinates are unscaled pixels from a captured frame.
use super::ServiceError;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ScreenAction {
    Click {
        x: u16,
        y: u16,
        button: u8,
    },
    Move {
        x: u16,
        y: u16,
    },
    Drag {
        x: u16,
        y: u16,
        to_x: u16,
        to_y: u16,
        button: u8,
    },
    Scroll {
        x: u16,
        y: u16,
        horizontal: bool,
        units: i16,
    },
    Keys {
        keys: Vec<String>,
    },
    Text {
        text: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InputEvent {
    Move(u16, u16),
    Button(u8, bool),
    Wheel(bool, i16),
    Key {
        scancode: u16,
        keysym: u32,
        pressed: bool,
    },
    Character(char, bool),
    ReleaseAll,
}

impl ScreenAction {
    pub fn events(&self, width: u32, height: u32) -> Result<Vec<InputEvent>, ServiceError> {
        let coordinate = |x: u16, y: u16| {
            if u32::from(x) < width && u32::from(y) < height {
                Ok(())
            } else {
                Err(ServiceError::invalid())
            }
        };
        let button = |button: u8| {
            if button <= 2 {
                Ok(())
            } else {
                Err(ServiceError::invalid())
            }
        };
        let mut events = Vec::new();
        match self {
            Self::Click { x, y, button: b } => {
                coordinate(*x, *y)?;
                button(*b)?;
                events.extend([
                    InputEvent::Move(*x, *y),
                    InputEvent::Button(*b, true),
                    InputEvent::Button(*b, false),
                ]);
            }
            Self::Move { x, y } => {
                coordinate(*x, *y)?;
                events.push(InputEvent::Move(*x, *y));
            }
            Self::Drag {
                x,
                y,
                to_x,
                to_y,
                button: b,
            } => {
                coordinate(*x, *y)?;
                coordinate(*to_x, *to_y)?;
                button(*b)?;
                events.extend([
                    InputEvent::Move(*x, *y),
                    InputEvent::Button(*b, true),
                    InputEvent::Move(*to_x, *to_y),
                    InputEvent::Button(*b, false),
                ]);
            }
            Self::Scroll {
                x,
                y,
                horizontal,
                units,
            } => {
                coordinate(*x, *y)?;
                if *units == 0 || !(-8..=8).contains(units) {
                    return Err(ServiceError::invalid());
                }
                events.extend([
                    InputEvent::Move(*x, *y),
                    InputEvent::Wheel(*horizontal, *units),
                ]);
            }
            Self::Keys { keys } => {
                if keys.is_empty() || keys.len() > 8 {
                    return Err(ServiceError::invalid());
                }
                let mut seen = std::collections::HashSet::new();
                let mapped: Vec<_> = keys
                    .iter()
                    .map(|name| {
                        if !seen.insert(name) {
                            return Err(ServiceError::invalid());
                        }
                        key(name).ok_or_else(ServiceError::invalid)
                    })
                    .collect::<Result<_, _>>()?;
                for (scancode, keysym) in &mapped {
                    events.push(InputEvent::Key {
                        scancode: *scancode,
                        keysym: *keysym,
                        pressed: true,
                    });
                }
                for (scancode, keysym) in mapped.into_iter().rev() {
                    events.push(InputEvent::Key {
                        scancode,
                        keysym,
                        pressed: false,
                    });
                }
            }
            Self::Text { text } => {
                if text.is_empty()
                    || text.chars().count() > 48
                    || text.chars().any(char::is_control)
                {
                    return Err(ServiceError::invalid());
                }
                for character in text.chars() {
                    events.extend([
                        InputEvent::Character(character, true),
                        InputEvent::Character(character, false),
                    ]);
                }
            }
        }
        events.push(InputEvent::ReleaseAll);
        Ok(events)
    }
}

// PC/AT Set 1 (extended keys include 0x100) and X11 keysyms, matching the
// existing RDP and VNC/Remote viewer keyboard maps.
fn key(name: &str) -> Option<(u16, u32)> {
    Some(match name {
        "Control" => (0x1d, 0xffe3),
        "Shift" => (0x2a, 0xffe1),
        "Alt" => (0x38, 0xffe9),
        "Meta" => (0x15b, 0xffeb),
        "Enter" => (0x1c, 0xff0d),
        "Escape" => (0x01, 0xff1b),
        "Tab" => (0x0f, 0xff09),
        "Backspace" => (0x0e, 0xff08),
        "Delete" => (0x153, 0xffff),
        "Insert" => (0x152, 0xff63),
        "Home" => (0x147, 0xff50),
        "End" => (0x14f, 0xff57),
        "PageUp" => (0x149, 0xff55),
        "PageDown" => (0x151, 0xff56),
        "ArrowLeft" => (0x14b, 0xff51),
        "ArrowRight" => (0x14d, 0xff53),
        "ArrowUp" => (0x148, 0xff52),
        "ArrowDown" => (0x150, 0xff54),
        "Space" => (0x39, 0x20),
        other => {
            if let Some(number) = other
                .strip_prefix('F')
                .and_then(|value| value.parse::<u16>().ok())
                .filter(|value| (1..=12).contains(value))
            {
                return Some((
                    if number <= 10 {
                        0x3a + number
                    } else {
                        0x57 + number - 11
                    },
                    0xffbd + u32::from(number),
                ));
            }
            if other.len() != 1 {
                return None;
            }
            let character = other.as_bytes()[0];
            let letters = b"abcdefghijklmnopqrstuvwxyz";
            let codes = [
                0x1e, 0x30, 0x2e, 0x20, 0x12, 0x21, 0x22, 0x23, 0x17, 0x24, 0x25, 0x26, 0x32, 0x31,
                0x18, 0x19, 0x10, 0x13, 0x1f, 0x14, 0x16, 0x2f, 0x11, 0x2d, 0x15, 0x2c,
            ];
            if let Some(index) = letters.iter().position(|letter| *letter == character) {
                return Some((codes[index], u32::from(character)));
            }
            if character.is_ascii_digit() {
                return Some((
                    if character == b'0' {
                        0x0b
                    } else {
                        u16::from(character - b'1') + 2
                    },
                    u32::from(character),
                ));
            }
            return None;
        }
    })
}

impl InputEvent {
    pub fn rdp(&self) -> crate::rdp::RdpInputRequest {
        use crate::rdp::RdpInputRequest as R;
        match *self {
            Self::Move(x, y) => R::MouseMove { x, y },
            Self::Button(button, pressed) => R::MouseButton { button, pressed },
            Self::Wheel(horizontal, units) => R::Wheel { horizontal, units },
            Self::Key {
                scancode, pressed, ..
            } => R::Key { scancode, pressed },
            Self::Character(character, pressed) => R::Unicode { character, pressed },
            Self::ReleaseAll => R::ReleaseAll,
        }
    }
    pub fn vnc(&self) -> crate::vnc::VncInputRequest {
        use crate::vnc::VncInputRequest as V;
        match *self {
            Self::Move(x, y) => V::MouseMove { x, y },
            Self::Button(button, pressed) => V::MouseButton { button, pressed },
            Self::Wheel(horizontal, units) => V::Wheel { horizontal, units },
            Self::Key {
                keysym, pressed, ..
            } => V::Key { keysym, pressed },
            Self::Character(character, pressed) => V::Key {
                keysym: unicode_keysym(character),
                pressed,
            },
            Self::ReleaseAll => V::ReleaseAll,
        }
    }
    pub fn remote(&self) -> crate::remote::RemoteInputRequest {
        use crate::remote::RemoteInputRequest as R;
        match self.vnc() {
            crate::vnc::VncInputRequest::MouseMove { x, y } => R::MouseMove { x, y },
            crate::vnc::VncInputRequest::MouseButton { button, pressed } => {
                R::MouseButton { button, pressed }
            }
            crate::vnc::VncInputRequest::Wheel { horizontal, units } => R::Wheel {
                horizontal,
                units: i32::from(units),
            },
            crate::vnc::VncInputRequest::Key { keysym, pressed } => R::Key { keysym, pressed },
            crate::vnc::VncInputRequest::ReleaseAll => R::ReleaseAll,
        }
    }
}
fn unicode_keysym(character: char) -> u32 {
    let value = u32::from(character);
    if value <= 0xff {
        value
    } else {
        0x01000000 + value
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn chords_release_in_reverse_order_and_unicode_never_becomes_control_input() {
        let events = ScreenAction::Keys {
            keys: vec!["Control".into(), "a".into()],
        }
        .events(100, 100)
        .unwrap();
        assert!(matches!(
            events[0],
            InputEvent::Key {
                scancode: 0x1d,
                pressed: true,
                ..
            }
        ));
        assert!(matches!(
            events[2],
            InputEvent::Key {
                scancode: 0x1e,
                pressed: false,
                ..
            }
        ));
        assert_eq!(events.last(), Some(&InputEvent::ReleaseAll));
        assert_eq!(unicode_keysym('中'), 0x01004e2d);
        assert!(ScreenAction::Text {
            text: "\u{1b}".into()
        }
        .events(10, 10)
        .is_err());
    }
    #[test]
    fn coordinates_buttons_and_batches_are_bounded() {
        assert!(ScreenAction::Click {
            x: 100,
            y: 0,
            button: 0
        }
        .events(100, 100)
        .is_err());
        assert!(ScreenAction::Click {
            x: 1,
            y: 0,
            button: 3
        }
        .events(100, 100)
        .is_err());
        assert!(ScreenAction::Text {
            text: "x".repeat(49)
        }
        .events(100, 100)
        .is_err());
        assert!(ScreenAction::Keys {
            keys: vec!["Control".into(), "Control".into()]
        }
        .events(100, 100)
        .is_err());
        assert!(ScreenAction::Keys {
            keys: vec!["arbitrary".into()]
        }
        .events(100, 100)
        .is_err());
    }
}

#[cfg(test)]
mod service_tests {
    use super::*;
    use crate::mcp_desktop::*;
    use crate::mcp_screen::{ScreenBackend, ScreenKey};
    use std::sync::Arc;
    use tokio::io::AsyncReadExt;

    async fn setup() -> (
        Arc<DesktopService>,
        TargetView,
        ScreenKey,
        tokio::io::DuplexStream,
    ) {
        let service = Arc::new(DesktopService::new(
            Arc::new(crate::ssh::SshRegistry::new()),
            Arc::new(crate::sftp::SftpRegistry::new()),
        ));
        let reader = service.vnc.insert_mcp_test_session("screen-test", 1);
        let target = service
            .grant(GrantRequest {
                fleet: None,
                session_id: "screen-test".into(),
                backend: Backend::Vnc,
                label: "test".into(),
                scopes: Scopes {
                    screen: true,
                    input: true,
                    ..Scopes::default()
                },
                exec_plans: vec![],
                roots: vec![],
            })
            .await
            .unwrap();
        let key = ScreenKey::new(ScreenBackend::Vnc, "screen-test", 1);
        service.screens.offer(&key, 1, 100, 100, "image/jpeg", &[7]);
        (service, target, key, reader)
    }

    async fn capture(service: &Arc<DesktopService>, target: &TargetView) -> serde_json::Value {
        service.state.lock().unwrap().captures.clear();
        service
            .execute(
                "test-client",
                DesktopOperation::CaptureScreen {
                    target_id: target.id.clone(),
                },
            )
            .await
            .unwrap()
    }
    fn click(target: &TargetView, capture: &serde_json::Value, request: &str) -> DesktopOperation {
        DesktopOperation::ScreenInput {
            target_id: target.id.clone(),
            snapshot_id: capture["snapshotId"].as_str().unwrap().into(),
            frame_id: capture["frameId"].as_u64().unwrap(),
            action: ScreenAction::Click {
                x: 20,
                y: 30,
                button: 0,
            },
            request_id: request.into(),
        }
    }

    #[tokio::test]
    async fn capture_receipts_are_client_bound_single_use_and_retries_do_not_click_twice() {
        let (service, target, _, mut reader) = setup().await;
        let shot = capture(&service, &target).await;
        let operation = click(&target, &shot, "once");
        assert_eq!(
            service
                .execute("other-client", operation.clone())
                .await
                .unwrap_err()
                .code,
            "not_ready"
        );
        assert_eq!(
            service
                .execute("test-client", operation.clone())
                .await
                .unwrap()["submitted"],
            true
        );
        let replay = service.execute("test-client", operation).await.unwrap();
        assert_eq!(replay["duplicate"], true);
        assert_eq!(
            service
                .execute("test-client", click(&target, &shot, "new-id"))
                .await
                .unwrap_err()
                .code,
            "not_ready"
        );
        let mut bytes = [0; 4096];
        let count = reader.read(&mut bytes).await.unwrap();
        let lines: Vec<serde_json::Value> = std::str::from_utf8(&bytes[..count])
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(lines.len(), 4);
        assert_eq!(lines[0]["x"], 20);
        assert_eq!(lines[1]["pressed"], true);
        assert_eq!(lines[2]["pressed"], false);
        assert_eq!(lines[3]["kind"], "releaseAll");
    }

    #[tokio::test]
    async fn changed_pixels_expiry_takeover_and_reconnection_reject_input() {
        let (service, target, key, _) = setup().await;
        let shot = capture(&service, &target).await;
        service.screens.offer(&key, 2, 100, 100, "image/jpeg", &[8]);
        assert_eq!(
            service
                .execute("test-client", click(&target, &shot, "changed"))
                .await
                .unwrap_err()
                .code,
            "not_ready"
        );
        let shot = capture(&service, &target).await;
        service
            .state
            .lock()
            .unwrap()
            .screen_receipts
            .values_mut()
            .for_each(|receipt| receipt.issued -= std::time::Duration::from_secs(11));
        assert_eq!(
            service
                .execute("test-client", click(&target, &shot, "expired"))
                .await
                .unwrap_err()
                .code,
            "not_ready"
        );
        let shot = capture(&service, &target).await;
        service.take_over_screen(Backend::Vnc, "screen-test");
        assert_eq!(
            service
                .execute("test-client", click(&target, &shot, "takeover"))
                .await
                .unwrap_err()
                .code,
            "not_authorized"
        );
        assert!(!service.screens.is_armed(&key));
        let (service, target, _, _) = setup().await;
        let shot = capture(&service, &target).await;
        let _reader = service.vnc.insert_mcp_test_session("screen-test", 2);
        assert_eq!(
            service
                .execute("test-client", click(&target, &shot, "reconnected"))
                .await
                .unwrap_err()
                .code,
            "needs_user_action"
        );
    }

    #[tokio::test]
    async fn input_requires_its_own_scope_and_refused_grants_never_arm_retention() {
        let (service, target, key, _) = setup().await;
        service.revoke(&target.id).unwrap();
        let request = GrantRequest {
            fleet: None,
            session_id: "screen-test".into(),
            backend: Backend::Vnc,
            label: "view".into(),
            scopes: Scopes {
                screen: true,
                ..Scopes::default()
            },
            exec_plans: vec![],
            roots: vec![],
        };
        let view = service.grant(request.clone()).await.unwrap();
        service.screens.offer(&key, 1, 100, 100, "image/jpeg", &[7]);
        let shot = capture(&service, &view).await;
        assert!(shot["snapshotId"].is_null());
        let mut operation = click(
            &target,
            &serde_json::json!({"snapshotId":"fake","frameId":1}),
            "no-scope",
        );
        if let DesktopOperation::ScreenInput { target_id, .. } = &mut operation {
            *target_id = view.id.clone();
        }
        assert_eq!(
            service
                .execute("test-client", operation)
                .await
                .unwrap_err()
                .code,
            "not_authorized"
        );
        service.revoke(&view.id).unwrap();
        for _ in 0..super::super::MAX_GRANTS {
            service.grant(request.clone()).await.unwrap();
        }
        service.screens.disarm(&key);
        assert_eq!(service.grant(request).await.unwrap_err().code, "capacity");
        assert!(!service.screens.is_armed(&key));
    }
}
