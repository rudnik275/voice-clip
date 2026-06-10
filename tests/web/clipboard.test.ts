/**
 * Unit tests for web/src/lib/clipboard.ts
 *
 * Stubs navigator.clipboard with a controllable mock so we can test:
 *   - ClipboardItem path: write resolves → finish returns true
 *   - ClipboardItem path: write rejects → falls back to writeText
 *   - No ClipboardItem support → writeText called with the text
 *   - navigator.clipboard absent → finish returns false (no crash)
 *   - writeText rejects → finish returns false (no success signal)
 */
import { test, expect, describe, beforeEach, afterEach } from 'bun:test'

// ---- minimal DOM stubs -------------------------------------------------------

// Blob is available in Bun, but we need to patch navigator.clipboard
// and optionally ClipboardItem into the global scope.

type WriteTextFn = (text: string) => Promise<void>
type WriteFn = (items: unknown[]) => Promise<void>

interface MockClipboard {
  writeText: WriteTextFn
  write: WriteFn
}

interface ClipboardCallLog {
  writeTextCalls: string[]
  writeCalls: unknown[][]
}

function makeClipboard(
  writeTextImpl: WriteTextFn = () => Promise.resolve(),
  writeImpl: WriteFn = () => Promise.resolve(),
): { clipboard: MockClipboard; log: ClipboardCallLog } {
  const log: ClipboardCallLog = { writeTextCalls: [], writeCalls: [] }
  return {
    clipboard: {
      writeText(text) {
        log.writeTextCalls.push(text)
        return writeTextImpl(text)
      },
      write(items) {
        log.writeCalls.push(items)
        return writeImpl(items)
      },
    },
    log,
  }
}

// --------------------------------------------------------------------------

// We import the module under test after patching globals so the module
// reads the patched values at call time (not at import time).
//
// Because web/src/lib/clipboard.ts uses `typeof ClipboardItem` at runtime,
// we patch/restore globalThis.ClipboardItem per test.

// Keep originals so we can restore
const origNavigator = globalThis.navigator
const origClipboardItem = (globalThis as Record<string, unknown>)['ClipboardItem']

function patchNavigatorClipboard(clipboard: MockClipboard | null): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: clipboard ? { clipboard } : { clipboard: undefined },
    configurable: true,
    writable: true,
  })
}

function restoreNavigator(): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: origNavigator,
    configurable: true,
    writable: true,
  })
}

type ClipboardItemConstructorArg = Record<string, Promise<Blob>>

class FakeClipboardItem {
  readonly data: ClipboardItemConstructorArg
  constructor(data: ClipboardItemConstructorArg) {
    this.data = data
  }
}

function installClipboardItem(): void {
  ;(globalThis as Record<string, unknown>)['ClipboardItem'] = FakeClipboardItem
}

function removeClipboardItem(): void {
  delete (globalThis as Record<string, unknown>)['ClipboardItem']
}

// We need to dynamically import the module so that each test group sees the
// patched globals.  Since Bun caches imports, we import once at the top level
// and rely on the module reading globals at call time (which it does — all
// usages of navigator.clipboard and ClipboardItem are inside function bodies).
import { armClipboardWrite } from '../../web/src/lib/clipboard'

// -------------------------------------------------------------------------------

describe('armClipboardWrite — ClipboardItem supported', () => {
  beforeEach(() => {
    installClipboardItem()
  })
  afterEach(() => {
    removeClipboardItem()
    restoreNavigator()
  })

  test('finish resolves true when ClipboardItem write succeeds', async () => {
    const { clipboard, log } = makeClipboard(
      () => Promise.resolve(), // writeText (fallback, should not be called)
      () => Promise.resolve(), // write (succeeds)
    )
    patchNavigatorClipboard(clipboard)

    const cw = armClipboardWrite()
    const result = await cw.finish('hello world')

    expect(result).toBe(true)
    // write() was called with a ClipboardItem array
    expect(log.writeCalls.length).toBe(1)
  })

  test('finish calls writeText fallback and returns true when ClipboardItem write rejects', async () => {
    const { clipboard, log } = makeClipboard(
      () => Promise.resolve(), // writeText succeeds
      () => Promise.reject(new Error('not allowed')), // write fails
    )
    patchNavigatorClipboard(clipboard)

    const cw = armClipboardWrite()
    const result = await cw.finish('fallback text')

    expect(result).toBe(true)
    expect(log.writeTextCalls).toContain('fallback text')
  })

  test('finish returns false when both ClipboardItem write and writeText reject', async () => {
    const { clipboard } = makeClipboard(
      () => Promise.reject(new Error('denied')), // writeText fails too
      () => Promise.reject(new Error('denied')), // write fails
    )
    patchNavigatorClipboard(clipboard)

    const cw = armClipboardWrite()
    const result = await cw.finish('secret')

    expect(result).toBe(false)
  })

  test('ClipboardItem receives the correct text via the resolved Promise', async () => {
    let capturedBlob: Blob | undefined
    const { clipboard } = makeClipboard(
      () => Promise.resolve(),
      async (items) => {
        const item = items[0] as FakeClipboardItem
        const blobPromise = item.data['text/plain']
        if (blobPromise) capturedBlob = await blobPromise
        return Promise.resolve()
      },
    )
    patchNavigatorClipboard(clipboard)

    const cw = armClipboardWrite()
    await cw.finish('the text')

    // Give the async write callback a tick to complete
    await new Promise((r) => setTimeout(r, 0))
    expect(capturedBlob).not.toBeUndefined()
    expect(await capturedBlob!.text()).toBe('the text')
  })
})

describe('armClipboardWrite — ClipboardItem NOT supported (writeText fallback)', () => {
  beforeEach(() => {
    removeClipboardItem()
  })
  afterEach(() => {
    if (origClipboardItem !== undefined) {
      ;(globalThis as Record<string, unknown>)['ClipboardItem'] = origClipboardItem
    }
    restoreNavigator()
  })

  test('calls writeText directly and returns true on success', async () => {
    const { clipboard, log } = makeClipboard(() => Promise.resolve())
    patchNavigatorClipboard(clipboard)

    const cw = armClipboardWrite()
    const result = await cw.finish('direct text')

    expect(result).toBe(true)
    expect(log.writeTextCalls).toContain('direct text')
    expect(log.writeCalls.length).toBe(0)
  })

  test('returns false when writeText rejects', async () => {
    const { clipboard } = makeClipboard(() => Promise.reject(new Error('NotAllowedError')))
    patchNavigatorClipboard(clipboard)

    const cw = armClipboardWrite()
    const result = await cw.finish('blocked text')

    expect(result).toBe(false)
  })
})

describe('armClipboardWrite — navigator.clipboard absent', () => {
  afterEach(() => {
    restoreNavigator()
    if (origClipboardItem !== undefined) {
      ;(globalThis as Record<string, unknown>)['ClipboardItem'] = origClipboardItem
    } else {
      removeClipboardItem()
    }
  })

  test('returns false without throwing when navigator.clipboard is undefined', async () => {
    removeClipboardItem()
    patchNavigatorClipboard(null)

    const cw = armClipboardWrite()
    const result = await cw.finish('no clipboard')

    expect(result).toBe(false)
  })
})
