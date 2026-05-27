//! macOS Keychain storage for the paired device token.
//!
//! The device token is the long-lived bearer the server issued at pairing
//! (`voiceclip://callback?token=<...>`). It must survive app restarts and
//! must never sit in plaintext on disk, so it lives in the login Keychain
//! via the `keyring` crate (which wraps the macOS Security framework).
//!
//! service = "com.voiceclip.desktop" in release builds, suffixed with
//! ".dev" in debug builds. Keychain ACLs are per-binary-codesignature on
//! macOS: an unsigned `cargo tauri dev` binary touching the production
//! signed-app's entry prompts the user for their login password. Splitting
//! the service name keeps debug builds out of the prod entry so the prompt
//! never appears — debug pairs once into its own entry and stays there.

use keyring::Entry;

#[cfg(debug_assertions)]
const SERVICE: &str = "com.voiceclip.desktop.dev";
#[cfg(not(debug_assertions))]
const SERVICE: &str = "com.voiceclip.desktop";

const ACCOUNT: &str = "device_token";

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, ACCOUNT).map_err(|e| format!("keychain entry: {e}"))
}

/// Persist the device token in the macOS Keychain (overwrites any existing).
pub fn store_token(token: &str) -> Result<(), String> {
    entry()?
        .set_password(token)
        .map_err(|e| format!("keychain store: {e}"))
}

/// Read the device token back, or `None` if the app was never paired.
pub fn load_token() -> Option<String> {
    let e = entry().ok()?;
    match e.get_password() {
        Ok(t) if !t.is_empty() => Some(t),
        _ => None,
    }
}

/// Remove the stored token (sign-out / unpair). Missing entry is not an error.
pub fn clear_token() -> Result<(), String> {
    let e = entry()?;
    match e.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keychain clear: {e}")),
    }
}
