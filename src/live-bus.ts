// In-memory pub/sub for live SSE delivery, keyed by device_id.
//
// Each connected Mac app holds one long-lived GET /events SSE stream. The
// server registers that stream's ReadableStream controller here under the
// device's id. When a phone uploads a clip, /upload walks the user's devices
// and calls publish(device.id, clip) — every currently-connected Mac for
// that user gets the frame instantly.
//
// This is intentionally process-local and ephemeral: live push is a
// best-effort latency optimization on top of the durable pending_deliveries
// queue. The fan-out ALWAYS writes a pending row per device; publish()
// returning true only means the frame was buffered into the stream — not
// that the client received it. Durable delivery is: pending row → replay on
// reconnect → /events/ack deletes the row (at-least-once).
//
// A device id maps to at most one controller — re-subscribing (e.g. the app
// reconnected) replaces the previous stream. unsubscribe() is guarded by
// controller identity so a late cancel() of an already-replaced (dead)
// stream cannot detach the replacement subscriber.
//
// disconnect() is server-initiated teardown: when a device is revoked
// (DELETE /devices/:id) its live SSE stream must be aborted so the Tauri
// app sees the socket drop and re-auths (where its now-deleted token gets
// a 401). It error()s the underlying ReadableStream controller — which is
// why subscribe accepts the real ReadableStreamDefaultController, not just
// the enqueue slice publish() needs.

export interface SseController {
  enqueue(chunk: Uint8Array): void
}

// The /events route hands its real ReadableStreamDefaultController in.
// publish() only ever calls enqueue (so a plain SseController still works
// for tests), but disconnect() needs error() to abort the response stream.
type BusController = SseController & {
  error?: (reason?: unknown) => void
}

export interface LiveBus {
  subscribe(deviceId: string, controller: BusController): void
  unsubscribe(deviceId: string, controller: BusController): void
  publish(deviceId: string, payload: unknown): boolean
  disconnect(deviceId: string): void
}

export function createLiveBus(): LiveBus {
  const subscribers = new Map<string, BusController>()
  const encoder = new TextEncoder()

  return {
    subscribe(deviceId: string, controller: BusController): void {
      subscribers.set(deviceId, controller)
    },

    unsubscribe(deviceId: string, controller: BusController): void {
      // Identity-guarded: only the stream that is still the registered
      // subscriber may remove itself. Without this, the runtime firing a
      // dead old stream's cancel() AFTER the client already reconnected
      // (and re-subscribed) would detach the NEW stream's controller.
      if (subscribers.get(deviceId) === controller) {
        subscribers.delete(deviceId)
      }
    },

    disconnect(deviceId: string): void {
      const controller = subscribers.get(deviceId)
      // Drop the subscriber first so a concurrent publish can't re-find a
      // controller we're about to abort.
      subscribers.delete(deviceId)
      if (!controller || typeof controller.error !== 'function') return
      try {
        controller.error(new Error('device revoked'))
      } catch {
        // Stream was already torn down (client vanished). Nothing to do —
        // the subscriber is already removed.
      }
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
