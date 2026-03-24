use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, WindowEvent};
#[cfg(target_os = "windows")]
use window_vibrancy::apply_mica;

const POMODORO_DEFAULT_SECS: u64 = 25 * 60;

#[derive(Clone, Serialize)]
struct PomodoroTick {
    remaining_ms: u64,
    is_running: bool,
    is_break: bool,
}

#[derive(Clone, Serialize)]
struct PomodoroSettings {
    focus_minutes: u64,
    break_minutes: u64,
    is_break: bool,
}

struct PomodoroState {
    remaining_ms: Arc<AtomicU64>,
    is_running: Arc<AtomicBool>,
    is_break: Arc<AtomicBool>,
    focus_secs: Arc<AtomicU64>,
    break_secs: Arc<AtomicU64>,
    generation: Arc<AtomicU64>,
    end_at: Arc<Mutex<Option<Instant>>>,
}

impl PomodoroState {
    fn new() -> Self {
        Self {
            remaining_ms: Arc::new(AtomicU64::new(POMODORO_DEFAULT_SECS * 1_000)),
            is_running: Arc::new(AtomicBool::new(false)),
            is_break: Arc::new(AtomicBool::new(false)),
            focus_secs: Arc::new(AtomicU64::new(POMODORO_DEFAULT_SECS)),
            break_secs: Arc::new(AtomicU64::new(5 * 60)),
            generation: Arc::new(AtomicU64::new(0)),
            end_at: Arc::new(Mutex::new(None)),
        }
    }
}

#[tauri::command]
fn pomodoro_start(app: tauri::AppHandle, state: tauri::State<PomodoroState>) -> Result<(), String> {
    if state.is_running.swap(true, Ordering::SeqCst) {
        return Ok(());
    }

    let remaining = state.remaining_ms.load(Ordering::SeqCst);
    let end_time = Instant::now() + Duration::from_millis(remaining);
    if let Ok(mut guard) = state.end_at.lock() {
        *guard = Some(end_time);
    }

    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let remaining_ms = Arc::clone(&state.remaining_ms);
    let is_running = Arc::clone(&state.is_running);
    let is_break = Arc::clone(&state.is_break);
    let gen_ref = Arc::clone(&state.generation);
    let end_at = Arc::clone(&state.end_at);

    thread::spawn(move || loop {
        if gen_ref.load(Ordering::SeqCst) != generation {
            break;
        }

        let maybe_end = end_at.lock().ok().and_then(|g| *g);
        let Some(end) = maybe_end else {
            break;
        };

        let now = Instant::now();
        let ms = if now >= end {
            0
        } else {
            (end - now).as_millis() as u64
        };
        remaining_ms.store(ms, Ordering::SeqCst);

        let _ = app.emit(
            "pomodoro:tick",
            PomodoroTick {
                remaining_ms: ms,
                is_running: ms > 0,
                is_break: is_break.load(Ordering::SeqCst),
            },
        );

        if ms == 0 {
            is_running.store(false, Ordering::SeqCst);
            let _ = app.emit("pomodoro:finished", ());
            break;
        }

        thread::sleep(Duration::from_millis(200));
    });

    Ok(())
}

#[tauri::command]
fn pomodoro_pause(state: tauri::State<PomodoroState>) -> Result<(), String> {
    state.is_running.store(false, Ordering::SeqCst);
    state.generation.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut guard) = state.end_at.lock() {
        *guard = None;
    }
    Ok(())
}

#[tauri::command]
fn pomodoro_reset(app: tauri::AppHandle, state: tauri::State<PomodoroState>) -> Result<(), String> {
    state.is_running.store(false, Ordering::SeqCst);
    state.generation.fetch_add(1, Ordering::SeqCst);
    let is_break = state.is_break.load(Ordering::SeqCst);
    let default_secs = if is_break {
        state.break_secs.load(Ordering::SeqCst)
    } else {
        state.focus_secs.load(Ordering::SeqCst)
    };
    state.remaining_ms.store(default_secs * 1_000, Ordering::SeqCst);
    if let Ok(mut guard) = state.end_at.lock() {
        *guard = None;
    }
    let _ = app.emit(
        "pomodoro:tick",
        PomodoroTick {
            remaining_ms: default_secs * 1_000,
            is_running: false,
            is_break,
        },
    );
    Ok(())
}

