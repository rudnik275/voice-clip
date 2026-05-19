//! Write text to the macOS clipboard via `pbcopy`.
//!
//! We shell out to the system `pbcopy` (rather than an in-process clipboard
//! crate) deliberately: it is the exact mechanism the original Mac-local
//! daemon used, behaves identically for every text encoding, and needs zero
//! extra native dependencies.

use std::io::Write;
use std::process::{Command, Stdio};

/// Pipe `text` into `pbcopy`. Returns an error string on spawn / write /
/// non-zero-exit failure so the caller can decide whether to retry.
pub fn pbcopy(text: &str) -> Result<(), String> {
    // pbcopy decodes stdin using the locale's charset. A GUI app launched
    // by LaunchServices inherits no LANG/LC_*, so Cyrillic UTF-8 bytes get
    // mangled into garbage. Force UTF-8 for the child.
    let mut child = Command::new("pbcopy")
        .env("LC_CTYPE", "UTF-8")
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn pbcopy: {e}"))?;

    {
        let stdin = child
            .stdin
            .as_mut()
            .ok_or_else(|| "pbcopy: stdin unavailable".to_string())?;
        stdin
            .write_all(text.as_bytes())
            .map_err(|e| format!("write pbcopy stdin: {e}"))?;
    }

    let status = child
        .wait()
        .map_err(|e| format!("wait pbcopy: {e}"))?;
    if !status.success() {
        return Err(format!("pbcopy exited with status {status}"));
    }
    Ok(())
}
