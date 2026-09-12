//! Local input injection for a Lattice Remote agent that is sharing with
//! control enabled.
//!
//! This module only exists under the `agent` feature and only runs when the
//! operator explicitly started sharing with `--allow-input`. The viewer sends
//! coordinates in the agent's advertised stream space; we scale them back onto
//! the real display before handing them to the OS. Every button and key we
//! press is tracked so a dropped connection or an explicit ReleaseAll leaves
//! nothing stuck down.

use crate::{PointerButton, RemoteInput};
use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};

/// Translates one viewer input stream onto the local machine.
pub struct InputInjector {
    enigo: Enigo,
    scale_x: f64,
    scale_y: f64,
    pressed_buttons: Vec<Button>,
    pressed_keys: Vec<Key>,
}

impl InputInjector {
    /// `stream_*` is the size the agent advertised in its Hello; `display_*`
    /// is the real captured display. Their ratio maps a click back to a pixel.
    pub fn new(
        stream_width: u32,
        stream_height: u32,
        _display_width: u32,
        _display_height: u32,
    ) -> Result<Self, String> {
        let enigo = Enigo::new(&Settings::default()).map_err(|error| error.to_string())?;
        // Windows normalizes absolute pointer input using GetSystemMetrics.
        // Those dimensions may be DPI-virtualized; captured pixels are physical.
        #[cfg(windows)]
        let (display_width, display_height) = {
            let (width, height) = enigo.main_display().map_err(|error| error.to_string())?;
            if width <= 0 || height <= 0 {
                return Err("The input display dimensions are unavailable.".into());
            }
            (width as u32, height as u32)
        };
        #[cfg(not(windows))]
        let (display_width, display_height) = (_display_width, _display_height);
        Ok(Self {
            enigo,
            scale_x: ratio(display_width, stream_width),
            scale_y: ratio(display_height, stream_height),
            pressed_buttons: Vec::new(),
            pressed_keys: Vec::new(),
        })
    }

    pub fn apply(&mut self, input: RemoteInput) -> Result<(), String> {
        match input {
            RemoteInput::MouseMove { x, y } => {
                let (px, py) = self.to_display(x, y);
                self.enigo
                    .move_mouse(px, py, Coordinate::Abs)
                    .map_err(|error| error.to_string())
            }
            RemoteInput::MouseButton { button, pressed } => {
                let button = map_button(button);
                if pressed {
                    self.track_button(button);
                    self.enigo.button(button, Direction::Press)
                } else {
                    self.untrack_button(button);
                    self.enigo.button(button, Direction::Release)
                }
                .map_err(|error| error.to_string())
            }
            RemoteInput::Wheel { horizontal, units } => {
                let axis = if horizontal {
                    Axis::Horizontal
                } else {
                    Axis::Vertical
                };
                self.enigo
                    .scroll(i32::from(units), axis)
                    .map_err(|error| error.to_string())
            }
            RemoteInput::Key { keysym, pressed } => {
                let Some(key) = map_keysym(keysym) else {
                    // Unmappable keys are ignored rather than failing the stream.
                    return Ok(());
                };
                #[cfg(windows)]
                match windows_unicode_input(key, pressed, &self.pressed_keys) {
                    UnicodeInput::Text(character) => {
                        return self
                            .enigo
                            .text(&character.to_string())
                            .map_err(|error| error.to_string());
                    }
                    UnicodeInput::IgnoreRelease => return Ok(()),
                    UnicodeInput::Physical => {}
                }
                if pressed {
                    self.track_key(key);
                    self.enigo.key(key, Direction::Press)
                } else {
                    self.untrack_key(key);
                    self.enigo.key(key, Direction::Release)
                }
                .map_err(|error| error.to_string())
            }
            RemoteInput::ReleaseAll => {
                self.release_all();
                Ok(())
            }
        }
    }

