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
use tauri::{Emitter, Manager, State};
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

/// Sign out: tear down the SSE worker and forget the Keychain token.
#[tauri::command]
fn sign_out(state: State<AppState>) -> Result<(), String> {
    if let Some(client) = state.sse.lock().unwrap().take() {
        client.stop();
    }
    keychain::clear_token()
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
            let _ = app_status.emit(
                "status",
                StatusEvent {
                    status: status_str(s).to_string(),
                },
            );
        },
        move |c| {
            let preview: String = c.text.chars().take(140).collect();
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
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            is_paired,
            begin_pairing,
            sign_out
        ])
        .setup(|app| {
            let handle = app.handle().clone();

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
