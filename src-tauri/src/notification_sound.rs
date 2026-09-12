const SAMPLE_RATE: u32 = 44_100;
const CHANNELS: u16 = 1;
const BITS_PER_SAMPLE: u16 = 16;

#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
enum Waveform {
    Sine,
    Triangle,
    Square,
}

#[derive(Clone, Copy, serde::Deserialize)]
struct Tone {
    frequency: f32,
    delay: f32,
    duration: f32,
    gain: f32,
    #[serde(rename = "type")]
    waveform: Waveform,
}
fn tones(sound: &str) -> Result<&'static [Tone], String> {
    use std::{collections::BTreeMap, sync::OnceLock};
    static CATALOG: OnceLock<BTreeMap<String, Vec<Tone>>> = OnceLock::new();
    let catalog = CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!("../../src/app/notificationSoundCatalog.json"))
            .expect("embedded sound catalog")
    });
    if sound == "off" {
        return Ok(&[]);
    }
    catalog
        .get(sound)
        .map(Vec::as_slice)
        .ok_or_else(|| "Unknown notification sound.".to_owned())
}

fn waveform_sample(waveform: Waveform, phase: f32) -> f32 {
    match waveform {
        Waveform::Sine => phase.sin(),
        Waveform::Triangle => (2.0 / std::f32::consts::PI) * phase.sin().asin(),
        Waveform::Square => {
            if phase.sin() >= 0.0 {
                1.0
            } else {
                -1.0
            }
        }
    }
}

fn render_wave(sound: &str, volume: u8) -> Result<Vec<u8>, String> {
    if volume > 100 {
        return Err("Notification volume must be between 0 and 100.".into());
    }
    let tones = tones(sound)?;
    if tones.is_empty() || volume == 0 {
        return Ok(Vec::new());
    }

    let duration = tones
        .iter()
        .map(|tone| tone.delay + tone.duration)
        .fold(0.0_f32, f32::max)
        + 0.035;
    let sample_count = (duration * SAMPLE_RATE as f32) as usize;
    let mut mixed = vec![0.0_f32; sample_count];
    for tone in tones {
        let start = (tone.delay * SAMPLE_RATE as f32) as usize;
        let length = (tone.duration * SAMPLE_RATE as f32) as usize;
        let attack = (SAMPLE_RATE as f32 * 0.012) as usize;
        let peak = tone.gain * f32::from(volume) / 100.0;
        for offset in 0..length.min(sample_count.saturating_sub(start)) {
            let gain = if offset < attack {
                0.0001 * (peak / 0.0001).powf(offset as f32 / attack as f32)
            } else {
                peak * (0.0001 / peak).powf((offset - attack) as f32 / (length - attack) as f32)
            };
            let phase = std::f32::consts::TAU * tone.frequency * offset as f32 / SAMPLE_RATE as f32;
            mixed[start + offset] += waveform_sample(tone.waveform, phase) * gain;
        }
    }

    let data_length = (mixed.len() * 2) as u32;
    let mut wave = Vec::with_capacity(44 + data_length as usize);
    wave.extend_from_slice(b"RIFF");
    wave.extend_from_slice(&(36 + data_length).to_le_bytes());
    wave.extend_from_slice(b"WAVEfmt ");
    wave.extend_from_slice(&16_u32.to_le_bytes());
    wave.extend_from_slice(&1_u16.to_le_bytes());
    wave.extend_from_slice(&CHANNELS.to_le_bytes());
    wave.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    let byte_rate = SAMPLE_RATE * u32::from(CHANNELS) * u32::from(BITS_PER_SAMPLE) / 8;
    wave.extend_from_slice(&byte_rate.to_le_bytes());
    let block_align = CHANNELS * BITS_PER_SAMPLE / 8;
    wave.extend_from_slice(&block_align.to_le_bytes());
    wave.extend_from_slice(&BITS_PER_SAMPLE.to_le_bytes());
    wave.extend_from_slice(b"data");
    wave.extend_from_slice(&data_length.to_le_bytes());
    for sample in mixed {
        let value = (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        wave.extend_from_slice(&value.to_le_bytes());
    }
    Ok(wave)
}

#[cfg(target_os = "windows")]
fn play_wave(wave: &[u8]) -> Result<bool, String> {
    use std::ffi::c_void;
    use std::sync::{Mutex, OnceLock};

    const SND_NODEFAULT: u32 = 0x0002;
    const SND_MEMORY: u32 = 0x0004;

    #[link(name = "winmm")]
    unsafe extern "system" {
        fn PlaySoundA(sound: *const u8, module: *mut c_void, flags: u32) -> i32;
    }

    if wave.is_empty() {
        return Ok(true);
    }
    // PlaySound with SND_MEMORY must remain synchronous so the in-memory wave
    // stays valid. Serializing requests also stops a completion cue and a
    // Settings preview from replacing one another on Windows' shared player.
    static PLAYBACK_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    let _playback = PLAYBACK_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    // SND_SYNC is zero and keeps the in-memory WAV alive until playback ends.
    let played = unsafe {
        PlaySoundA(
            wave.as_ptr(),
            std::ptr::null_mut(),
            SND_MEMORY | SND_NODEFAULT,
        )
    };
    if played == 0 {
        Err("Windows could not play the notification sound.".to_string())
    } else {
        Ok(true)
    }
}

#[cfg(not(target_os = "windows"))]
fn play_wave(_wave: &[u8]) -> Result<bool, String> {
    Ok(false)
}

pub fn play(sound: &str, volume: u8) -> Result<bool, String> {
    play_wave(&render_wave(sound, volume)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_named_sound_renders_a_short_pcm_wave() {
        for sound in [
            "bloom", "drift", "moon", "droplet", "glass", "spark", "marimba", "pluck", "bamboo",
            "orbit", "pulse", "arcade",
        ] {
            let wave = render_wave(sound, 60).unwrap();
            assert_eq!(&wave[0..4], b"RIFF");
            assert_eq!(&wave[8..12], b"WAVE");
            assert_eq!(&wave[36..40], b"data");
            assert!(wave.len() > 44);
            assert!(wave.len() < 44 + SAMPLE_RATE as usize * 2);
            assert!(wave[44..].iter().any(|byte| *byte != 0));
        }
    }

    #[test]
    fn off_is_silent_and_unknown_names_are_rejected() {
        assert!(render_wave("off", 60).unwrap().is_empty());
        assert!(render_wave("surprise", 60).is_err());
    }

    #[test]
    fn volume_scales_pcm_without_clipping_and_zero_is_silent() {
        fn samples(wave: &[u8]) -> Vec<i16> {
            wave[44..]
                .chunks_exact(2)
                .map(|b| i16::from_le_bytes([b[0], b[1]]))
                .collect()
        }
        assert!(render_wave("bloom", 0).unwrap().is_empty());
        assert!(render_wave("bloom", 101).is_err());
        let full = samples(&render_wave("bloom", 100).unwrap());
        let low = samples(&render_wave("bloom", 25).unwrap());
        let energy = |s: &[i16]| s.iter().map(|v| f64::from(*v).powi(2)).sum::<f64>();
        assert!(energy(&low) < energy(&full) * 0.15);
        assert!(energy(&low) > 0.0);
        assert!(full.iter().all(|v| v.unsigned_abs() < i16::MAX as u16));
    }

    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "plays a short cue through the real Windows output device"]
    fn windows_backend_plays_the_bloom_cue() {
        assert_eq!(play("bloom", 60), Ok(true));
    }
}
