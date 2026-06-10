import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer, type ServerDeps } from '../src/server'
import type { GoogleFetcher } from '../src/google-oauth'
import { openDb } from '../src/db'
import { createUsersStore } from '../src/users-store'
import { createDevicesStore } from '../src/devices-store'
import { createPendingDeliveriesStore } from '../src/pending-deliveries-store'
import { createLiveBus } from '../src/live-bus'

const CLIENT_ID = 'test-client.apps.googleusercontent.com'
const CLIENT_SECRET = 'test-secret'

function b64url(s: string): string {
  return Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}
function makeIdToken(payload: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}.sig`
}
function makeGoogleFetcher(p: Record<string, unknown>): GoogleFetcher {
  return async () =>
    new Response(
      JSON.stringify({
        id_token: makeIdToken({
          iss: 'https://accounts.google.com',
          aud: CLIENT_ID,
          exp: Math.floor(Date.now() / 1000) + 3600,
          email_verified: true,
          ...p,
        }),
        access_token: 'fake',
        token_type: 'Bearer',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
}

async function signIn(baseUrl: string): Promise<string> {
  const startR = await fetch(`${baseUrl}/auth/google/start`, { redirect: 'manual' })
  const state = startR.headers
    .getSetCookie()
    .find((c) => c.startsWith('oauth_state='))!
    .split(';')[0]!
    .split('=')[1]!
  const cbR = await fetch(`${baseUrl}/auth/google/callback?code=fake&state=${state}`, {
    headers: { cookie: `oauth_state=${state}` },
    redirect: 'manual',
  })
  return cbR.headers
    .getSetCookie()
    .find((c) => c.startsWith('session='))!
    .split(';')[0]!
    .split('=')[1]!
}

describe('devices API: GET /devices + DELETE /devices/:id', () => {
  let dir: string
  let server: Awaited<ReturnType<typeof startServer>>
  let baseUrl: string
  let db: ReturnType<typeof openDb>
  let liveBus: ReturnType<typeof createLiveBus>

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'voice-clip-devices-'))
  })
  afterEach(async () => {
    if (server) server.stop()
    await rm(dir, { recursive: true, force: true })
  })

  // Boots the server twice: first to learn the ephemeral port, then again
  // with publicUrl set to that base URL (matches the project's OAuth-test
  // double-start pattern so /auth/google/* is wired).
  async function start(): Promise<string> {
    db = openDb(':memory:')
    liveBus = createLiveBus()
    const deps: ServerDeps = {
      dataDir: dir,
      port: 0,
      useTls: false,
      allowlist: ['alice@example.com', 'bob@example.com'],
      googleClientId: CLIENT_ID,
      googleClientSecret: CLIENT_SECRET,
      googleFetcher: makeGoogleFetcher({ sub: 'g1', email: 'alice@example.com', name: 'Alice' }),
      db,
      liveBus,
    }
    server = await startServer(deps)
    baseUrl = `http://localhost:${server.port}`
    server.stop()
    server = await startServer({ ...deps, publicUrl: baseUrl })
    baseUrl = `http://localhost:${server.port}`
    return baseUrl
  }

  test('GET /devices without a session → 401', async () => {
    await start()
    const r = await fetch(`${baseUrl}/devices`)
    expect(r.status).toBe(401)
  })

  test('GET /devices → 200 with only the caller own devices (label=device_name)', async () => {
    await start()
    const token = await signIn(baseUrl)

    const users = createUsersStore(db)
    const me = users.upsertByGoogleSub({ sub: 'g1', email: 'alice@example.com', name: 'Alice' })
    const other = users.upsertByGoogleSub({ sub: 'g2', email: 'bob@example.com', name: 'Bob' })
    const devices = createDevicesStore(db)
    const macA = devices.create(me.id, 'Mac A')
    devices.create(me.id, 'Mac B')
    devices.create(other.id, "Bob's Mac")

    const r = await fetch(`${baseUrl}/devices`, { headers: { cookie: `session=${token}` } })
    expect(r.status).toBe(200)
    const list = (await r.json()) as Array<{
      id: string
      label: string | null
      created_at: number
      last_seen_at: number
    }>
    expect(list).toHaveLength(2)
    expect(list.map((d) => d.label).sort()).toEqual(['Mac A', 'Mac B'])
    const a = list.find((d) => d.id === macA.id)!
    expect(a.label).toBe('Mac A')
    expect(typeof a.created_at).toBe('number')
    expect(typeof a.last_seen_at).toBe('number')
    // No other-user device leaks through.
    expect(list.some((d) => d.label === "Bob's Mac")).toBe(false)
  })

  test('DELETE /devices/:id without a session → 401', async () => {
    await start()
    const users = createUsersStore(db)
    const me = users.upsertByGoogleSub({ sub: 'g1', email: 'alice@example.com', name: 'Alice' })
    const devices = createDevicesStore(db)
    const d = devices.create(me.id, 'Mac A')

    const r = await fetch(`${baseUrl}/devices/${d.id}`, { method: 'DELETE' })
    expect(r.status).toBe(401)
    // The device is untouched — auth failed before any mutation.
    expect(devices.findById(d.id)).not.toBeNull()
  })

  test('DELETE own device → 200, then GET /devices is empty', async () => {
    await start()
    const token = await signIn(baseUrl)
    const users = createUsersStore(db)
    const me = users.upsertByGoogleSub({ sub: 'g1', email: 'alice@example.com', name: 'Alice' })
    const devices = createDevicesStore(db)
    const d = devices.create(me.id, 'Mac A')

    // It's listed before revoke.
    const before = await fetch(`${baseUrl}/devices`, { headers: { cookie: `session=${token}` } })
    expect(((await before.json()) as unknown[]).length).toBe(1)

    const del = await fetch(`${baseUrl}/devices/${d.id}`, {
      method: 'DELETE',
      headers: { cookie: `session=${token}` },
    })
    expect(del.status).toBe(200)
    expect(await del.json()).toEqual({ ok: true })
    expect(devices.findById(d.id)).toBeNull()

    const after = await fetch(`${baseUrl}/devices`, { headers: { cookie: `session=${token}` } })
    expect(after.status).toBe(200)
    expect(await after.json()).toEqual([])
  })

  test('DELETE another user device → 404 IDENTICAL to a non-existent id (no info leak)', async () => {
    await start()
    const token = await signIn(baseUrl)
    const users = createUsersStore(db)
    users.upsertByGoogleSub({ sub: 'g1', email: 'alice@example.com', name: 'Alice' })
    const other = users.upsertByGoogleSub({ sub: 'g2', email: 'bob@example.com', name: 'Bob' })
    const devices = createDevicesStore(db)
    const bobMac = devices.create(other.id, "Bob's Mac")

    const notOwned = await fetch(`${baseUrl}/devices/${bobMac.id}`, {
      method: 'DELETE',
      headers: { cookie: `session=${token}` },
    })
    const notFound = await fetch(`${baseUrl}/devices/d_does_not_exist`, {
      method: 'DELETE',
      headers: { cookie: `session=${token}` },
    })

    expect(notOwned.status).toBe(404)
    expect(notFound.status).toBe(404)
    // Byte-identical bodies — an attacker can't distinguish "exists but not
    // yours" from "doesn't exist".
    expect(await notOwned.text()).toBe(await notFound.text())
    expect(notOwned.headers.get('content-type')).toBe(notFound.headers.get('content-type'))

    // Bob's device was NOT deleted by Alice's probe.
    expect(devices.findById(bobMac.id)).not.toBeNull()
  })

  test('DELETE cascades the device pending_deliveries rows', async () => {
    await start()
    const token = await signIn(baseUrl)
    const users = createUsersStore(db)
    const me = users.upsertByGoogleSub({ sub: 'g1', email: 'alice@example.com', name: 'Alice' })
    const devices = createDevicesStore(db)
    const d = devices.create(me.id, 'Mac A')
    const pending = createPendingDeliveriesStore(db)
    pending.enqueue(d.id, 1)
    pending.enqueue(d.id, 2)
    expect(pending.listByDevice(d.id)).toHaveLength(2)

    const del = await fetch(`${baseUrl}/devices/${d.id}`, {
      method: 'DELETE',
      headers: { cookie: `session=${token}` },
    })
    expect(del.status).toBe(200)

    // FK ON DELETE CASCADE wiped the queue when the device row went away.
    expect(pending.listByDevice(d.id)).toEqual([])
  })

  test('DELETE /devices/me without a device token → 401', async () => {
    await start()
    const r = await fetch(`${baseUrl}/devices/me`, { method: 'DELETE' })
    expect(r.status).toBe(401)
  })

  test('DELETE /devices/me revokes ONLY the calling device (device-token auth)', async () => {
    await start()
    const users = createUsersStore(db)
    const me = users.upsertByGoogleSub({ sub: 'g1', email: 'alice@example.com', name: 'Alice' })
    const devices = createDevicesStore(db)
    const caller = devices.create(me.id, 'This Mac')
    const other = devices.create(me.id, 'Other Mac')

    const del = await fetch(`${baseUrl}/devices/me`, {
      method: 'DELETE',
      headers: { 'X-Device-Token': caller.device_token },
    })
    expect(del.status).toBe(200)
    expect(await del.json()).toEqual({ ok: true })

    // Only the caller's device is gone; the user's other device survives.
    expect(devices.findById(caller.id)).toBeNull()
    expect(devices.findById(other.id)).not.toBeNull()
  })

  test('DELETE /devices/me aborts the calling device live SSE stream', async () => {
    await start()
    const users = createUsersStore(db)
    const me = users.upsertByGoogleSub({ sub: 'g1', email: 'alice@example.com', name: 'Alice' })
    const devices = createDevicesStore(db)
    const caller = devices.create(me.id, 'This Mac')

    let errored = false
    const controller = {
      enqueue(_chunk: Uint8Array) {},
      error(_e?: unknown) {
        errored = true
      },
      close() {},
    }
    liveBus.subscribe(caller.id, controller)

    const del = await fetch(`${baseUrl}/devices/me`, {
      method: 'DELETE',
      headers: { 'X-Device-Token': caller.device_token },
    })
    expect(del.status).toBe(200)
    expect(errored).toBe(true)
    expect(liveBus.publish(caller.id, { seq: 1 })).toBe(false)
  })

  test('DELETE closes the device live SSE stream so the Tauri app re-auths', async () => {
    await start()
    const token = await signIn(baseUrl)
    const users = createUsersStore(db)
    const me = users.upsertByGoogleSub({ sub: 'g1', email: 'alice@example.com', name: 'Alice' })
    const devices = createDevicesStore(db)
    const d = devices.create(me.id, 'Mac A')

    // Stand in for the /events ReadableStreamDefaultController: the live-bus
    // only needs enqueue for publish, but disconnect() must call error() to
    // abort the response stream the Tauri app is holding.
    let errored = false
    const controller = {
      enqueue(_chunk: Uint8Array) {},
      error(_e?: unknown) {
        errored = true
      },
      close() {},
    }
    liveBus.subscribe(d.id, controller)

    const del = await fetch(`${baseUrl}/devices/${d.id}`, {
      method: 'DELETE',
      headers: { cookie: `session=${token}` },
    })
    expect(del.status).toBe(200)

    // The live stream was aborted (Tauri app sees the socket drop) and the
    // subscriber is gone — a subsequent publish finds nobody.
    expect(errored).toBe(true)
    expect(liveBus.publish(d.id, { seq: 99 })).toBe(false)
  })
})
