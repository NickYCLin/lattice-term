//! Isolated native VNC engine for LatticeTerm.
//!
//! Speaks the same line-oriented JSON protocol as the RDP engine: commands in
//! on stdin, events out on stdout, one JSON object per line. The password is
//! read once from the connect command and never echoed into any event.
//!
//! The engine keeps the whole framebuffer, applies the server's rectangle
//! updates to it, and ships throttled JPEG frames of the composited screen —
//! the WebView never sees VNC wire formats.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use image::codecs::jpeg::JpegEncoder;
use image::ExtendedColorType;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader, Lines, Stdin, Stdout};
use tokio::net::TcpStream;
use vnc::{ClientKeyEvent, ClientMouseEvent, PixelFormat, VncConnector, VncEvent, X11Event};

/// How often, at most, a fresh composited frame goes out.
const FRAME_INTERVAL: Duration = Duration::from_millis(66);
/// Bounds allocations requested by an untrusted VNC server. This permits 4K,
/// 5K ultrawide, and other large desktops while keeping one RGBA framebuffer
/// at or below 64 MiB.
const MAX_FRAMEBUFFER_PIXELS: usize = 16 * 1024 * 1024;
/// VNC pointer button bits, per RFC 6143 §7.5.5.
const BUTTON_LEFT: u8 = 1 << 0;
const BUTTON_MIDDLE: u8 = 1 << 1;
const BUTTON_RIGHT: u8 = 1 << 2;
const WHEEL_UP: u8 = 1 << 3;
const WHEEL_DOWN: u8 = 1 << 4;
const WHEEL_LEFT: u8 = 1 << 5;
const WHEEL_RIGHT: u8 = 1 << 6;

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Command {
    Connect {
        hostname: String,
        port: u16,
        password: String,
    },
    MouseMove {
        x: u16,
        y: u16,
    },
    MouseButton {
        button: u8,
        pressed: bool,
    },
    Wheel {
        horizontal: bool,
        units: i16,
    },
    Key {
        keysym: u32,
        pressed: bool,
    },
    ReleaseAll,
    Close,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Event {
    Connected {
        width: u16,
        height: u16,
    },
    Frame {
        frame_id: u64,
        width: u16,
        height: u16,
        mime_type: &'static str,
        base64: String,
    },
    AuthFailed,
    Failed {
        stage: &'static str,
        detail: String,
    },
    Closed {
        reason: String,
    },
}

/// The composited screen, always RGBA in server-resolution.
struct Framebuffer {
    width: u16,
    height: u16,
    pixels: Vec<u8>,
    dirty: bool,
}

impl Framebuffer {
    fn new() -> Self {
        Self {
            width: 0,
            height: 0,
            pixels: Vec::new(),
            dirty: false,
        }
    }

    fn resize(&mut self, width: u16, height: u16) -> Result<(), String> {
        let pixel_count = usize::from(width)
            .checked_mul(usize::from(height))
            .filter(|count| *count > 0 && *count <= MAX_FRAMEBUFFER_PIXELS)
            .ok_or_else(|| {
                format!(
                    "VNC framebuffer {width}x{height} exceeds the safety limit of {MAX_FRAMEBUFFER_PIXELS} pixels."
                )
            })?;
        let byte_count = pixel_count
            .checked_mul(4)
            .ok_or_else(|| "VNC framebuffer byte size overflowed.".to_string())?;
        let mut pixels = Vec::new();
        pixels
            .try_reserve_exact(byte_count)
            .map_err(|error| format!("Unable to allocate the VNC framebuffer: {error}"))?;
        pixels.resize(byte_count, 0);

        self.width = width;
        self.height = height;
        self.pixels = pixels;
        self.dirty = true;
        Ok(())
    }

    /// Blits one server rectangle into the screen. Rectangles that fall
    /// outside the current resolution are clipped rather than trusted.
    fn blit(&mut self, rect: vnc::Rect, data: &[u8]) {
        let screen_width = usize::from(self.width);
        let screen_height = usize::from(self.height);
        let target_x = usize::from(rect.x);
        let target_y = usize::from(rect.y);
        let rect_width = usize::from(rect.width);
        let source_bytes_per_row = rect_width * 4;
        let copy_width = rect_width.min(screen_width.saturating_sub(target_x));
        let copy_height = usize::from(rect.height).min(screen_height.saturating_sub(target_y));
        let copy_bytes_per_row = copy_width * 4;
        if copy_bytes_per_row == 0 || copy_height == 0 {
            return;
        }

        let mut copied = false;
        for row in 0..copy_height {
            let source_start = row * source_bytes_per_row;
            let Some(source) = data.get(source_start..source_start + copy_bytes_per_row) else {
                break;
            };
            let target_start = ((target_y + row) * screen_width + target_x) * 4;
            let Some(target) = self
                .pixels
                .get_mut(target_start..target_start + copy_bytes_per_row)
            else {
                break;
            };
            target.copy_from_slice(source);
            copied = true;
        }
        if copied {
            self.dirty = true;
        }
    }

    /// CopyRect: moves one on-screen rectangle to another position.
    fn copy_rect(&mut self, dst: vnc::Rect, src_x: u16, src_y: u16) {
        let screen_width = usize::from(self.width);
        let screen_height = usize::from(self.height);
        let source_x = usize::from(src_x);
        let source_y = usize::from(src_y);
        let target_x = usize::from(dst.x);
        let target_y = usize::from(dst.y);
        let copy_width = usize::from(dst.width)
            .min(screen_width.saturating_sub(source_x))
            .min(screen_width.saturating_sub(target_x));
        let copy_height = usize::from(dst.height)
            .min(screen_height.saturating_sub(source_y))
            .min(screen_height.saturating_sub(target_y));
        let bytes_per_row = copy_width * 4;
        if bytes_per_row == 0 || copy_height == 0 {
            return;
        }

        let mut rows = Vec::with_capacity(copy_height);
        for row in 0..copy_height {
            let from = ((source_y + row) * screen_width + source_x) * 4;
            match self.pixels.get(from..from + bytes_per_row) {
                Some(slice) => rows.push(slice.to_vec()),
                None => return,
            }
        }
        for (row, data) in rows.into_iter().enumerate() {
            let to = ((target_y + row) * screen_width + target_x) * 4;
            if let Some(target) = self.pixels.get_mut(to..to + bytes_per_row) {
                target.copy_from_slice(&data);
            }
        }
        self.dirty = true;
    }

    fn encode_jpeg(&self) -> Result<Vec<u8>, String> {
        // JPEG carries no alpha; strip the channel rather than ask the
        // encoder to guess.
        let mut rgb = Vec::with_capacity(self.pixels.len() / 4 * 3);
        let (pixels, remainder) = self.pixels.as_chunks::<4>();
        debug_assert!(remainder.is_empty());
        for pixel in pixels {
            rgb.extend_from_slice(&pixel[..3]);
        }
        let mut jpeg = Vec::new();
        JpegEncoder::new_with_quality(&mut jpeg, 78)
            .encode(
                &rgb,
                u32::from(self.width),
                u32::from(self.height),
                ExtendedColorType::Rgb8,
            )
            .map_err(|error| error.to_string())?;
        Ok(jpeg)
    }
}

async fn emit(stdout: &mut Stdout, event: &Event) -> Result<(), String> {
    let mut line = serde_json::to_vec(event).map_err(|error| error.to_string())?;
    line.push(b'\n');
    stdout
        .write_all(&line)
        .await
        .map_err(|error| error.to_string())?;
    stdout.flush().await.map_err(|error| error.to_string())
}

async fn read_command(lines: &mut Lines<BufReader<Stdin>>) -> Result<Option<Command>, String> {
    let Some(line) = lines.next_line().await.map_err(|error| error.to_string())? else {
        return Ok(None);
    };
    serde_json::from_str(&line)
        .map(Some)
        .map_err(|error| error.to_string())
}

/// Tracks the pointer so button changes always carry the current position.
struct InputState {
    x: u16,
    y: u16,
    buttons: u8,
    pressed_keys: BTreeSet<u32>,
}

impl InputState {
    fn new() -> Self {
        Self {
            x: 0,
            y: 0,
            buttons: 0,
            pressed_keys: BTreeSet::new(),
        }
    }

    fn event(&self) -> X11Event {
        X11Event::PointerEvent(ClientMouseEvent {
            position_x: self.x,
            position_y: self.y,
            bottons: self.buttons,
        })
    }
}

fn button_bit(button: u8) -> Option<u8> {
    match button {
        0 => Some(BUTTON_LEFT),
        1 => Some(BUTTON_MIDDLE),
        2 => Some(BUTTON_RIGHT),
        _ => None,
    }
}

/// Turns one interface command into the X11 events the server expects.
fn input_events(state: &mut InputState, command: &Command) -> Vec<X11Event> {
    match command {
        Command::MouseMove { x, y } => {
            state.x = *x;
            state.y = *y;
            vec![state.event()]
        }
        Command::MouseButton { button, pressed } => {
            let Some(bit) = button_bit(*button) else {
                return Vec::new();
            };
            if *pressed {
                state.buttons |= bit;
            } else {
                state.buttons &= !bit;
            }
            vec![state.event()]
        }
        Command::Wheel { horizontal, units } => {
            // Each unit is a press-release pulse of the matching wheel bit.
            let bit = match (horizontal, units.is_negative()) {
                (false, true) => WHEEL_UP,
                (false, false) => WHEEL_DOWN,
                (true, true) => WHEEL_LEFT,
                (true, false) => WHEEL_RIGHT,
            };
            let pulses = units.unsigned_abs().min(8);
            let mut events = Vec::with_capacity(usize::from(pulses) * 2);
            for _ in 0..pulses {
                state.buttons |= bit;
                events.push(state.event());
                state.buttons &= !bit;
                events.push(state.event());
            }
            events
        }
        Command::Key { keysym, pressed } => {
            if *pressed {
                state.pressed_keys.insert(*keysym);
            } else {
                state.pressed_keys.remove(keysym);
            }
            vec![X11Event::KeyEvent(ClientKeyEvent {
                keycode: *keysym,
                down: *pressed,
            })]
        }
        Command::ReleaseAll => {
            let mut events = Vec::with_capacity(state.pressed_keys.len() + 1);
            for keysym in std::mem::take(&mut state.pressed_keys) {
                events.push(X11Event::KeyEvent(ClientKeyEvent {
                    keycode: keysym,
                    down: false,
                }));
            }
            if state.buttons != 0 {
                state.buttons = 0;
                events.push(state.event());
            }
            events
        }
        Command::Connect { .. } | Command::Close => Vec::new(),
    }
}

async fn run_session(
    hostname: String,
    port: u16,
    password: String,
    lines: &mut Lines<BufReader<Stdin>>,
    stdout: &mut Stdout,
) -> Result<(), String> {
    let tcp = TcpStream::connect((hostname.as_str(), port))
        .await
        .map_err(|error| error.to_string())?;

    let client = match VncConnector::new(tcp)
        .set_auth_method(async move { Ok(password) })
        .add_encoding(vnc::VncEncoding::Zrle)
        .add_encoding(vnc::VncEncoding::CopyRect)
        .add_encoding(vnc::VncEncoding::Raw)
        .allow_shared(true)
        .set_pixel_format(PixelFormat::rgba())
        .build()
        .map_err(|error| error.to_string())?
        .try_start()
        .await
    {
        Ok(connection) => connection.finish().map_err(|error| error.to_string())?,
        Err(vnc::VncError::WrongPassword) => {
            emit(stdout, &Event::AuthFailed).await?;
            return Ok(());
        }
        Err(error) => {
            // Servers that refuse credentials in the SecurityResult message
            // surface here as a generic error whose text says so.
            let detail = error.to_string();
            if detail.to_ascii_lowercase().contains("auth") {
                emit(stdout, &Event::AuthFailed).await?;
            } else {
                emit(
                    stdout,
                    &Event::Failed {
                        stage: "connect",
                        detail,
                    },
                )
                .await?;
            }
            return Ok(());
        }
    };

    let mut framebuffer = Framebuffer::new();
    let mut input_state = InputState::new();
    let mut announced = false;
    let mut frame_id = 0_u64;
    let mut ticker = tokio::time::interval(FRAME_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            command = read_command(lines) => {
                match command? {
                    Some(Command::Close) | None => {
                        let _ = client.close().await;
                        emit(stdout, &Event::Closed { reason: "disconnected".to_string() }).await?;
                        return Ok(());
                    }
                    Some(command) => {
                        for event in input_events(&mut input_state, &command) {
                            client
                                .input(event)
                                .await
                                .map_err(|error| error.to_string())?;
                        }
                    }
                }
            }
            event = client.poll_event() => {
                match event.map_err(|error| error.to_string())? {
                    Some(VncEvent::SetResolution(screen)) => {
                        framebuffer.resize(screen.width, screen.height)?;
                        if !announced {
                            announced = true;
                            emit(stdout, &Event::Connected {
                                width: screen.width,
                                height: screen.height,
                            }).await?;
                            // Ask for the first full screen straight away.
                            client
                                .input(X11Event::FullRefresh)
                                .await
                                .map_err(|error| error.to_string())?;
                        }
                    }
                    Some(VncEvent::RawImage(rect, data)) => framebuffer.blit(rect, &data),
                    Some(VncEvent::Copy(dst, src)) => framebuffer.copy_rect(dst, src.x, src.y),
                    Some(VncEvent::Error(detail)) => {
                        emit(stdout, &Event::Closed { reason: detail }).await?;
                        return Ok(());
                    }
                    // Bell, clipboard text, cursor shapes: nothing to composite.
                    Some(_) => {}
                    // vnc-rs poll_event uses try_recv and returns immediately
                    // on an empty queue. Yield instead of spinning a core and
                    // starving stdin/network work while the screen is idle.
                    None => tokio::time::sleep(Duration::from_millis(2)).await,
                }
            }
            _ = ticker.tick() => {
                if framebuffer.dirty && framebuffer.width > 0 {
                    framebuffer.dirty = false;
                    frame_id = frame_id.wrapping_add(1);
                    let jpeg = framebuffer.encode_jpeg()?;
                    emit(stdout, &Event::Frame {
                        frame_id,
                        width: framebuffer.width,
                        height: framebuffer.height,
                        mime_type: "image/jpeg",
                        base64: BASE64.encode(jpeg),
                    }).await?;
                }
                if announced {
                    // Keep the update loop fed; the server answers when
                    // something changed.
                    client
                        .input(X11Event::Refresh)
                        .await
                        .map_err(|error| error.to_string())?;
                }
            }
        }
    }
}

