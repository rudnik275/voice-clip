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
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

use sse::{ConnStatus, SseClient};

/// Server base URL. Baked at build time (`PUBLIC_URL` env) with a sane
/// localhost dev default. The whole pairing + SSE contract is rooted here.
fn public_url() -> String {
    // Baked at COMPILE time. Default to production so a release can never
    // accidentally ship pointing at localhost (it did in 0.2.3 — CI didn't
    // set PUBLIC_URL). Local dev overrides:
    //   PUBLIC_URL=http://localhost:8080 cargo tauri dev
    option_env!("PUBLIC_URL")
        .unwrap_or("https://voice.rudifamily.uk")
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
    /// Handle to the tray menu's "last clip" item so its label can be
    /// updated in place — Tauri 2 has no by-id menu-item lookup on AppHandle.
    clip_item: Mutex<Option<MenuItem<tauri::Wry>>>,
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

/// Reflect the current connection state in the tray tooltip. The icon
/// itself is a static mic template (no status glyph in the menu bar).
fn update_tray(app: &tauri::AppHandle, status: ConnStatus) {
    if let Some(tray) = app.tray_by_id("main") {
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
    let truncated: String = if preview.chars().count() > 60 {
        let s: String = preview.chars().take(57).collect();
        format!("{s}…")
    } else {
        preview.to_string()
    };
    if let Some(item) = app.state::<AppState>().clip_item.lock().unwrap().as_ref() {
        let _ = item.set_text(truncated);
    }
}

/// True iff a device token is already in the Keychain (drives the initial
/// Signed out / Signed in webview render).
#[tauri::command]
fn is_paired() -> bool {
    keychain::load_token().is_some()
}

/// The opaque device_token from the macOS Keychain, or None if not paired.
/// Used by the bundled PWA bundle running inside the webview to authenticate
/// `/me`, `/upload`, `/history`, `/cost` against the server with the
/// `X-Device-Token` header (the cookie-based session flow doesn't apply
/// inside the Tauri webview — there's no Google OAuth round-trip here).
#[tauri::command]
fn get_device_token() -> Option<String> {
    keychain::load_token()
}

/// App data dir (created on demand); falls back to the temp dir.
fn diag_dir(app: &tauri::AppHandle) -> std::path::PathBuf {
    let d = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    let _ = std::fs::create_dir_all(&d);
    d
}

/// Persisted CSRF nonce — survives the process boundary so the instance
/// that receives the voiceclip:// callback can validate it even if it is
/// not the instance that started pairing (macOS cold-launches a fresh
/// instance for the URL scheme).
fn state_file(app: &tauri::AppHandle) -> std::path::PathBuf {
    diag_dir(app).join("pending_state")
}

/// Append a line to the deep-link debug log AND stderr. Temporary
/// instrumentation while the macOS pairing handshake is being stabilised.
fn dlog(app: &tauri::AppHandle, msg: &str) {
    use std::io::Write;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let line = format!("[{ts}] {msg}");
    eprintln!("{line}");
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(diag_dir(app).join("deeplink-debug.log"))
    {
        let _ = writeln!(f, "{line}");
    }
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
    // Persist so a different instance can still validate the callback.
    if let Err(e) = std::fs::write(state_file(&app), &nonce) {
        dlog(&app, &format!("begin_pairing: state-file write failed: {e}"));
    }
    dlog(&app, &format!("begin_pairing: nonce={nonce}"));
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
    if let Some(item) = app.state::<AppState>().clip_item.lock().unwrap().as_ref() {
        let _ = item.set_text("— no clips yet —");
    }

    Ok(())
}

/// Enable autostart via the autostart plugin.
#[tauri::command]
fn enable_autostart(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch()
        .enable()
        .map_err(|e| format!("enable autostart: {e}"))
}

/// Disable autostart via the autostart plugin.
#[tauri::command]
fn disable_autostart(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch()
        .disable()
        .map_err(|e| format!("disable autostart: {e}"))
}

/// Return whether autostart is currently enabled.
#[tauri::command]
fn autostart_enabled(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch()
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
    dlog(app, &format!("handle_deep_link: received url={url}"));
    let parsed = match url::form_from(url) {
        Some(p) => p,
        None => {
            dlog(app, &format!("deep-link: unparseable url {url}"));
            return;
        }
    };
    let (Some(token), Some(state)) = (parsed.token, parsed.state) else {
        dlog(app, "deep-link: missing token/state");
        return;
    };
    dlog(
        app,
        &format!("deep-link: parsed state={state} token_len={}", token.len()),
    );

    // Expected nonce: in-memory first, else the persisted file (the
    // receiving instance may not be the one that started pairing).
    let app_state = app.state::<AppState>();
    let mem = app_state.pending_state.lock().unwrap().clone();
    let from_file = std::fs::read_to_string(state_file(app))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let expected = mem.clone().or_else(|| from_file.clone());
    dlog(
        app,
        &format!(
            "deep-link: expected mem={mem:?} file={from_file:?} got={state}"
        ),
    );
    match &expected {
        Some(exp) if *exp == state => {}
        _ => {
            dlog(app, "deep-link: state mismatch — ignoring (possible CSRF)");
            return;
        }
    }
    *app_state.pending_state.lock().unwrap() = None;
    let _ = std::fs::remove_file(state_file(app));

    // keychain::store_token() blocks on a MODAL macOS auth dialog. Deep-link
    // callbacks run on the Tauri event-loop thread, so doing this inline
    // froze the whole app while the "Allow" dialog was up ("not responding",
    // needed a reboot). Run the blocking keychain + SSE work on a worker.
    let app_bg = app.clone();
    std::thread::spawn(move || {
        if let Err(e) = keychain::store_token(&token) {
            dlog(&app_bg, &format!("deep-link: keychain store failed: {e}"));
            return;
        }
        dlog(&app_bg, "deep-link: token stored — starting SSE, emitting paired");
        start_sse(&app_bg);
        let _ = app_bg.emit("paired", ());
        let app_ui = app_bg.clone();
        let _ = app_bg.run_on_main_thread(move || focus_window(&app_ui));
    });
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
    let clip_item = MenuItem::with_id(app, "last-clip", "— no clips yet —", false, None::<&str>)?;
    *app.state::<AppState>().clip_item.lock().unwrap() = Some(clip_item.clone());
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

    let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
    TrayIconBuilder::with_id("main")
        .menu(&menu)
        .icon(tray_icon)
        .icon_as_template(true)
        .tooltip("Voice Clip — Offline")
        .on_menu_event(move |app, event| {
            match event.id.as_ref() {
                "open-app" => {
                    focus_window(app);
                }
                "settings" => {
                    show_settings_window(app);
                }
                "check-updates" => {
                    // Run off the main thread: updater I/O is async and the
                    // dialog `blocking_show()` calls below MUST NOT run on the
                    // UI thread (they dispatch UI to it and would deadlock).
                    let handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let notify = |kind: MessageDialogKind, title: &str, body: String| {
                            handle
                                .dialog()
                                .message(body)
                                .title(title)
                                .kind(kind)
                                .blocking_show();
                        };

                        let updater = match handle.updater() {
                            Ok(u) => u,
                            Err(e) => {
                                notify(
                                    MessageDialogKind::Error,
                                    "Voice Clip",
                                    format!("Could not start the updater: {e}"),
                                );
                                return;
                            }
                        };

                        match updater.check().await {
                            Ok(Some(update)) => {
                                let version = update.version.clone();
                                // Ask before pulling ~11 MB + restarting.
                                let install = handle
                                    .dialog()
                                    .message(format!(
                                        "Version {version} is available. Download and restart now?"
                                    ))
                                    .title("Update available")
                                    .buttons(MessageDialogButtons::OkCancelCustom(
                                        "Install".to_string(),
                                        "Later".to_string(),
                                    ))
                                    .blocking_show();
                                if !install {
                                    return;
                                }
                                match update
                                    .download_and_install(|_chunk, _total| {}, || {})
                                    .await
                                {
                                    Ok(()) => {
                                        notify(
                                            MessageDialogKind::Info,
                                            "Update installed",
                                            format!(
                                                "Voice Clip {version} is installed. The app will now restart."
                                            ),
                                        );
                                        // Replace the running (old) process with
                                        // the freshly-installed bundle — without
                                        // this the update sits on disk until the
                                        // user manually quits and reopens, which
                                        // looked like "nothing happened".
                                        handle.restart();
                                    }
                                    Err(e) => {
                                        notify(
                                            MessageDialogKind::Error,
                                            "Update failed",
                                            format!("Could not install the update: {e}"),
                                        );
                                    }
                                }
                            }
                            Ok(None) => {
                                notify(
                                    MessageDialogKind::Info,
                                    "Voice Clip",
                                    "You're already on the latest version.".to_string(),
                                );
                            }
                            Err(e) => {
                                notify(
                                    MessageDialogKind::Error,
                                    "Voice Clip",
                                    format!("Could not check for updates: {e}"),
                                );
                            }
                        }
                    });
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
                    if let Some(item) =
                        app.state::<AppState>().clip_item.lock().unwrap().as_ref()
                    {
                        let _ = item.set_text("— no clips yet —");
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
        .build(app)?;

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
        // MUST be the first plugin. Without it, macOS cold-launches a fresh
        // app instance for a voiceclip:// callback — that instance has an
        // empty AppState (pending_state = None), so the CSRF check rejects
        // the deep link and pairing silently fails. With the "deep-link"
        // feature, single-instance forwards the URL to the already-running
        // instance (which holds pending_state) and we just refocus.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // Closing the window must NOT quit — this is a menu-bar app. Hide
        // it instead; reopen via the tray "Open Voice Clip" item.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            is_paired,
            get_device_token,
            begin_pairing,
            sign_out,
            enable_autostart,
            disable_autostart,
            autostart_enabled,
            open_settings
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            dlog(&handle, &format!("setup: pid={} starting", std::process::id()));

            // Build the tray icon + menu.
            build_tray(&handle)?;

            // Cold-start deep link (app launched BY the voiceclip:// URL).
            match app.deep_link().get_current() {
                Ok(Some(urls)) => {
                    dlog(&handle, &format!("setup: get_current() -> {} url(s)", urls.len()));
                    for u in urls {
                        handle_deep_link(&handle, u.as_str());
                    }
                }
                Ok(None) => dlog(&handle, "setup: get_current() -> none"),
                Err(e) => dlog(&handle, &format!("setup: get_current() err: {e}")),
            }

            // Warm deep links (app already running).
            let dl_handle = handle.clone();
            app.deep_link().on_open_url(move |event| {
                let urls: Vec<_> = event.urls();
                dlog(&dl_handle, &format!("on_open_url fired: {} url(s)", urls.len()));
                for u in urls {
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
