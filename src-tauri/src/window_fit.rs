#[derive(Clone, Copy, Debug, PartialEq)]
struct Frame {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Debug, PartialEq)]
struct Fit {
    frame: Frame,
    inner: (u32, u32),
    minimum: (u32, u32),
}

fn fit(frame: Frame, inner: (u32, u32), work: Frame, scale: f64) -> Option<Fit> {
    if work.width == 0 || work.height == 0 || !scale.is_finite() || scale <= 0.0 {
        return None;
    }
    let border = (
        frame.width.saturating_sub(inner.0),
        frame.height.saturating_sub(inner.1),
    );
    let available = (
        work.width.checked_sub(border.0)?,
        work.height.checked_sub(border.1)?,
    );
    if available.0 == 0 || available.1 == 0 {
        return None;
    }
    let inner = (inner.0.min(available.0), inner.1.min(available.1));
    let width = inner.0 + border.0;
    let height = inner.1 + border.1;
    let x = i64::from(frame.x).clamp(
        i64::from(work.x),
        i64::from(work.x) + i64::from(work.width - width),
    ) as i32;
    let y = i64::from(frame.y).clamp(
        i64::from(work.y),
        i64::from(work.y) + i64::from(work.height - height),
    ) as i32;
    Some(Fit {
        frame: Frame {
            x,
            y,
            width,
            height,
        },
        inner,
        minimum: (
            ((720.0 * scale).round() as u32).min(available.0),
            ((580.0 * scale).round() as u32).min(available.1),
        ),
    })
}

pub fn install(window: tauri::WebviewWindow) {
    use std::sync::{Arc, Mutex};
    let minimum = Arc::new(Mutex::new(None));
    if let Err(error) = fit_window(&window, &minimum, true) {
        eprintln!("Could not fit initial main window to monitor work area: {error}");
    }
    let apply = {
        let window = window.clone();
        move |reposition| {
            let window = window.clone();
            let minimum = Arc::clone(&minimum);
            let dispatcher = window.clone();
            if let Err(error) = dispatcher.run_on_main_thread(move || {
                if let Err(error) = fit_window(&window, &minimum, reposition) {
                    eprintln!("Could not fit main window to monitor work area: {error}");
                }
            }) {
                eprintln!("Could not schedule main window fitting: {error}");
            }
        }
    };
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Moved(_)) {
            apply(false);
        }
        if matches!(
            event,
            tauri::WindowEvent::Resized(_)
                | tauri::WindowEvent::ScaleFactorChanged { .. }
                | tauri::WindowEvent::Focused(true)
        ) {
            apply(true);
        }
    });
}

