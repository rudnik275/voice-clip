// Prevents an extra console window on Windows in release. macOS-only app,
// but the attribute is harmless and is the Tauri default.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Voice Clip — macOS clipboard receiver (Tauri app).
//!
//! State machine:
//!   SignedOut  ──[user clicks Sign in]──> opens browser at
//!               <PUBLIC_URL>/desktop/auth/start?state=<one-time>
//!   (browser)  ──[Google OAuth ok]──────> server 302s
//!               voiceclip://callback?token=<t>&state=<same>
//!   deep link  ──[state matches]────────> store token in Keychain,
//!                                          start SSE worker → SignedIn
//!   SignedIn   ──[SSE clip frame]───────> pbcopy + ack + UI preview
//!
//! The webview is a thin view layer (plain HTML/JS). All security-relevant
//! logic (state validation, Keychain, network) lives here in Rust.

mod clipboard;
mod keychain;
mod sse;

use std::sync::Mutex;

use serde::Serialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_deep_link::DeepLinkExt;

use sse::{ConnStatus, SseClient};

/// Server base URL. Baked at build time (`PUBLIC_URL` env) with a sane
/// localhost dev default. The whole pairing + SSE contract is rooted here.
fn public_url() -> String {
    option_env!("PUBLIC_URL")
        .unwrap_or("http://localhost:8080")
        .trim_end_matches('/')
        .to_string()
}

#[derive(Default)]
struct AppState {
    /// The one-time `state` we sent to /desktop/auth/start, awaiting the
    /// matching value back on the voiceclip:// callback (CSRF binding).
    pending_state: Mutex<Option<String>>,
    /// Live SSE worker; present only while SignedIn.
    sse: Mutex<Option<SseClient>>,
    /// Last clip text (truncated) for the tray menu preview item.
    last_clip: Mutex<Option<String>>,
    /// Current connection status for tray icon state.
    conn_status: Mutex<ConnStatus>,
}

#[derive(Clone, Serialize)]
struct StatusEvent {
    status: String,
}

#[derive(Clone, Serialize)]
struct ClipEvent {
    seq: i64,
    text: String,
}

fn status_str(s: ConnStatus) -> &'static str {
    match s {
        ConnStatus::Connecting => "connecting",
        ConnStatus::Connected => "connected",
        ConnStatus::Reconnecting => "reconnecting",
        ConnStatus::Offline => "offline",
    }
}

/// Status-aware tray title (shown next to the icon on macOS).
fn tray_title(s: ConnStatus) -> &'static str {
    match s {
        ConnStatus::Connected => "●",
        ConnStatus::Connecting | ConnStatus::Reconnecting => "◌",
        ConnStatus::Offline => "○",
    }
}

/// Update the tray icon title and tooltip to reflect the current connection state.
fn update_tray(app: &tauri::AppHandle, status: ConnStatus) {
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_title(Some(tray_title(status)));
        let tooltip = match status {
            ConnStatus::Connected => "Voice Clip — Connected",
            ConnStatus::Connecting => "Voice Clip — Connecting…",
            ConnStatus::Reconnecting => "Voice Clip — Reconnecting…",
            ConnStatus::Offline => "Voice Clip — Offline",
        };
        let _ = tray.set_tooltip(Some(tooltip));
    }
}

/// Update the "last clip" item in the tray menu.
fn update_tray_clip(app: &tauri::AppHandle, preview: &str) {
    if let Some(item) = app.menu_item("last-clip") {
        let truncated: String = if preview.len() > 60 {
            let s: String = preview.chars().take(57).collect();
            format!("{s}…")
        } else {
            preview.to_string()
        };
        let _ = item.as_menuitem().map(|m| m.set_text(truncated));
    }
}

/// True iff a device token is already in the Keychain (drives the initial
/// Signed out / Signed in webview render).
#[tauri::command]
fn is_paired() -> bool {
    keychain::load_token().is_some()
}

/// Begin pairing: mint a one-time state, remember it, open the pairing URL
/// in the user's DEFAULT browser (Google OAuth must run in their real
/// browser session, not the embedded webview). Returns the URL too so the
/// UI can show a "didn't open? click here" fallback.
#[tauri::command]
fn begin_pairing(app: tauri::AppHandle, state: State<AppState>) -> Result<String, String> {
    use rand::Rng;
    use tauri_plugin_opener::OpenerExt;
    let nonce: String = {
        let mut rng = rand::thread_rng();
        (0..32)
            .map(|_| format!("{:x}", rng.gen_range(0..16)))
            .collect()
    };
    *state.pending_state.lock().unwrap() = Some(nonce.clone());
    let url = format!("{}/desktop/auth/start?state={}", public_url(), nonce);
    app.opener()
        .open_url(url.clone(), None::<&str>)
        .map_err(|e| format!("open browser: {e}"))?;
    Ok(url)
}

