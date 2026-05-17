// In-memory pub/sub for live SSE delivery, keyed by device_id.
//
// Each connected Mac app holds one long-lived GET /events SSE stream. The
// server registers that stream's ReadableStream controller here under the
// device's id. When a phone uploads a clip, /upload walks the user's devices
// and calls publish(device.id, clip) — every currently-connected Mac for
// that user gets the frame instantly.
//
// This is intentionally process-local and ephemeral: a Mac that is offline
// when the clip is dictated simply does not receive it (pending-clip replay
// for offline Macs is the NEXT slice — out of scope here).
//
// A device id maps to at most one controller — re-subscribing (e.g. the app
// reconnected) replaces the previous stream. publish() returns whether the
// frame was actually handed to a live subscriber.

export interface SseController {
  enqueue(chunk: Uint8Array): void
}

export interface LiveBus {
  subscribe(deviceId: string, controller: SseController): void
  unsubscribe(deviceId: string): void
  publish(deviceId: string, payload: unknown): boolean
}

export function createLiveBus(): LiveBus {
  const subscribers = new Map<string, SseController>()
  const encoder = new TextEncoder()

  return {
    subscribe(deviceId: string, controller: SseController): void {
      subscribers.set(deviceId, controller)
    },

    unsubscribe(deviceId: string): void {
      subscribers.delete(deviceId)
    },

    publish(deviceId: string, payload: unknown): boolean {
      const controller = subscribers.get(deviceId)
      if (!controller) return false
      const frame = encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
      try {
        controller.enqueue(frame)
        return true
      } catch {
        // Stream is dead (client vanished without a clean cancel). Drop the
        // stale subscriber so we don't keep trying.
        subscribers.delete(deviceId)
        return false
      }
    },
  }
}
