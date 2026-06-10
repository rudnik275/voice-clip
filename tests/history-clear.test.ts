// Server-level integration test: DELETE /history also clears that user's
// pending-delivery rows, so reconnected Macs don't replay clips that no
// longer exist in history.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer, type ServerDeps } from '../src/server'
import type { GoogleFetcher } from '../src/google-oauth'
import type { TranscriptionResult } from '../src/transcribe'
import { openDb } from '../src/db'
import { createUsersStore } from '../src/users-store'
import { createSessionsStore } from '../src/sessions-store'
import { createDevicesStore } from '../src/devices-store'
import { createPendingDeliveriesStore } from '../src/pending-deliveries-store'

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

function audioForm(recordedAt: string): FormData {
  const fd = new FormData()
  fd.set('audio', new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/webm' }), 'clip.webm')
  fd.set('recordedAt', recordedAt)
  return fd
}

describe('DELETE /history clears pending-delivery rows', () => {
  let dir: string
  let server: Awaited<ReturnType<typeof startServer>>

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'voice-clip-hclear-'))
  })
  afterEach(async () => {
    if (server) server.stop()
    await rm(dir, { recursive: true, force: true })
  })

  test('clearing history removes pending rows for that user; another users rows are untouched', async () => {
    const db = openDb(':memory:')

    // Bootstrap two users directly in the DB.
    const users = createUsersStore(db)
    const sessions = createSessionsStore(db)
    const devices = createDevicesStore(db)
    const pendingDeliveries = createPendingDeliveriesStore(db)

    const alice = users.upsertByGoogleSub({ sub: 'g-alice', email: 'alice@example.com', name: 'Alice' })
    const bob = users.upsertByGoogleSub({ sub: 'g-bob', email: 'bob@example.com', name: 'Bob' })

    const aliceSession = sessions.create(alice.id)
    const bobSession = sessions.create(bob.id)

    const aliceMac = devices.create(alice.id, 'Alice Mac')
    const bobMac = devices.create(bob.id, 'Bob Mac')

    const deps: ServerDeps = {
      dataDir: dir,
      port: 0,
      useTls: false,
      allowlist: ['alice@example.com', 'bob@example.com'],
      googleClientId: CLIENT_ID,
      googleClientSecret: CLIENT_SECRET,
      googleFetcher: makeGoogleFetcher({ sub: 'g-alice', email: 'alice@example.com', name: 'Alice' }),
      db,
      sessions,
      pendingDeliveries,
      transcribe: async (): Promise<TranscriptionResult> => ({
        text: 'hello world',
        usage: { audioTokens: 100, textTokens: 0, outputTokens: 0 },
      }),
    }

    server = await startServer(deps)
    let baseUrl = `http://localhost:${server.port}`
    server.stop()
    server = await startServer({ ...deps, publicUrl: baseUrl })
    baseUrl = `http://localhost:${server.port}`

    // Alice uploads a clip (no live subscriber → pending row for aliceMac)
    const upA = await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      headers: { cookie: `session=${aliceSession.token}` },
      body: audioForm('2026-05-17T10:00:00.000Z'),
    })
    expect(upA.status).toBe(200)
    expect(pendingDeliveries.listByDevice(aliceMac.id)).toHaveLength(1)

    // Bob uploads a clip (no live subscriber → pending row for bobMac)
    const upB = await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      headers: { cookie: `session=${bobSession.token}` },
      body: audioForm('2026-05-17T11:00:00.000Z'),
    })
    expect(upB.status).toBe(200)
    expect(pendingDeliveries.listByDevice(bobMac.id)).toHaveLength(1)

    // Alice clears her history
    const del = await fetch(`${baseUrl}/history`, {
      method: 'DELETE',
      headers: { cookie: `session=${aliceSession.token}` },
    })
    expect(del.status).toBe(200)

    // Alice's pending rows are gone
    expect(pendingDeliveries.listByDevice(aliceMac.id)).toEqual([])

    // Bob's pending rows are untouched
    expect(pendingDeliveries.listByDevice(bobMac.id)).toHaveLength(1)
  })
})