#[tauri::command]
fn pomodoro_get(state: tauri::State<PomodoroState>) -> PomodoroTick {
    PomodoroTick {
        remaining_ms: state.remaining_ms.load(Ordering::SeqCst),
        is_running: state.is_running.load(Ordering::SeqCst),
        is_break: state.is_break.load(Ordering::SeqCst),
    }
}

#[tauri::command]
fn pomodoro_get_settings(state: tauri::State<PomodoroState>) -> PomodoroSettings {
    PomodoroSettings {
        focus_minutes: state.focus_secs.load(Ordering::SeqCst) / 60,
        break_minutes: state.break_secs.load(Ordering::SeqCst) / 60,
        is_break: state.is_break.load(Ordering::SeqCst),
    }
}

#[tauri::command]
fn pomodoro_set_settings(
    app: tauri::AppHandle,
    state: tauri::State<PomodoroState>,
    focus_minutes: u64,
    break_minutes: u64,
) -> Result<(), String> {
    if !(1..=180).contains(&focus_minutes) {
        return Err("Focus duration must be between 1 and 180 minutes".into());
    }
    if !(1..=60).contains(&break_minutes) {
        return Err("Break duration must be between 1 and 60 minutes".into());
    }

    state.focus_secs.store(focus_minutes * 60, Ordering::SeqCst);
    state.break_secs.store(break_minutes * 60, Ordering::SeqCst);

    if !state.is_running.load(Ordering::SeqCst) {
        let is_break = state.is_break.load(Ordering::SeqCst);
        let next_secs = if is_break {
            break_minutes * 60
        } else {
            focus_minutes * 60
        };
        state.remaining_ms.store(next_secs * 1_000, Ordering::SeqCst);
        let _ = app.emit(
            "pomodoro:tick",
            PomodoroTick {
                remaining_ms: next_secs * 1_000,
                is_running: false,
                is_break,
            },
        );
    }

    Ok(())
}

#[tauri::command]
fn pomodoro_set_mode(
    app: tauri::AppHandle,
    state: tauri::State<PomodoroState>,
    is_break: bool,
) -> Result<(), String> {
    state.is_running.store(false, Ordering::SeqCst);
    state.generation.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut guard) = state.end_at.lock() {
        *guard = None;
    }

    state.is_break.store(is_break, Ordering::SeqCst);
    let secs = if is_break {
        state.break_secs.load(Ordering::SeqCst)
    } else {
        state.focus_secs.load(Ordering::SeqCst)
    };
    state.remaining_ms.store(secs * 1_000, Ordering::SeqCst);

    let _ = app.emit(
        "pomodoro:tick",
        PomodoroTick {
            remaining_ms: secs * 1_000,
            is_running: false,
            is_break,
        },
    );

    Ok(())
}

#[tauri::command]
fn hide_main_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_skip_taskbar(true);
        let _ = window.hide();
    }
    Ok(())
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_skip_taskbar(true);
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PomodoroState::new())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            pomodoro_start,
            pomodoro_pause,
            pomodoro_reset,
            pomodoro_get,
            pomodoro_get_settings,
            pomodoro_set_settings,
            pomodoro_set_mode,
            hide_main_window
        ])
        .setup(|app| {
            let show_item = MenuItemBuilder::with_id("show", "Show AeroTask").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
            let tray_menu = MenuBuilder::new(app).items(&[&show_item, &quit_item]).build()?;

            let app_handle = app.handle().clone();
            TrayIconBuilder::with_id("tray")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "show" => {
                        show_main_window(app);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(move |tray, event| {
                    if let TrayIconEvent::Click { .. } = event {
                        show_main_window(&tray.app_handle());
                    }
                })
                .build(app)?;

            if let Some(window) = app_handle.get_webview_window("main") {
                #[cfg(target_os = "windows")]
                let _ = apply_mica(&window, None);
                let _ = window.set_skip_taskbar(true);
                let _ = window.show();
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.set_skip_taskbar(true);
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