/// Sign out: tear down the SSE worker, forget the Keychain token, and best-
/// effort notify the server to revoke the device registration.
#[tauri::command]
fn sign_out(app: tauri::AppHandle, state: State<AppState>) -> Result<(), String> {
    // Stop the SSE stream first so the token can't race.
    if let Some(client) = state.sse.lock().unwrap().take() {
        client.stop();
    }

    // Best-effort server-side revocation. The route (DELETE /devices/:id) may
    // not exist yet (#9 slice) — ignore 404 and any network errors.
    if let Some(token) = keychain::load_token() {
        let url = format!("{}/devices/me", public_url());
        let _ = std::thread::spawn(move || {
            let client = reqwest::blocking::Client::new();
            let _ = client
                .delete(&url)
                .header("X-Device-Token", &token)
                .send();
        });
    }

    keychain::clear_token()?;

    // Reset tray state.
    *state.last_clip.lock().unwrap() = None;
    *state.conn_status.lock().unwrap() = ConnStatus::Offline;
    update_tray(&app, ConnStatus::Offline);
    if let Some(item) = app.menu_item("last-clip") {
        let _ = item.as_menuitem().map(|m| m.set_text("— no clips yet —"));
    }

    Ok(())
}

/// Enable autostart via the autostart plugin.
#[tauri::command]
fn enable_autostart(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autostart_manager()
        .enable()
        .map_err(|e| format!("enable autostart: {e}"))
}

/// Disable autostart via the autostart plugin.
#[tauri::command]
fn disable_autostart(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autostart_manager()
        .disable()
        .map_err(|e| format!("disable autostart: {e}"))
}

/// Return whether autostart is currently enabled.
#[tauri::command]
fn autostart_enabled(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autostart_manager()
        .is_enabled()
        .map_err(|e| format!("autostart_enabled: {e}"))
}

/// Show (or create) the Settings window.
#[tauri::command]
fn open_settings(app: tauri::AppHandle) -> Result<(), String> {
    show_settings_window(&app);
    Ok(())
}

/// Show or create the Settings webview window.
fn show_settings_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    match WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
        .title("Voice Clip — Settings")
        .inner_size(400.0, 300.0)
        .resizable(false)
        .build()
    {
        Ok(w) => {
            let _ = w.show();
            let _ = w.set_focus();
        }
        Err(e) => eprintln!("settings window: {e}"),
    }
}

/// Handle an incoming `voiceclip://callback?token=&state=` deep link:
/// validate state, persist token, start the SSE worker, flip the UI.
fn handle_deep_link(app: &tauri::AppHandle, url: &str) {
    let parsed = match url::form_from(url) {
        Some(p) => p,
        None => {
            eprintln!("deep-link: unparseable url {url}");
            return;
        }
    };
    let (Some(token), Some(state)) = (parsed.token, parsed.state) else {
        eprintln!("deep-link: missing token/state");
        return;
    };

    let app_state = app.state::<AppState>();
    let expected = app_state.pending_state.lock().unwrap().clone();
    match expected {
        Some(exp) if exp == state => {}
        _ => {
            eprintln!("deep-link: state mismatch — ignoring (possible CSRF)");
            return;
        }
    }
    *app_state.pending_state.lock().unwrap() = None;

    if let Err(e) = keychain::store_token(&token) {
        eprintln!("deep-link: keychain store failed: {e}");
        return;
    }

    start_sse(app);
    let _ = app.emit("paired", ());
    focus_window(app);
}

/// Spawn (or respawn) the SSE worker for the stored token.
fn start_sse(app: &tauri::AppHandle) {
    let Some(token) = keychain::load_token() else {
        return;
    };
    let app_status = app.clone();
    let app_clip = app.clone();
    let client = sse::spawn(
        public_url(),
        token,
        move |s| {
            // Update tray icon/title.
            *app_status.state::<AppState>().conn_status.lock().unwrap() = s;
            update_tray(&app_status, s);
            // Emit to the webview.
            let _ = app_status.emit(
                "status",
                StatusEvent {
                    status: status_str(s).to_string(),
                },
            );
        },
        move |c| {
            let preview: String = c.text.chars().take(140).collect();
            // Update in-memory last clip and tray menu item.
            *app_clip.state::<AppState>().last_clip.lock().unwrap() =
                Some(preview.clone());
            update_tray_clip(&app_clip, &preview);
            // Emit to the webview.
            let _ = app_clip.emit(
                "clip",
                ClipEvent {
                    seq: c.seq,
                    text: preview,
                },
            );
        },
    );
    *app.state::<AppState>().sse.lock().unwrap() = Some(client);
}

