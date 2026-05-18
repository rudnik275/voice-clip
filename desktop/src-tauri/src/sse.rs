//! Long-lived SSE client for `GET /events?device_token=<token>`.
//!
//! Runs on a dedicated std thread (blocking reqwest) so the never-ending
//! stream read never blocks Tauri's event loop. On every `data:` frame it
//! parses the clip JSON, `pbcopy`s the text, then `POST /events/ack`s the
//! seq back so the server can track delivery liveness.
//!
//! Reconnect: full-jitter exponential backoff, base 1s, doubling, capped at
//! 30s. Any disconnect (network drop, server restart, idle timeout) loops
//! back into a fresh connect attempt — the connection is meant to be held
//! "forever" while the Mac is online.

use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use rand::Rng;
use serde::Deserialize;

use crate::clipboard::pbcopy;

const BACKOFF_BASE_MS: u64 = 1_000;
const BACKOFF_CAP_MS: u64 = 30_000;

/// The clip frame the server fans out on `/upload` (see live-bus.publish).
#[derive(Debug, Deserialize)]
pub struct Clip {
    pub seq: i64,
    pub text: String,
    /// Server frame carries "online"/"offline"; the desktop receiver
    /// pbcopy's regardless, so this is kept only to document the contract.
    #[serde(default)]
    #[allow(dead_code)]
    pub source: String,
}

/// Connection lifecycle, surfaced to the webview as Connected / Reconnecting
/// / Offline plus the last clip preview.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ConnStatus {
    Connecting,
    Connected,
    Reconnecting,
    #[default]
    Offline,
}

/// Full-jitter backoff: random in `[0, min(cap, base * 2^attempt))`.
fn backoff_delay(attempt: u32) -> Duration {
    let exp = BACKOFF_BASE_MS.saturating_mul(1u64 << attempt.min(20));
    let ceil = exp.min(BACKOFF_CAP_MS).max(1);
    let jittered = rand::thread_rng().gen_range(0..ceil);
    Duration::from_millis(jittered)
}

/// Handle to a running SSE worker. Drop / `stop()` to tear it down (e.g. on
/// sign-out).
pub struct SseClient {
    stop: Arc<AtomicBool>,
}

impl SseClient {
    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

impl Drop for SseClient {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Spawn the reconnect loop. `on_status` is invoked on every state change;
/// `on_clip` after each successful pbcopy. Both run on the worker thread.
pub fn spawn<S, C>(
    base_url: String,
    device_token: String,
    on_status: S,
    on_clip: C,
) -> SseClient
where
    S: Fn(ConnStatus) + Send + 'static,
    C: Fn(&Clip) + Send + 'static,
{
    let stop = Arc::new(AtomicBool::new(false));
    let stop_thread = stop.clone();

    thread::spawn(move || {
        let client = reqwest::blocking::Client::builder()
            // Never time out the read — SSE is an idle-tolerant long poll.
            .timeout(None)
            .build()
            .expect("build reqwest client");

        let mut attempt: u32 = 0;
        while !stop_thread.load(Ordering::SeqCst) {
            on_status(if attempt == 0 {
                ConnStatus::Connecting
            } else {
                ConnStatus::Reconnecting
            });

            let url = format!(
                "{}/events?device_token={}",
                base_url.trim_end_matches('/'),
                urlencode(&device_token)
            );

            match client.get(&url).send() {
                Ok(resp) if resp.status().is_success() => {
                    attempt = 0;
                    on_status(ConnStatus::Connected);
                    let reader = BufReader::new(resp);
                    for line in reader.lines() {
                        if stop_thread.load(Ordering::SeqCst) {
                            return;
                        }
                        let Ok(line) = line else { break };
                        // SSE: data lines start with "data:"; ":" lines are
                        // comments/keep-alives; blank lines end an event.
                        let Some(payload) = line.strip_prefix("data:") else {
                            continue;
                        };
                        let payload = payload.trim();
                        if payload.is_empty() {
                            continue;
                        }
                        match serde_json::from_str::<Clip>(payload) {
                            Ok(clip) => {
                                if pbcopy(&clip.text).is_ok() {
                                    ack(&client, &base_url, &device_token, clip.seq);
                                    on_clip(&clip);
                                }
                            }
                            Err(e) => {
                                eprintln!("sse: bad clip json: {e}");
                            }
                        }
                    }
                    // Stream ended (server closed / network blip) → reconnect.
                }
                Ok(resp) => {
                    eprintln!("sse: server returned {}", resp.status());
                }
                Err(e) => {
                    eprintln!("sse: connect failed: {e}");
                }
            }

            if stop_thread.load(Ordering::SeqCst) {
                return;
            }
            on_status(ConnStatus::Offline);
            thread::sleep(backoff_delay(attempt));
            attempt = attempt.saturating_add(1);
        }
    });

    SseClient { stop }
}

/// Best-effort delivery ack. A failed ack is non-fatal — the clip is already
/// on the clipboard; the server only uses the ack for liveness.
fn ack(client: &reqwest::blocking::Client, base_url: &str, token: &str, seq: i64) {
    let url = format!("{}/events/ack", base_url.trim_end_matches('/'));
    let _ = client
        .post(&url)
        .header("X-Device-Token", token)
        .header("content-type", "application/json")
        .body(serde_json::json!({ "seq": seq }).to_string())
        .send();
}

/// Minimal percent-encoding for the token query value (hex tokens are
/// already URL-safe; this is defensive against any non-hex token shape).
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_is_zero_to_cap_and_grows() {
        // attempt 0 → ceil 1s; attempt large → ceil 30s; always < cap.
        for attempt in 0..10 {
            let d = backoff_delay(attempt).as_millis() as u64;
            assert!(d <= BACKOFF_CAP_MS, "attempt {attempt} exceeded cap: {d}");
        }
    }

    #[test]
    fn urlencode_passes_hex_through_untouched() {
        let tok = "deadbeef0123456789abcdef";
        assert_eq!(urlencode(tok), tok);
    }

    #[test]
    fn urlencode_escapes_unsafe_bytes() {
        assert_eq!(urlencode("a/b c"), "a%2Fb%20c");
    }

    #[test]
    fn clip_json_deserializes() {
        let c: Clip =
            serde_json::from_str(r#"{"seq":42,"text":"привет","source":"online"}"#).unwrap();
        assert_eq!(c.seq, 42);
        assert_eq!(c.text, "привет");
        assert_eq!(c.source, "online");
    }
}