    /// Lifts everything still held. Called on ReleaseAll and on shutdown so a
    /// disconnect never leaves a button or modifier stuck down on the host.
    pub fn release_all(&mut self) {
        for button in self.pressed_buttons.drain(..) {
            let _ = self.enigo.button(button, Direction::Release);
        }
        for key in self.pressed_keys.drain(..) {
            let _ = self.enigo.key(key, Direction::Release);
        }
    }

    fn to_display(&self, x: u16, y: u16) -> (i32, i32) {
        (
            (f64::from(x) * self.scale_x).round() as i32,
            (f64::from(y) * self.scale_y).round() as i32,
        )
    }

    fn track_button(&mut self, button: Button) {
        if !self.pressed_buttons.contains(&button) {
            self.pressed_buttons.push(button);
        }
    }

    fn untrack_button(&mut self, button: Button) {
        self.pressed_buttons.retain(|held| *held != button);
    }

    fn track_key(&mut self, key: Key) {
        if !self.pressed_keys.contains(&key) {
            self.pressed_keys.push(key);
        }
    }

    fn untrack_key(&mut self, key: Key) {
        self.pressed_keys.retain(|held| *held != key);
    }
}

impl Drop for InputInjector {
    fn drop(&mut self) {
        self.release_all();
    }
}

fn ratio(display: u32, stream: u32) -> f64 {
    if stream == 0 {
        1.0
    } else {
        f64::from(display) / f64::from(stream)
    }
}

fn map_button(button: PointerButton) -> Button {
    match button {
        PointerButton::Left => Button::Left,
        PointerButton::Middle => Button::Middle,
        PointerButton::Right => Button::Right,
    }
}

// enigo's Windows Unicode fallback emits a complete character for both Press
// and Release. Send printable text once, while keeping physical ASCII keys for
// shortcuts. A release follows the route chosen by its corresponding press,
// even if a modifier was released first.
#[cfg(any(windows, test))]
#[derive(Debug, PartialEq, Eq)]
enum UnicodeInput {
    Text(char),
    IgnoreRelease,
    Physical,
}
#[cfg(any(windows, test))]
fn windows_unicode_input(key: Key, pressed: bool, held: &[Key]) -> UnicodeInput {
    let Key::Unicode(character) = key else {
        return UnicodeInput::Physical;
    };
    if !pressed {
        return if held.contains(&key) {
            UnicodeInput::Physical
        } else {
            UnicodeInput::IgnoreRelease
        };
    }
    if character.is_ascii()
        && held
            .iter()
            .any(|key| matches!(key, Key::Control | Key::Alt | Key::Meta))
    {
        UnicodeInput::Physical
    } else {
        UnicodeInput::Text(character)
    }
}

/// Maps an X11 keysym (the encoding the browser panes already emit) onto the
/// portable `enigo::Key` set. Printable characters go through `Key::Unicode`
/// so they work identically on every OS; named keys map to their variant.
fn map_keysym(keysym: u32) -> Option<Key> {
    let named = match keysym {
        0xff08 => Key::Backspace,
        0xff09 => Key::Tab,
        0xff0d | 0xff8d => Key::Return,
        0xff1b => Key::Escape,
        0xff50 => Key::Home,
        0xff51 => Key::LeftArrow,
        0xff52 => Key::UpArrow,
        0xff53 => Key::RightArrow,
        0xff54 => Key::DownArrow,
        0xff55 => Key::PageUp,
        0xff56 => Key::PageDown,
        0xff57 => Key::End,
        // enigo exposes the same physical key as Help on macOS; Insert is
        // only available on its Linux and Windows backends.
        #[cfg(target_os = "macos")]
        0xff63 => Key::Help,
        #[cfg(not(target_os = "macos"))]
        0xff63 => Key::Insert,
        0xffff => Key::Delete,
        0xffe1 | 0xffe2 => Key::Shift,
        0xffe3 | 0xffe4 => Key::Control,
        0xffe9 | 0xffea => Key::Alt,
        0xffeb | 0xffec => Key::Meta,
        0xffe5 => Key::CapsLock,
        0x0020 => Key::Space,
        0xffbe..=0xffc9 => return u32_to_function_key(keysym),
        _ => return keysym_to_unicode(keysym).map(Key::Unicode),
    };
    Some(named)
}