fn focus_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Build the tray icon and its context menu.
fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri_plugin_opener::OpenerExt;

    let clip_item = MenuItem::with_id(app, "last-clip", "— no clips yet —", false, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let open_item = MenuItem::with_id(app, "open-app", "Open Voice Clip", true, None::<&str>)?;
    let settings_item = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let updates_item =
        MenuItem::with_id(app, "check-updates", "Check for Updates", true, None::<&str>)?;
    let sep3 = PredefinedMenuItem::separator(app)?;
    let logout_item = MenuItem::with_id(app, "logout", "Logout", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit Voice Clip", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &clip_item,
            &sep1,
            &open_item,
            &settings_item,
            &sep2,
            &updates_item,
            &sep3,
            &logout_item,
            &quit_item,
        ],
    )?;

    let app_handle = app.clone();
    TrayIconBuilder::with_id("main")
        .menu(&menu)
        .title(tray_title(ConnStatus::Offline))
        .tooltip("Voice Clip")
        .on_menu_event(move |app, event| {
            match event.id.as_ref() {
                "open-app" => {
                    focus_window(app);
                }
                "settings" => {
                    show_settings_window(app);
                }
                "check-updates" => {
                    // Placeholder — real updater is issue #9.
                    eprintln!("check-updates: not yet implemented (see issue #9)");
                }
                "logout" => {
                    let state = app.state::<AppState>();
                    if let Some(client) = state.sse.lock().unwrap().take() {
                        client.stop();
                    }
                    if let Some(token) = keychain::load_token() {
                        let url = format!("{}/devices/me", public_url());
                        std::thread::spawn(move || {
                            let client = reqwest::blocking::Client::new();
                            let _ = client
                                .delete(&url)
                                .header("X-Device-Token", &token)
                                .send();
                        });
                    }
                    let _ = keychain::clear_token();
                    *state.last_clip.lock().unwrap() = None;
                    *state.conn_status.lock().unwrap() = ConnStatus::Offline;
                    update_tray(app, ConnStatus::Offline);
                    if let Some(item) = app.menu_item("last-clip") {
                        let _ = item.as_menuitem().map(|m| m.set_text("— no clips yet —"));
                    }
                    // Notify the webview so it flips to signed-out view.
                    let _ = app.emit("signed_out", ());
                    focus_window(app);
                }
                "quit" => {
                    app.exit(0);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(move |tray, event| {
            // Left-click on the tray icon shows the main window (macOS convention).
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                focus_window(tray.app_handle());
            }
        })
        .build(app_handle)?;

    Ok(())
}

/// Tiny query parser for `voiceclip://callback?token=...&state=...`.
/// `url::form_from` lives in a sub-module so it is unit-testable without a
/// running Tauri app.
mod url {
    pub struct Callback {
        pub token: Option<String>,
        pub state: Option<String>,
    }

    fn pct_decode(s: &str) -> String {
        let bytes = s.as_bytes();
        let mut out = Vec::with_capacity(bytes.len());
        let mut i = 0;
        while i < bytes.len() {
            match bytes[i] {
                b'%' if i + 2 < bytes.len() => {
                    let hi = (bytes[i + 1] as char).to_digit(16);
                    let lo = (bytes[i + 2] as char).to_digit(16);
                    if let (Some(h), Some(l)) = (hi, lo) {
                        out.push((h * 16 + l) as u8);
                        i += 3;
                        continue;
                    }
                    out.push(bytes[i]);
                    i += 1;
                }
                b'+' => {
                    out.push(b' ');
                    i += 1;
                }
                b => {
                    out.push(b);
                    i += 1;
                }
            }
        }
        String::from_utf8_lossy(&out).into_owned()
    }

    pub fn form_from(url: &str) -> Option<Callback> {
        // Accept anything with a query string; the scheme/host are fixed by
        // the OS URL-scheme registration.
        let q = url.split_once('?').map(|(_, q)| q)?;
        let mut token = None;
        let mut state = None;
        for pair in q.split('&') {
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            match k {
                "token" => token = Some(pct_decode(v)),
                "state" => state = Some(pct_decode(v)),
                _ => {}
            }
        }
        Some(Callback { token, state })
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn parses_token_and_state() {
            let c = form_from("voiceclip://callback?token=abc123&state=xyz").unwrap();
            assert_eq!(c.token.as_deref(), Some("abc123"));
            assert_eq!(c.state.as_deref(), Some("xyz"));
        }

        #[test]
        fn percent_decodes_values() {
            let c = form_from("voiceclip://callback?token=a%2Fb&state=s%20t").unwrap();
            assert_eq!(c.token.as_deref(), Some("a/b"));
            assert_eq!(c.state.as_deref(), Some("s t"));
        }

        #[test]
        fn missing_query_is_none() {
            assert!(form_from("voiceclip://callback").is_none());
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            is_paired,
            begin_pairing,
            sign_out,
            enable_autostart,
            disable_autostart,
            autostart_enabled,
            open_settings
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // Build the tray icon + menu.
            build_tray(&handle)?;

            // Cold-start deep link (app launched BY the voiceclip:// URL).
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                for u in urls {
                    handle_deep_link(&handle, u.as_str());
                }
            }

            // Warm deep links (app already running).
            let dl_handle = handle.clone();
            app.deep_link().on_open_url(move |event| {
                for u in event.urls() {
                    handle_deep_link(&dl_handle, u.as_str());
                }
            });

            // If already paired, immediately resume the SSE stream.
            if keychain::load_token().is_some() {
                start_sse(&handle);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Voice Clip");
}