fn fit_window(
    window: &tauri::WebviewWindow,
    minimum: &std::sync::Mutex<Option<(u32, u32)>>,
    reposition: bool,
) -> tauri::Result<()> {
    if window.is_minimized()? || window.is_maximized()? || window.is_fullscreen()? {
        return Ok(());
    }
    let Some(monitor) = window.current_monitor()?.or(window.primary_monitor()?) else {
        return Ok(());
    };
    let outer = window.outer_size()?;
    let inner = window.inner_size()?;
    let position = window.outer_position()?;
    let work = monitor.work_area();
    let Some(result) = fit(
        Frame {
            x: position.x,
            y: position.y,
            width: outer.width,
            height: outer.height,
        },
        (inner.width, inner.height),
        Frame {
            x: work.position.x,
            y: work.position.y,
            width: work.size.width,
            height: work.size.height,
        },
        window.scale_factor()?,
    ) else {
        return Ok(());
    };
    let previous_minimum = *minimum
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if previous_minimum != Some(result.minimum) {
        window.set_min_size(Some(tauri::PhysicalSize::new(
            result.minimum.0,
            result.minimum.1,
        )))?;
        *minimum
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(result.minimum);
    }
    if result.inner != (inner.width, inner.height) {
        window.set_size(tauri::PhysicalSize::new(result.inner.0, result.inner.1))?;
    }
    if reposition && (result.frame.x, result.frame.y) != (position.x, position.y) {
        window.set_position(tauri::PhysicalPosition::new(result.frame.x, result.frame.y))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORK: Frame = Frame {
        x: 0,
        y: 0,
        width: 1280,
        height: 672,
    };

    #[test]
    fn runtime_entrypoint_is_typechecked_without_opening_a_window() {
        let _install: fn(tauri::WebviewWindow) = install;
    }

    #[test]
    fn logical_minimum_matches_main_window_configuration() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let window = &config["app"]["windows"][0];
        let result = fit(WORK, (1264, 633), WORK, 1.0).unwrap();
        assert_eq!(
            window["minWidth"].as_u64(),
            Some(u64::from(result.minimum.0))
        );
        assert_eq!(
            window["minHeight"].as_u64(),
            Some(u64::from(result.minimum.1))
        );
    }

    #[test]
    fn measured_restored_window_keeps_entire_outer_frame_in_work_area() {
        let result = fit(
            Frame {
                x: 25,
                y: 0,
                width: 1255,
                height: 737,
            },
            (1240, 698),
            WORK,
            1.0,
        )
        .unwrap();
        assert_eq!(result.inner, (1240, 633));
        assert_eq!(
            result.frame,
            Frame {
                x: 25,
                y: 0,
                width: 1255,
                height: 672
            }
        );
    }

    #[test]
    fn dpi_minimum_yields_to_available_client_area() {
        for scale in [1.25, 1.5, 2.0] {
            let result = fit(
                Frame {
                    x: 0,
                    y: 0,
                    width: 1500,
                    height: 1000,
                },
                (1480, 950),
                WORK,
                scale,
            )
            .unwrap();
            assert_eq!(result.inner, (1260, 622));
            assert_eq!(
                result.minimum,
                (((720.0 * scale).round() as u32).min(1260), 622)
            );
            assert_eq!(fit(result.frame, result.inner, WORK, scale), Some(result));
        }
    }

    #[test]
    fn negative_monitor_and_side_taskbar_preserve_global_coordinates() {
        let work = Frame {
            x: -1880,
            y: -200,
            width: 1880,
            height: 1040,
        };
        let result = fit(
            Frame {
                x: -1920,
                y: 700,
                width: 1000,
                height: 700,
            },
            (984, 661),
            work,
            1.0,
        )
        .unwrap();
        assert_eq!((result.frame.x, result.frame.y), (-1880, 140));
        assert_eq!(result.inner, (984, 661));
    }

    #[test]
    fn normal_user_size_and_position_are_unchanged() {
        let frame = Frame {
            x: 100,
            y: 40,
            width: 900,
            height: 620,
        };
        let result = fit(frame, (884, 581), WORK, 1.0).unwrap();
        assert_eq!(result.frame, frame);
        assert_eq!(result.inner, (884, 581));
        assert_eq!(result.minimum, (720, 580));
    }

    #[test]
    fn small_work_area_reduces_minimum_without_changing_default_on_large_monitor() {
        let frame = Frame {
            x: 0,
            y: 0,
            width: 1256,
            height: 859,
        };
        let small = fit(
            frame,
            (1240, 820),
            Frame {
                width: 640,
                height: 480,
                ..WORK
            },
            1.0,
        )
        .unwrap();
        assert_eq!(small.minimum, (624, 441));
        let large = fit(
            frame,
            (1240, 820),
            Frame {
                width: 1920,
                height: 1040,
                ..WORK
            },
            1.0,
        )
        .unwrap();
        assert_eq!(large.frame, frame);
        assert_eq!(large.minimum, (720, 580));
    }

    #[test]
    fn unavailable_geometry_is_not_applied() {
        for scale in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert!(fit(WORK, (1264, 633), WORK, scale).is_none());
        }
        assert!(fit(WORK, (1264, 633), Frame { width: 0, ..WORK }, 1.0).is_none());
        assert!(fit(WORK, (1264, 633), Frame { height: 20, ..WORK }, 1.0).is_none());
    }
}
