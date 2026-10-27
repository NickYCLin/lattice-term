//! One-session IronRDP engine controlled by LatticeTerm over NDJSON.

#[cfg(windows)]
mod staging;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use image::codecs::jpeg::JpegEncoder;
use image::{ExtendedColorType, ImageEncoder as _};
use ironrdp::client::config::{ConfigBuilder, Destination};
use ironrdp::client::rdp::{
    AutoReconnectDecision, RdpClient, RdpInputEvent, RdpInputSender, RdpOutputEvent,
};
use ironrdp::input::{Database, MouseButton, MousePosition, Operation, Scancode, WheelRotations};
use ironrdp::pdu::rdp::capability_sets::MajorPlatformType;
use ironrdp_tls::{CertificateValidation, CertificateValidationCallback};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader, Lines, Stdin, Stdout};
use tokio::sync::mpsc;

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Command {
    Connect {
        hostname: String,
        port: u16,
        username: String,
        password: String,
        domain: Option<String>,
        width: u16,
        height: u16,
        trusted_certificate_sha256: Option<String>,
        staging_directory: Option<String>,
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
        scancode: u16,
        pressed: bool,
    },
    Unicode {
        character: char,
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
        file_transfer: bool,
    },
    CertificateUnknown {
        fingerprint_sha256: String,
        detail: String,
    },
    Frame {
        frame_id: u64,
        width: u16,
        height: u16,
        mime_type: &'static str,
        base64: String,
    },
    Failed {
        stage: &'static str,
        detail: String,
    },
    Closed {
        reason: String,
    },
}

struct ConnectSettings {
    hostname: String,
    port: u16,
    username: String,
    password: String,
    domain: Option<String>,
    width: u16,
    height: u16,
    trusted_certificate_sha256: Option<String>,
    staging_directory: Option<String>,
}

fn normalize_fingerprint(value: &str) -> Option<String> {
    let normalized: String = value
        .chars()
        .filter(|character| character.is_ascii_hexdigit())
        .map(|character| character.to_ascii_uppercase())
        .collect();
    (normalized.len() == 64).then_some(normalized)
}

