//! Long-lived SSE client for `GET /events` (authenticated via `X-Device-Token`
//! header).
//!
//! Runs on a dedicated std thread (blocking reqwest) so the never-ending
//! stream read never blocks Tauri's event loop. On every `data:` frame it
//! parses the clip JSON, deduplicates by `seq`, `pbcopy`s the text for new
//! clips, then `POST /events/ack`s the seq back so the server deletes the
//! pending delivery row and does not replay the clip on the next reconnect.
//!
//! ## At-least-once delivery contract
//!
//! The server keeps a `pending_deliveries` row for every clip until the client
//! POSTs `/events/ack` with the matching `seq`. On reconnect all un-acked rows
//! are replayed (oldest-first). To avoid double pbcopy the worker tracks the
//! highest `seq` it has already written to the clipboard (`last_copied_seq`).
//! For a replayed frame whose `seq <= last_copied_seq`, the clipboard is left
//! untouched but the ack is still sent so the server discards the row.
//!
//! ## Ack reliability
//!
//! A failed ack means the server will replay the clip on the next reconnect.
//! The dedupe guard makes that safe, but unnecessary round-trips are wasteful.
//! `ack_with_retry` retries up to `ACK_MAX_ATTEMPTS` times with short backoff
//! before giving up — the next reconnect's replay + dedupe is the last-resort
//! safety net.
//!
//! Reconnect: full-jitter exponential backoff, base 1s, doubling, capped at
//! 30s. Any disconnect (network drop, server restart, idle timeout) loops
//! back into a fresh connect attempt — the connection is meant to be held
//! "forever" while the Mac is online.
//!
//! Liveness: TCP keepalive (`TCP_KEEPALIVE_*`) backstops silent half-open
//! connections (sleep/wake, Wi-Fi switch, a proxy dropping the socket without
//! a FIN). The server's 25s heartbeat keeps a live socket from ever idling long
//! enough to probe, so a failed probe means the connection is dead → read error
//! → break → reconnect, instead of parking forever while clips quietly stop.

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
/// Number of ack POST attempts before giving up (initial try + retries).
const ACK_MAX_ATTEMPTS: u32 = 3;
/// Backoff delays between ack attempts (milliseconds): 250ms, 500ms, 1s.
const ACK_RETRY_DELAYS_MS: &[u64] = &[250, 500, 1_000];
/// TCP keepalive — detects half-open connections. Idle time before the OS
/// starts probing a quiet socket. The server's 25s `: ping` heartbeat resets
/// the idle timer on every live stream, so a probe only ever fires on a stream
/// that has genuinely gone silent.
const TCP_KEEPALIVE_IDLE: Duration = Duration::from_secs(20);
/// Interval between keepalive probes once the socket is deemed idle.
const TCP_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(10);
/// Unanswered probes before the OS tears the socket down — ≈50s end-to-end to
/// detect a dead link (20s idle + 3×10s), after which the read errors out and
/// the loop reconnects.
const TCP_KEEPALIVE_RETRIES: u32 = 3;

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
    /// The device_token was rejected (401/403) — terminal, the loop stops.
    Unauthorized,
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
/// `on_clip` after each successful pbcopy. `on_auth_failure` fires once if the
/// server rejects the device_token (401/403) — the token is dead server-side
/// (the device was revoked), so retrying is pointless: the loop surfaces it and
/// exits instead of polling a revoked token forever. All three run on the
/// worker thread.
pub fn spawn<S, C, A>(
    base_url: String,
    device_token: String,
    on_status: S,
    on_clip: C,
    on_auth_failure: A,
) -> SseClient
where
    S: Fn(ConnStatus) + Send + 'static,
    C: Fn(&Clip) + Send + 'static,
    A: Fn() + Send + 'static,
{
    let stop = Arc::new(AtomicBool::new(false));
    let stop_thread = stop.clone();

    thread::spawn(move || {
        let client = reqwest::blocking::Client::builder()
            // No overall request timeout — SSE is a long-lived stream, and
            // reqwest's blocking builder has no per-read timeout. Instead we
            // lean on TCP keepalive to spot half-open connections (Mac slept,
            // Wi-Fi switched, a proxy dropped the socket without a FIN). Without
            // it the blocking read parks forever, the status stays "Connected",
            // and clips silently stop arriving (Cmd+V "sometimes doesn't
            // work"). The server's 25s `: ping` heartbeat keeps a LIVE socket
            // from ever idling long enough to probe, so keepalive only tears
            // down genuinely dead links — the failed probe surfaces as a read
            // error → break → reconnect.
            .timeout(None)
            .tcp_keepalive(TCP_KEEPALIVE_IDLE)
            .tcp_keepalive_interval(TCP_KEEPALIVE_INTERVAL)
            .tcp_keepalive_retries(TCP_KEEPALIVE_RETRIES)
            .build()
            .expect("build reqwest client");

        let mut attempt: u32 = 0;
        // Tracks the highest seq we have already written to the clipboard,
        // persisted across reconnects within this process lifetime. Replayed
        // frames (seq <= last_copied_seq) skip pbcopy but are still acked so
        // the server removes the pending row and does not replay again.
        let mut last_copied_seq: i64 = -1;

        while !stop_thread.load(Ordering::SeqCst) {
            on_status(if attempt == 0 {
                ConnStatus::Connecting
            } else {
                ConnStatus::Reconnecting
            });

            let url = format!("{}/events", base_url.trim_end_matches('/'));

            match client
                .get(&url)
                .header("X-Device-Token", &device_token)
                .send()
            {
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
                                let action = dedupe_action(clip.seq, last_copied_seq);
                                match action {
                                    ClipAction::Copy => {
                                        if pbcopy(&clip.text).is_ok() {
                                            last_copied_seq = clip.seq;
                                            ack_with_retry(
                                                &client,
                                                &base_url,
                                                &device_token,
                                                clip.seq,
                                            );
                                            on_clip(&clip);
                                        }
                                        // If pbcopy failed we don't ack — the
                                        // server will replay and we'll try again.
                                    }
                                    ClipAction::AckOnly => {
                                        // Already copied in a previous connection;
                                        // just ack so the server drops the pending row.
                                        eprintln!(
                                            "sse: seq {} already copied (last={}), skipping pbcopy",
                                            clip.seq, last_copied_seq
                                        );
                                        ack_with_retry(
                                            &client,
                                            &base_url,
                                            &device_token,
                                            clip.seq,
                                        );
                                    }
                                }
                            }
                            Err(e) => {
                                eprintln!("sse: bad clip json: {e}");
                            }
                        }
                    }
                    // Stream ended (server closed / network blip) → reconnect.
                }
                Ok(resp) if resp.status() == 401 || resp.status() == 403 => {
                    // The device_token was rejected — almost always because the
                    // device was revoked server-side. Device tokens never
                    // expire, so this is terminal: do NOT retry (that would
                    // poll a dead token forever and keep the tray "Offline").
                    // Surface it so the app drops to the signed-out state.
                    eprintln!("sse: auth rejected ({}) — stopping", resp.status());
                    on_status(ConnStatus::Unauthorized);
                    on_auth_failure();
                    return;
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

/// Whether a clip should be written to the clipboard or only acked.
#[derive(Debug, PartialEq, Eq)]
enum ClipAction {
    /// New seq — write to clipboard and ack.
    Copy,
    /// Already-seen seq (replayed by the server) — skip clipboard, still ack.
    AckOnly,
}

/// Pure dedupe decision: given the incoming `seq` and the highest seq we have
/// already copied, decide what to do. Extracted into a pure function so it can
/// be unit-tested without any I/O.
fn dedupe_action(seq: i64, last_copied_seq: i64) -> ClipAction {
    if seq <= last_copied_seq {
        ClipAction::AckOnly
    } else {
        ClipAction::Copy
    }
}

/// Delivery ack with retry. POSTs `/events/ack` up to `ACK_MAX_ATTEMPTS` times
/// with short backoff on transport failure or a non-2xx response. A failed ack
/// means the server will replay the clip on the next reconnect; the dedupe guard
/// (`last_copied_seq`) makes that safe without touching the clipboard twice.
fn ack_with_retry(client: &reqwest::blocking::Client, base_url: &str, token: &str, seq: i64) {
    let url = format!("{}/events/ack", base_url.trim_end_matches('/'));
    let body = serde_json::json!({ "seq": seq }).to_string();

    for attempt in 0..ACK_MAX_ATTEMPTS {
        if attempt > 0 {
            let delay_ms = ACK_RETRY_DELAYS_MS
                .get((attempt - 1) as usize)
                .copied()
                .unwrap_or(1_000);
            thread::sleep(Duration::from_millis(delay_ms));
        }
        match client
            .post(&url)
            .header("X-Device-Token", token)
            .header("content-type", "application/json")
            .body(body.clone())
            .send()
        {
            Ok(resp) if resp.status().is_success() => return,
            Ok(resp) => {
                eprintln!(
                    "sse: ack seq={seq} attempt={attempt} failed with status {}",
                    resp.status()
                );
            }
            Err(e) => {
                eprintln!("sse: ack seq={seq} attempt={attempt} transport error: {e}");
            }
        }
    }
    eprintln!(
        "sse: ack seq={seq} gave up after {ACK_MAX_ATTEMPTS} attempts — \
         server will replay; dedupe guard will skip pbcopy"
    );
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
    fn clip_json_deserializes() {
        let c: Clip =
            serde_json::from_str(r#"{"seq":42,"text":"привет","source":"online"}"#).unwrap();
        assert_eq!(c.seq, 42);
        assert_eq!(c.text, "привет");
        assert_eq!(c.source, "online");
    }

    // --- dedupe_action unit tests ---

    #[test]
    fn new_seq_when_no_prior_copy() {
        // No clip copied yet (last = -1); any real seq should be copied.
        assert_eq!(dedupe_action(0, -1), ClipAction::Copy);
        assert_eq!(dedupe_action(1, -1), ClipAction::Copy);
        assert_eq!(dedupe_action(100, -1), ClipAction::Copy);
    }

    #[test]
    fn new_seq_advances_past_last() {
        // A seq strictly greater than last_copied_seq → Copy.
        assert_eq!(dedupe_action(6, 5), ClipAction::Copy);
        assert_eq!(dedupe_action(100, 99), ClipAction::Copy);
    }

    #[test]
    fn exact_same_seq_is_ack_only() {
        // The same seq replayed from the server → AckOnly (do NOT touch the clipboard).
        assert_eq!(dedupe_action(5, 5), ClipAction::AckOnly);
        assert_eq!(dedupe_action(1, 1), ClipAction::AckOnly);
    }

    #[test]
    fn older_seq_is_ack_only() {
        // An older seq (gap in replay) → AckOnly.
        assert_eq!(dedupe_action(3, 5), ClipAction::AckOnly);
        assert_eq!(dedupe_action(0, 10), ClipAction::AckOnly);
    }

    #[test]
    fn simulate_replay_after_reconnect() {
        // Scenario: process copied seqs 1, 2, 3 before disconnect.
        // On reconnect the server replays 2, 3 (not yet acked), then streams 4.
        // Expected: 2 and 3 → AckOnly; 4 → Copy.
        let last = 3_i64;
        assert_eq!(dedupe_action(2, last), ClipAction::AckOnly);
        assert_eq!(dedupe_action(3, last), ClipAction::AckOnly);
        assert_eq!(dedupe_action(4, last), ClipAction::Copy);
    }
}