fn u32_to_function_key(keysym: u32) -> Option<Key> {
    // X11 packs F1..F12 contiguously from 0xffbe; enigo names each separately.
    Some(match keysym {
        0xffbe => Key::F1,
        0xffbf => Key::F2,
        0xffc0 => Key::F3,
        0xffc1 => Key::F4,
        0xffc2 => Key::F5,
        0xffc3 => Key::F6,
        0xffc4 => Key::F7,
        0xffc5 => Key::F8,
        0xffc6 => Key::F9,
        0xffc7 => Key::F10,
        0xffc8 => Key::F11,
        0xffc9 => Key::F12,
        _ => return None,
    })
}

fn keysym_to_unicode(keysym: u32) -> Option<char> {
    // Latin-1 keysyms are their code points; the Unicode range is offset.
    let code_point = if (0x20..=0xff).contains(&keysym) {
        keysym
    } else if (0x0100_0000..=0x0110_ffff).contains(&keysym) {
        keysym - 0x0100_0000
    } else {
        return None;
    };
    char::from_u32(code_point).filter(|character| !character.is_control())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_named_and_printable_keysyms() {
        assert!(matches!(map_keysym(0xff0d), Some(Key::Return)));
        assert!(matches!(map_keysym(0xff52), Some(Key::UpArrow)));
        assert!(matches!(map_keysym(0xffc1), Some(Key::F4)));
        assert!(matches!(map_keysym(0x0061), Some(Key::Unicode('a'))));
        assert!(matches!(
            map_keysym(0x0100_0000 + 0x4e2d),
            Some(Key::Unicode('中')),
        ));
    }

    #[test]
    fn maps_insert_to_the_platform_equivalent() {
        #[cfg(target_os = "macos")]
        assert!(matches!(map_keysym(0xff63), Some(Key::Help)));
        #[cfg(not(target_os = "macos"))]
        assert!(matches!(map_keysym(0xff63), Some(Key::Insert)));
    }

    #[test]
    fn drops_unmappable_and_control_keysyms() {
        assert!(map_keysym(0x0000).is_none());
        assert!(map_keysym(0x0009).is_none()); // raw tab control char, not the Tab keysym
    }

    #[test]
    fn windows_unicode_is_emitted_once_and_shortcut_releases_stay_physical() {
        for character in ['R', '中', '🦀'] {
            assert_eq!(
                windows_unicode_input(Key::Unicode(character), true, &[]),
                UnicodeInput::Text(character)
            );
            assert_eq!(
                windows_unicode_input(Key::Unicode(character), false, &[]),
                UnicodeInput::IgnoreRelease
            );
        }
        assert_eq!(
            windows_unicode_input(Key::Unicode('A'), true, &[Key::Shift]),
            UnicodeInput::Text('A')
        );
        assert_eq!(
            windows_unicode_input(Key::Unicode('a'), true, &[Key::Control]),
            UnicodeInput::Physical
        );
        assert_eq!(
            windows_unicode_input(Key::Unicode('a'), false, &[Key::Unicode('a')]),
            UnicodeInput::Physical
        );
        assert_eq!(
            windows_unicode_input(Key::Unicode('a'), false, &[Key::Control]),
            UnicodeInput::IgnoreRelease
        );
        assert_eq!(
            windows_unicode_input(Key::Return, false, &[Key::Return]),
            UnicodeInput::Physical
        );
    }

    #[test]
    fn scales_stream_coordinates_onto_the_display() {
        // Reuse the pure math without constructing a real Enigo backend.
        let scale_x = ratio(1920, 1280);
        let scale_y = ratio(1080, 720);
        assert_eq!((640.0 * scale_x).round() as i32, 960);
        assert_eq!((360.0 * scale_y).round() as i32, 540);
        assert_eq!(ratio(1920, 0), 1.0);
    }
}
