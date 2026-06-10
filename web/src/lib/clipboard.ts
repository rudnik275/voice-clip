/**
 * Gesture-safe clipboard helper.
 *
 * On iOS Safari the Clipboard API requires the write to be initiated
 * synchronously inside a user-gesture event handler. When the text isn't
 * available yet (e.g. it comes from a network call) you must arm a pending
 * ClipboardItem whose `text/plain` slot is a Promise<Blob>, then resolve
 * that Promise once the text arrives — all of this wired up during the click.
 *
 * Usage:
 *
 *   // Inside the click handler (synchronous):
 *   const write = armClipboardWrite()
 *
 *   // Later (async), after you have the text:
 *   const ok = await write.finish(text)
 *   if (ok) { showSuccess() } else { showFallback(text) }
 *
 * `finish` returns `true` when the clipboard write resolved, `false` on any
 * failure (permission denied, API absent, Promise rejected internally).
 */
export interface ClipboardWrite {
  /** Resolve with the text to copy.  Returns true if the write succeeded. */
  finish(text: string): Promise<boolean>
}

/**
 * Arms a clipboard write during a user gesture.
 *
 * When `ClipboardItem` is available (Chrome, Safari 13.1+) the write is
 * initiated synchronously inside the gesture by handing the browser a
 * ClipboardItem over a pending Promise.  The Promise is resolved later by
 * `finish(text)`.
 *
 * When `ClipboardItem` is not available (older browsers, non-secure contexts)
 * the write is deferred entirely to `finish()` via the `writeText` fallback.
 */
export function armClipboardWrite(): ClipboardWrite {
  // Tracks whether the ClipboardItem write resolved
  let clipboardItemWritten = false

  // The resolve/reject handles for the pending text promise
  let pendingResolve: ((text: string) => void) | null = null
  let pendingReject: (() => void) | null = null

  // Whether we successfully armed a ClipboardItem
  let armedWithItem = false

  const textPromise = new Promise<string>((resolve, reject) => {
    pendingResolve = resolve
    pendingReject = reject
  })
  // Suppress unhandled-rejection warnings if finish() is never called or
  // called with an error.
  textPromise.catch(() => {})

  try {
    if (
      typeof ClipboardItem !== 'undefined' &&
      navigator.clipboard &&
      'write' in navigator.clipboard
    ) {
      const item = new ClipboardItem({
        'text/plain': textPromise.then((t) => new Blob([t], { type: 'text/plain' })),
      })
      void navigator.clipboard
        .write([item])
        .then(() => {
          clipboardItemWritten = true
        })
        .catch(() => {})
      armedWithItem = true
    }
  } catch {
    // ClipboardItem constructor threw (e.g. in a test environment) — fall through
    armedWithItem = false
  }

  return {
    async finish(text: string): Promise<boolean> {
      if (armedWithItem) {
        // Resolve the pending Promise to trigger the ClipboardItem write
        pendingResolve!(text)
        pendingResolve = null
        pendingReject = null

        // Give the browser a tick to process the clipboard write
        await Promise.resolve()

        if (clipboardItemWritten) {
          return true
        }
        // ClipboardItem write didn't resolve yet (or failed) — try writeText
        try {
          await navigator.clipboard.writeText(text)
          return true
        } catch {
          return false
        }
      } else {
        // No ClipboardItem support: attempt writeText directly
        pendingReject?.()
        pendingResolve = null
        pendingReject = null
        try {
          if (!navigator.clipboard) return false
          await navigator.clipboard.writeText(text)
          return true
        } catch {
          return false
        }
      }
    },
  }
}
