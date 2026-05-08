// In-memory pub/sub for the SSE delivery channel — used by /upload to push fresh
// transcripts to the user's connected Mac daemon. Multiple daemon instances per
// user are supported (rare but possible: phone + iPad both running a daemon).

export interface ClipEvent {
  id: string
  text: string
}

type Listener = (clip: ClipEvent) => void

export interface LiveBus {
  publish(userId: string, clip: ClipEvent): void
  subscribe(userId: string, listener: Listener): () => void
  subscriberCount(userId: string): number
}

export function createLiveBus(): LiveBus {
  const listeners = new Map<string, Set<Listener>>()

  return {
    publish(userId, clip) {
      const set = listeners.get(userId)
      if (!set) return
      for (const fn of set) {
        try {
          fn(clip)
        } catch (err) {
          // Listener errors must not affect siblings or the publisher.
          console.error('[live-bus] listener threw:', err)
        }
      }
    },

    subscribe(userId, listener) {
      let set = listeners.get(userId)
      if (!set) {
        set = new Set()
        listeners.set(userId, set)
      }
      set.add(listener)
      return () => {
        set!.delete(listener)
        if (set!.size === 0) listeners.delete(userId)
      }
    },

    subscriberCount(userId) {
      return listeners.get(userId)?.size ?? 0
    },
  }
}