fn fingerprint(der: &[u8]) -> String {
    Sha256::digest(der)
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

fn validate_certificate_pin(
    approved: Option<&str>,
    der: &[u8],
    validation_detail: String,
    rejected: &Mutex<Option<(String, String)>>,
) -> bool {
    let formatted = fingerprint(der);
    let presented = normalize_fingerprint(&formatted).expect("generated SHA-256 fingerprint");
    let accepted = approved == Some(presented.as_str());
    if !accepted {
        if let Ok(mut rejected) = rejected.lock() {
            *rejected = Some((formatted, validation_detail));
        }
    }
    accepted
}

fn rgb_frame(buffer: &[u32], width: u16, height: u16) -> Result<Vec<u8>, String> {
    let expected = usize::from(width) * usize::from(height);
    if buffer.len() != expected {
        return Err("IronRDP returned an invalid framebuffer size.".to_string());
    }

    let mut rgb = Vec::with_capacity(expected * 3);
    for pixel in buffer {
        // IronRDP stores each pixel as 0x00RRGGBB. Converting the integer with
        // the host's byte order would swap red and blue on little-endian
        // machines. JPEG requires RGB without an alpha channel.
        let [_, red, green, blue] = pixel.to_be_bytes();
        rgb.extend_from_slice(&[red, green, blue]);
    }
    Ok(rgb)
}

fn encode_frame(buffer: &[u32], width: u16, height: u16) -> Result<Vec<u8>, String> {
    let rgb = rgb_frame(buffer, width, height)?;
    let mut jpeg = Vec::new();
    JpegEncoder::new_with_quality(&mut jpeg, 78)
        .write_image(
            &rgb,
            u32::from(width),
            u32::from(height),
            ExtendedColorType::Rgb8,
        )
        .map_err(|error| error.to_string())?;
    Ok(jpeg)
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

fn input_events(
    database: &mut Database,
    command: Command,
) -> Result<Option<RdpInputEvent>, String> {
    let operations = match command {
        Command::MouseMove { x, y } => vec![Operation::MouseMove(MousePosition { x, y })],
        Command::MouseButton { button, pressed } => {
            let button = MouseButton::from_web_button(button)
                .ok_or_else(|| "Unsupported mouse button.".to_string())?;
            vec![if pressed {
                Operation::MouseButtonPressed(button)
            } else {
                Operation::MouseButtonReleased(button)
            }]
        }
        Command::Wheel { horizontal, units } => vec![Operation::WheelRotations(WheelRotations {
            is_vertical: !horizontal,
            rotation_units: units,
        })],
        Command::Key { scancode, pressed } => {
            let key = Scancode::from_u16(scancode);
            vec![if pressed {
                Operation::KeyPressed(key)
            } else {
                Operation::KeyReleased(key)
            }]
        }
        Command::Unicode { character, pressed } => vec![if pressed {
            Operation::UnicodeKeyPressed(character)
        } else {
            Operation::UnicodeKeyReleased(character)
        }],
        Command::ReleaseAll => {
            let events = database.release_all();
            return Ok((!events.is_empty()).then_some(RdpInputEvent::FastPath(events)));
        }
        Command::Close | Command::Connect { .. } => return Ok(None),
    };
    let events = database.apply(operations);
    Ok((!events.is_empty()).then_some(RdpInputEvent::FastPath(events)))
}

async fn run_session(
    settings: ConnectSettings,
    lines: &mut Lines<BufReader<Stdin>>,
    stdout: &mut Stdout,
) -> Result<(), String> {
    let approved = settings
        .trusted_certificate_sha256
        .as_deref()
        .and_then(normalize_fingerprint);
    let observed_certificate = Arc::new(Mutex::new(None::<(String, String)>));
    let observed_for_callback = Arc::clone(&observed_certificate);
    let callback: CertificateValidationCallback = Arc::new(move |der, validation_error| {
        validate_certificate_pin(
            approved.as_deref(),
            der,
            validation_error.to_string(),
            &observed_for_callback,
        )
    });

    let mut builder = ConfigBuilder::new()
        .with_destination(Destination::from_parts(settings.hostname, settings.port))
        .with_username(settings.username)
        .with_password(settings.password)
        .with_client_build(200)
        .with_client_dir("C:\\Windows\\System32\\mstscax.dll")
        .with_client_name("LatticeTerm")
        .with_platform(MajorPlatformType::UNSPECIFIED)
        .with_desktop_width(settings.width)
        .with_desktop_height(settings.height)
        .with_tls(false)
        .with_credssp(true)
        .with_server_pointer(true)
        .with_pointer_software_rendering(true)
        .with_certificate_validation(CertificateValidation::Strict)
        .with_certificate_validation_callback(callback);
    if let Some(domain) = settings.domain.filter(|value| !value.trim().is_empty()) {
        builder = builder.with_domain(domain);
    }
    #[cfg(windows)]
    let staging = settings
        .staging_directory
        .as_deref()
        .map(staging::StagingFactory::new)
        .transpose()?;
    #[cfg(windows)]
    {
        builder = builder.with_rdpdr(staging.is_some());
    }
    let config = builder.build().map_err(|error| error.to_string())?;
    let (output_sender, mut output_receiver) = mpsc::channel::<RdpOutputEvent>(16);
    let client = RdpClient::new(config, output_sender).with_auto_reconnect(2);
    #[cfg(windows)]
    let client = if let Some(factory) = staging {
        client.with_rdpdr_backend_factory(Box::new(factory))
    } else {
        client
    };
    let input_sender: RdpInputSender = client.input_sender();
    tokio::task::spawn_local(client.run());

    let mut database = Database::new();
    let mut frame_id = 0_u64;
    loop {
        tokio::select! {
            command = read_command(lines) => {
                match command? {
                    Some(Command::Close) | None => {
                        input_sender.request_graceful_close();
                        return Ok(());
                    }
                    Some(command) => {
                        if let Some(event) = input_events(&mut database, command)? {
                            input_sender.try_send(event).map_err(|_| "RDP input queue is full.".to_string())?;
                        }
                    }
                }
            }
            output = output_receiver.recv() => {
                match output {
                    Some(RdpOutputEvent::Connected) => {
                        emit(stdout, &Event::Connected { width: settings.width, height: settings.height, file_transfer: cfg!(windows) && settings.staging_directory.is_some() }).await?;
                    }
                    Some(RdpOutputEvent::Image { buffer, width, height }) => {
                        frame_id = frame_id.wrapping_add(1);
                        let width = width.get();
                        let height = height.get();
                        let bytes = encode_frame(&buffer, width, height)?;
                        emit(stdout, &Event::Frame {
                            frame_id,
                            width,
                            height,
                            mime_type: "image/jpeg",
                            base64: BASE64.encode(bytes),
                        }).await?;
                    }
                    Some(RdpOutputEvent::ConnectionFailure(error)) => {
                        if let Some((fingerprint_sha256, detail)) = observed_certificate.lock().ok().and_then(|value| value.clone()) {
                            emit(stdout, &Event::CertificateUnknown { fingerprint_sha256, detail }).await?;
                        } else {
                            emit(stdout, &Event::Failed { stage: "connect", detail: error.report().to_string() }).await?;
                        }
                        return Ok(());
                    }
                    Some(RdpOutputEvent::Terminated(result)) => {
                        let reason = result.map(|reason| reason.to_string()).unwrap_or_else(|error| error.to_string());
                        emit(stdout, &Event::Closed { reason }).await?;
                        return Ok(());
                    }
                    Some(RdpOutputEvent::AutoReconnecting { response, .. }) => {
                        let _ = response.send(AutoReconnectDecision::Continue);
                    }
                    Some(_) => {}
                    None => {
                        emit(stdout, &Event::Closed { reason: "The RDP engine stopped without a final status.".to_string() }).await?;
                        return Ok(());
                    }
                }
            }
        }
    }
}

#[tokio::main]
async fn main() {
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();
    let settings = match read_command(&mut lines).await {
        Ok(Some(Command::Connect {
            hostname,
            port,
            username,
            password,
            domain,
            width,
            height,
            trusted_certificate_sha256,
            staging_directory,
        })) => ConnectSettings {
            hostname,
            port,
            username,
            password,
            domain,
            width: width.clamp(640, 1920),
            height: height.clamp(480, 1200),
            trusted_certificate_sha256,
            staging_directory,
        },
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

    let local = tokio::task::LocalSet::new();
    if let Err(error) = local
        .run_until(run_session(settings, &mut lines, &mut stdout))
        .await
    {
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

    #[test]
    fn normalizes_formatted_sha256_fingerprint() {
        let formatted = fingerprint(b"certificate");
        let normalized = normalize_fingerprint(&formatted).expect("valid fingerprint");
        assert_eq!(normalized.len(), 64);
        assert!(!normalized.contains(':'));
    }

    #[test]
    fn rejects_short_certificate_fingerprint() {
        assert!(normalize_fingerprint("AA:BB").is_none());
    }

    #[test]
    fn an_approved_certificate_is_not_remembered_as_rejected() {
        let certificate = b"approved certificate";
        let approved = normalize_fingerprint(&fingerprint(certificate)).expect("valid pin");
        let rejected = Mutex::new(None);

        assert!(validate_certificate_pin(
            Some(&approved),
            certificate,
            "self-signed".to_string(),
            &rejected,
        ));
        assert!(rejected.into_inner().expect("lock").is_none());
    }

    #[test]
    fn an_unapproved_certificate_is_available_for_the_trust_prompt() {
        let certificate = b"new certificate";
        let expected_fingerprint = fingerprint(certificate);
        let rejected = Mutex::new(None);

        assert!(!validate_certificate_pin(
            None,
            certificate,
            "self-signed".to_string(),
            &rejected,
        ));
        assert_eq!(
            rejected.into_inner().expect("lock"),
            Some((expected_fingerprint, "self-signed".to_string())),
        );
    }

    #[test]
    fn converts_ironrdp_pixels_to_rgb_without_swapping_colours() {
        let rgb = rgb_frame(&[0x00FF_0000, 0x0000_00FF], 2, 1).expect("valid frame");

        assert_eq!(rgb, [255, 0, 0, 0, 0, 255]);
    }

    #[test]
    fn framebuffer_encodes_as_a_decodable_jpeg_with_correct_colours() {
        let width = 16;
        let height = 8;
        let buffer: Vec<u32> = (0..height)
            .flat_map(|_| {
                (0..width).map(|x| {
                    if x < width / 2 {
                        0x00FF_0000
                    } else {
                        0x0000_00FF
                    }
                })
            })
            .collect();

        let jpeg = encode_frame(&buffer, width, height).expect("frame must encode as JPEG");
        let decoded = image::load_from_memory_with_format(&jpeg, image::ImageFormat::Jpeg)
            .expect("frame must decode as JPEG")
            .to_rgb8();

        assert_eq!(decoded.dimensions(), (u32::from(width), u32::from(height)));
        let red = decoded.get_pixel(3, 4).0;
        let blue = decoded.get_pixel(12, 4).0;
        assert!(red[0] > 200 && red[1] < 40 && red[2] < 40, "{red:?}");
        assert!(blue[0] < 40 && blue[1] < 40 && blue[2] > 200, "{blue:?}");
    }

    #[test]
    fn rejects_a_framebuffer_with_the_wrong_pixel_count() {
        assert!(rgb_frame(&[0], 2, 1).is_err());
    }
}