#[tokio::main]
async fn main() {
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();

    let (hostname, port, password) = match read_command(&mut lines).await {
        Ok(Some(Command::Connect {
            hostname,
            port,
            password,
        })) => (hostname, port, password),
        Ok(_) => {
            let _ = emit(
                &mut stdout,
                &Event::Failed {
                    stage: "protocol",
                    detail: "The first command must start a connection.".to_string(),
                },
            )
            .await;
            return;
        }
        Err(error) => {
            let _ = emit(
                &mut stdout,
                &Event::Failed {
                    stage: "protocol",
                    detail: error,
                },
            )
            .await;
            return;
        }
    };

    if let Err(error) = run_session(hostname, port, password, &mut lines, &mut stdout).await {
        let _ = emit(
            &mut stdout,
            &Event::Failed {
                stage: "engine",
                detail: error,
            },
        )
        .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: u16, y: u16, width: u16, height: u16) -> vnc::Rect {
        vnc::Rect {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn rectangles_land_where_the_server_says() {
        let mut framebuffer = Framebuffer::new();
        framebuffer.resize(4, 4).unwrap();

        // A 2x2 red square at (1, 1).
        let red = [255, 0, 0, 255].repeat(4);
        framebuffer.blit(rect(1, 1, 2, 2), &red);

        let pixel = |x: usize, y: usize| {
            let start = (y * 4 + x) * 4;
            &framebuffer.pixels[start..start + 4]
        };
        assert_eq!(pixel(1, 1), &[255, 0, 0, 255]);
        assert_eq!(pixel(2, 2), &[255, 0, 0, 255]);
        assert_eq!(pixel(0, 0), &[0, 0, 0, 0]);
        assert_eq!(pixel(3, 3), &[0, 0, 0, 0]);
    }

    #[test]
    fn rectangles_are_clipped_on_both_axes_without_crossing_rows() {
        let mut framebuffer = Framebuffer::new();
        framebuffer.resize(3, 2).unwrap();
        let data = [
            1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0, 255, 4, 0, 0, 255, 5, 0, 0, 255, 6, 0, 0, 255,
        ];

        framebuffer.blit(rect(2, 0, 2, 3), &data);

        let pixel = |x: usize, y: usize| {
            let start = (y * 3 + x) * 4;
            &framebuffer.pixels[start..start + 4]
        };
        assert_eq!(pixel(2, 0), &[1, 0, 0, 255]);
        assert_eq!(pixel(2, 1), &[3, 0, 0, 255]);
        assert_eq!(pixel(0, 1), &[0, 0, 0, 0]);
        assert_eq!(pixel(1, 1), &[0, 0, 0, 0]);
        assert_eq!(framebuffer.pixels.len(), 3 * 2 * 4);
    }

    #[test]
    fn resize_rejects_oversized_or_empty_framebuffers_without_losing_the_current_frame() {
        let mut framebuffer = Framebuffer::new();
        framebuffer.resize(2, 2).unwrap();
        framebuffer.pixels[0] = 42;

        let error = framebuffer.resize(u16::MAX, u16::MAX).unwrap_err();
        assert!(error.contains("exceeds the safety limit"));
        assert_eq!((framebuffer.width, framebuffer.height), (2, 2));
        assert_eq!(framebuffer.pixels[0], 42);
        assert!(Framebuffer::new().resize(0, 1080).is_err());
    }

    #[test]
    fn copyrect_moves_pixels_within_the_screen() {
        let mut framebuffer = Framebuffer::new();
        framebuffer.resize(4, 1).unwrap();
        framebuffer.blit(rect(0, 0, 1, 1), &[1, 2, 3, 4]);

        framebuffer.copy_rect(rect(2, 0, 1, 1), 0, 0);

        let start = 2 * 4;
        assert_eq!(&framebuffer.pixels[start..start + 4], &[1, 2, 3, 4]);
    }

    #[test]
    fn copyrect_clips_source_and_destination_without_crossing_rows() {
        let mut framebuffer = Framebuffer::new();
        framebuffer.resize(3, 2).unwrap();
        let data = [
            1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0, 255, 4, 0, 0, 255, 5, 0, 0, 255, 6, 0, 0, 255,
        ];
        framebuffer.blit(rect(0, 0, 3, 2), &data);

        framebuffer.copy_rect(rect(2, 0, 2, 3), 0, 0);

        let pixel = |x: usize, y: usize| {
            let start = (y * 3 + x) * 4;
            &framebuffer.pixels[start..start + 4]
        };
        assert_eq!(pixel(2, 0), &[1, 0, 0, 255]);
        assert_eq!(pixel(2, 1), &[4, 0, 0, 255]);
        assert_eq!(pixel(0, 1), &[4, 0, 0, 255]);
        assert_eq!(pixel(1, 1), &[5, 0, 0, 255]);
    }

    #[test]
    fn wheel_units_become_press_release_pulses() {
        let mut pointer = InputState::new();
        let events = input_events(
            &mut pointer,
            &Command::Wheel {
                horizontal: false,
                units: -2,
            },
        );
        // Two pulses, each a press and a release.
        assert_eq!(events.len(), 4);
        assert_eq!(pointer.buttons, 0, "no wheel bit stays latched");
    }

    #[test]
    fn button_state_accumulates_and_release_all_clears_it() {
        let mut pointer = InputState::new();
        input_events(
            &mut pointer,
            &Command::MouseButton {
                button: 0,
                pressed: true,
            },
        );
        input_events(
            &mut pointer,
            &Command::MouseButton {
                button: 2,
                pressed: true,
            },
        );
        assert_eq!(pointer.buttons, BUTTON_LEFT | BUTTON_RIGHT);

        let release = input_events(&mut pointer, &Command::ReleaseAll);
        assert_eq!(release.len(), 1);
        assert_eq!(pointer.buttons, 0);
    }

    #[test]
    fn release_all_releases_each_pressed_key_and_pointer_button() {
        let mut state = InputState::new();
        for keysym in [0xFFE1, 0xFFE3] {
            input_events(
                &mut state,
                &Command::Key {
                    keysym,
                    pressed: true,
                },
            );
        }
        input_events(
            &mut state,
            &Command::MouseButton {
                button: 0,
                pressed: true,
            },
        );

        let release = input_events(&mut state, &Command::ReleaseAll);

        assert_eq!(release.len(), 3);
        assert!(
            matches!(&release[0], X11Event::KeyEvent(event) if event.keycode == 0xFFE1 && !event.down)
        );
        assert!(
            matches!(&release[1], X11Event::KeyEvent(event) if event.keycode == 0xFFE3 && !event.down)
        );
        assert!(matches!(&release[2], X11Event::PointerEvent(event) if event.bottons == 0));
        assert!(state.pressed_keys.is_empty());
        assert_eq!(state.buttons, 0);
        assert!(input_events(&mut state, &Command::ReleaseAll).is_empty());
    }

    #[test]
    fn commands_parse_from_the_sidecar_protocol() {
        let connect: Command = serde_json::from_str(
            r#"{"kind":"connect","hostname":"vnc.test","port":5900,"password":"secret"}"#,
        )
        .unwrap();
        assert!(matches!(connect, Command::Connect { port: 5900, .. }));

        let key: Command =
            serde_json::from_str(r#"{"kind":"key","keysym":65293,"pressed":true}"#).unwrap();
        assert!(matches!(
            key,
            Command::Key {
                keysym: 65293,
                pressed: true
            }
        ));
    }
}
