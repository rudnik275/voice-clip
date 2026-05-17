import { describe, expect, test } from 'bun:test'
import { createLiveBus, type SseController } from '../src/live-bus'

// A minimal stub matching the slice of ReadableStreamDefaultController the
// live-bus actually uses (enqueue). Records every chunk it receives so the
// test can decode what was published.
function mockController() {
  const chunks: Uint8Array[] = []
  const controller: SseController = {
    enqueue(chunk: Uint8Array) {
      chunks.push(chunk)
    },
  }
  const decode = () => new TextDecoder().decode(Uint8Array.from(chunks.flatMap((c) => [...c])))
  return { controller, chunks, decode }
}

describe('live-bus (in-memory pub/sub keyed by device_id)', () => {
  test('publish to a subscribed device returns true and delivers an SSE frame', () => {
    const bus = createLiveBus()
    const m = mockController()
    bus.subscribe('dev-1', m.controller)

    const ok = bus.publish('dev-1', { seq: 7, text: 'hello' })
    expect(ok).toBe(true)
    expect(m.decode()).toBe(`data: ${JSON.stringify({ seq: 7, text: 'hello' })}\n\n`)
  })

  test('publish to a device with no subscriber returns false', () => {
    const bus = createLiveBus()
    expect(bus.publish('ghost', { seq: 1 })).toBe(false)
  })

  test('unsubscribe stops future delivery; publish then returns false', () => {
    const bus = createLiveBus()
    const m = mockController()
    bus.subscribe('dev-1', m.controller)
    bus.unsubscribe('dev-1')
    expect(bus.publish('dev-1', { seq: 2 })).toBe(false)
    expect(m.chunks).toHaveLength(0)
  })

  test('publish is routed per device — only the matching subscriber gets it', () => {
    const bus = createLiveBus()
    const a = mockController()
    const b = mockController()
    bus.subscribe('dev-a', a.controller)
    bus.subscribe('dev-b', b.controller)

    bus.publish('dev-a', { seq: 1, text: 'for-a' })
    expect(a.decode()).toContain('for-a')
    expect(b.chunks).toHaveLength(0)
  })

  test('re-subscribing a device replaces the previous controller', () => {
    const bus = createLiveBus()
    const first = mockController()
    const second = mockController()
    bus.subscribe('dev-1', first.controller)
    bus.subscribe('dev-1', second.controller)

    bus.publish('dev-1', { seq: 9 })
    expect(first.chunks).toHaveLength(0)
    expect(second.decode()).toContain('"seq":9')
  })

  test('a controller that throws on enqueue does not crash publish (returns false)', () => {
    const bus = createLiveBus()
    const bad: SseController = {
      enqueue() {
        throw new Error('stream closed')
      },
    }
    bus.subscribe('dev-1', bad)
    expect(bus.publish('dev-1', { seq: 1 })).toBe(false)
    // The dead subscriber is dropped, so a later publish is also false.
    expect(bus.publish('dev-1', { seq: 2 })).toBe(false)
  })

  test('disconnect errors the live stream and drops the subscriber', () => {
    const bus = createLiveBus()
    let erroredWith: unknown
    let closed = false
    // The real /events route hands a ReadableStreamDefaultController; the
    // bus only needs enqueue for publish but disconnect must abort the
    // stream so the Tauri app sees the socket drop and re-auths.
    const controller = {
      enqueue(_chunk: Uint8Array) {},
      error(e?: unknown) {
        erroredWith = e
      },
      close() {
        closed = true
      },
    }
    bus.subscribe('dev-1', controller)

    bus.disconnect('dev-1')

    expect(erroredWith).toBeInstanceOf(Error)
    expect(closed).toBe(false)
    // Subscriber is gone — a later publish finds nobody.
    expect(bus.publish('dev-1', { seq: 1 })).toBe(false)
  })

  test('disconnect on an unknown device is a no-op (no throw)', () => {
    const bus = createLiveBus()
    expect(() => bus.disconnect('ghost')).not.toThrow()
  })

  test('disconnect swallows a controller that throws on error()', () => {
    const bus = createLiveBus()
    const controller = {
      enqueue(_chunk: Uint8Array) {},
      error() {
        throw new Error('already errored')
      },
      close() {},
    }
    bus.subscribe('dev-1', controller)
    expect(() => bus.disconnect('dev-1')).not.toThrow()
    expect(bus.publish('dev-1', { seq: 1 })).toBe(false)
  })
})
