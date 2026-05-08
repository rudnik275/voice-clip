import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer, type ServerDeps } from '../src/server'

const ADMIN_TOKEN = 'test-admin-token-xyz'

interface TestServer {
  baseUrl: string
  stop: () => void
}

interface UploadResponse {
  id: string
  text: string
  source: 'online' | 'offline'
  totalUsd?: number
  totalRequests?: number
}

interface MeResponse {
  id: string
  name: string
  daemonToken: string
}

async function spawn(dir: string): Promise<TestServer> {
  const deps: ServerDeps = {
    dataDir: dir,
    transcribe: async () => ({
      text: 'mocked transcript',
      usage: { audioTokens: 100, textTokens: 50, outputTokens: 20 },
    }),
    copyToClipboard: async () => undefined,
    port: 0,
    useTls: false,
    adminToken: ADMIN_TOKEN,
  }
  const s = await startServer(deps)
  return { baseUrl: `http://localhost:${s.port}`, stop: () => s.stop() }
}

function audioForm(source: 'online' | 'offline', recordedAt: string): FormData {
  const fd = new FormData()
  fd.append('audio', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mp4' }))
  fd.append('source', source)
  fd.append('recordedAt', recordedAt)
  return fd
}

async function createInviteAdmin(baseUrl: string): Promise<string> {
  const r = await fetch(`${baseUrl}/admin/invites`, {
    method: 'POST',
    headers: { 'X-Admin-Token': ADMIN_TOKEN },
  })
  if (!r.ok) throw new Error(`admin invites: ${r.status}`)
  const data = (await r.json()) as { token: string }
  return data.token
}

// Returns the cookie string "session=..." after a successful signup.
async function signUp(baseUrl: string, invite: string, name: string): Promise<string> {
  const r = await fetch(`${baseUrl}/signup/${invite}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  expect(r.ok).toBe(true)
  const setCookie = r.headers.get('set-cookie')
  expect(setCookie).toMatch(/session=/)
  // Extract just `session=<token>` for cookie header use
  return setCookie!.split(';')[0]!
}

describe('auth + multi-user', () => {
  let dir: string
  let s: TestServer

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'voice-clip-auth-'))
    s = await spawn(dir)
  })

  afterEach(async () => {
    s.stop()
    await rm(dir, { recursive: true, force: true })
  })

  test('unauthenticated /upload → 401', async () => {
    const r = await fetch(`${s.baseUrl}/upload`, {
      method: 'POST',
      body: audioForm('online', '2026-05-08T10:00:00Z'),
    })
    expect(r.status).toBe(401)
  })

  test('unauthenticated /history, /cost, /me → 401', async () => {
    expect((await fetch(`${s.baseUrl}/history`)).status).toBe(401)
    expect((await fetch(`${s.baseUrl}/cost`)).status).toBe(401)
    expect((await fetch(`${s.baseUrl}/me`)).status).toBe(401)
  })

  test('admin without token → 403', async () => {
    expect((await fetch(`${s.baseUrl}/admin/invites`, { method: 'POST' })).status).toBe(403)
    expect(
      (
        await fetch(`${s.baseUrl}/admin/invites`, {
          method: 'POST',
          headers: { 'X-Admin-Token': 'wrong' },
        })
      ).status,
    ).toBe(403)
  })

  test('admin with token → creates invite, returns token + url', async () => {
    const r = await fetch(`${s.baseUrl}/admin/invites`, {
      method: 'POST',
      headers: { 'X-Admin-Token': ADMIN_TOKEN },
    })
    expect(r.ok).toBe(true)
    const data = (await r.json()) as { token: string; url: string }
    expect(data.token).toMatch(/^[a-f0-9]+$/)
    expect(data.url).toContain(`/signup/${data.token}`)
  })

  test('signup with valid invite → creates user + session cookie; second use → 410', async () => {
    const invite = await createInviteAdmin(s.baseUrl)
    const cookie = await signUp(s.baseUrl, invite, 'dima')
    expect(cookie).toMatch(/^session=/)

    // /me reflects the new user
    const me = (await (await fetch(`${s.baseUrl}/me`, { headers: { cookie } })).json()) as MeResponse
    expect(me.name).toBe('dima')
    expect(me.daemonToken).toBeString()

    // Re-using the consumed invite → 410
    const r = await fetch(`${s.baseUrl}/signup/${invite}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'eve' }),
    })
    expect(r.status).toBe(410)
  })

  test('signup with bogus invite token → 410', async () => {
    const r = await fetch(`${s.baseUrl}/signup/not-a-real-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    })
    expect(r.status).toBe(410)
  })

  test('signup with empty/missing name → 400', async () => {
    const invite = await createInviteAdmin(s.baseUrl)
    const r = await fetch(`${s.baseUrl}/signup/${invite}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '   ' }),
    })
    expect(r.status).toBe(400)
  })

  test('isolation: user A cannot see user B history', async () => {
    const inviteA = await createInviteAdmin(s.baseUrl)
    const cookieA = await signUp(s.baseUrl, inviteA, 'alice')
    const inviteB = await createInviteAdmin(s.baseUrl)
    const cookieB = await signUp(s.baseUrl, inviteB, 'bob')

    // Alice uploads
    await fetch(`${s.baseUrl}/upload`, {
      method: 'POST',
      headers: { cookie: cookieA },
      body: audioForm('online', '2026-05-08T10:00:00Z'),
    })

    const aliceHistory = await (await fetch(`${s.baseUrl}/history`, { headers: { cookie: cookieA } })).json()
    expect(aliceHistory).toHaveLength(1)

    const bobHistory = await (await fetch(`${s.baseUrl}/history`, { headers: { cookie: cookieB } })).json()
    expect(bobHistory).toHaveLength(0)
  })

  test('aggregate /cost: both users see the same total after either of them uploads', async () => {
    const inviteA = await createInviteAdmin(s.baseUrl)
    const cookieA = await signUp(s.baseUrl, inviteA, 'alice')
    const inviteB = await createInviteAdmin(s.baseUrl)
    const cookieB = await signUp(s.baseUrl, inviteB, 'bob')

    await fetch(`${s.baseUrl}/upload`, {
      method: 'POST',
      headers: { cookie: cookieA },
      body: audioForm('online', '2026-05-08T10:00:00Z'),
    })

    const costA = (await (await fetch(`${s.baseUrl}/cost`, { headers: { cookie: cookieA } })).json()) as {
      totalUsd: number
      totalRequests: number
    }
    const costB = (await (await fetch(`${s.baseUrl}/cost`, { headers: { cookie: cookieB } })).json()) as {
      totalUsd: number
      totalRequests: number
    }
    expect(costA.totalRequests).toBe(1)
    expect(costB.totalRequests).toBe(1)
    expect(costA.totalUsd).toBe(costB.totalUsd)
    expect(costA.totalUsd).toBeGreaterThan(0)

    // Bob also records — total goes up for both
    await fetch(`${s.baseUrl}/upload`, {
      method: 'POST',
      headers: { cookie: cookieB },
      body: audioForm('online', '2026-05-08T11:00:00Z'),
    })
    const costAfter = (await (await fetch(`${s.baseUrl}/cost`, { headers: { cookie: cookieA } })).json()) as {
      totalUsd: number
      totalRequests: number
    }
    expect(costAfter.totalRequests).toBe(2)
    expect(costAfter.totalUsd).toBeGreaterThan(costA.totalUsd)
  })

  test('logout clears session — subsequent /me → 401', async () => {
    const invite = await createInviteAdmin(s.baseUrl)
    const cookie = await signUp(s.baseUrl, invite, 'dima')
    expect((await fetch(`${s.baseUrl}/me`, { headers: { cookie } })).ok).toBe(true)

    const r = await fetch(`${s.baseUrl}/logout`, { method: 'POST', headers: { cookie } })
    expect(r.status).toBe(204)

    expect((await fetch(`${s.baseUrl}/me`, { headers: { cookie } })).status).toBe(401)
  })

  test('magic-link: admin generates URL → opening it logs the SAME existing user into a new browser', async () => {
    // Sign up dima from device A
    const invite = await createInviteAdmin(s.baseUrl)
    const cookieA = await signUp(s.baseUrl, invite, 'dima')
    const meA = (await (await fetch(`${s.baseUrl}/me`, { headers: { cookie: cookieA } })).json()) as MeResponse

    // Admin asks for a magic-link bound to dima's userId (simulating "I want to
    // also use my iPad as the same dima").
    const linkResp = await fetch(`${s.baseUrl}/admin/magic-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': ADMIN_TOKEN },
      body: JSON.stringify({ userId: meA.id }),
    })
    expect(linkResp.ok).toBe(true)
    const link = (await linkResp.json()) as { token: string; url: string; userId: string; userName: string }
    expect(link.userId).toBe(meA.id)
    expect(link.userName).toBe('dima')
    expect(link.url).toMatch(/\/login\//)

    // GET /login/:token — no cookie set, no token consumed. Just the form.
    // (This is also what link-preview bots in iMessage / Slack would hit; it
    // must NOT consume.)
    const peekResp = await fetch(`${s.baseUrl}/login/${link.token}`, { redirect: 'manual' })
    expect(peekResp.status).toBe(200)
    expect(peekResp.headers.get('set-cookie')).toBeNull()

    // Idempotency check: a second GET still returns 200 (token not yet consumed).
    expect((await fetch(`${s.baseUrl}/login/${link.token}`, { redirect: 'manual' })).status).toBe(200)

    // POST consumes — that's the actual login.
    const r = await fetch(`${s.baseUrl}/login/${link.token}`, { method: 'POST', redirect: 'manual' })
    expect(r.status).toBe(303)
    expect(r.headers.get('location')).toBe('/')
    const setCookie = r.headers.get('set-cookie')
    expect(setCookie).toMatch(/^session=/)
    const cookieB = setCookie!.split(';')[0]!

    // Device B's session resolves to the SAME user
    const meB = (await (await fetch(`${s.baseUrl}/me`, { headers: { cookie: cookieB } })).json()) as MeResponse
    expect(meB.id).toBe(meA.id)
    expect(meB.name).toBe('dima')

    // History is naturally shared (same userId)
    const aliceUpload = await fetch(`${s.baseUrl}/upload`, {
      method: 'POST',
      headers: { cookie: cookieA },
      body: audioForm('online', '2026-05-08T10:00:00Z'),
    })
    expect(aliceUpload.ok).toBe(true)
    const fromA = (await (await fetch(`${s.baseUrl}/history`, { headers: { cookie: cookieA } })).json()) as unknown[]
    const fromB = (await (await fetch(`${s.baseUrl}/history`, { headers: { cookie: cookieB } })).json()) as unknown[]
    expect(fromA.length).toBe(1)
    expect(fromB.length).toBe(1)
  })

  test('magic-link: single-use — second open of the same link → 410', async () => {
    const invite = await createInviteAdmin(s.baseUrl)
    const cookie = await signUp(s.baseUrl, invite, 'dima')
    const me = (await (await fetch(`${s.baseUrl}/me`, { headers: { cookie } })).json()) as MeResponse
    const link = (await (await fetch(`${s.baseUrl}/admin/magic-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': ADMIN_TOKEN },
      body: JSON.stringify({ userId: me.id }),
    })).json()) as { token: string }

    expect((await fetch(`${s.baseUrl}/login/${link.token}`, { method: 'POST', redirect: 'manual' })).status).toBe(303)
    expect((await fetch(`${s.baseUrl}/login/${link.token}`, { method: 'POST', redirect: 'manual' })).status).toBe(410)
    // After consume, even GET returns 410 (no longer valid)
    expect((await fetch(`${s.baseUrl}/login/${link.token}`, { redirect: 'manual' })).status).toBe(410)
  })

  test('magic-link peek does NOT consume — confirming preview-bot safety', async () => {
    const invite = await createInviteAdmin(s.baseUrl)
    const cookie = await signUp(s.baseUrl, invite, 'dima')
    const me = (await (await fetch(`${s.baseUrl}/me`, { headers: { cookie } })).json()) as MeResponse
    const link = (await (await fetch(`${s.baseUrl}/admin/magic-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': ADMIN_TOKEN },
      body: JSON.stringify({ userId: me.id }),
    })).json()) as { token: string }

    // Simulate a preview bot hitting the link 3 times — should not consume.
    for (let i = 0; i < 3; i++) {
      expect((await fetch(`${s.baseUrl}/login/${link.token}`)).status).toBe(200)
    }

    // /peek endpoint returns user metadata without consuming.
    const peekData = (await (await fetch(`${s.baseUrl}/login/${link.token}/peek`)).json()) as {
      userName: string
    }
    expect(peekData.userName).toBe('dima')

    // Real human POST still works.
    expect((await fetch(`${s.baseUrl}/login/${link.token}`, { method: 'POST', redirect: 'manual' })).status).toBe(303)
  })

  test('magic-link: bad userId → 404; missing userId → 400; non-admin → 403', async () => {
    const r404 = await fetch(`${s.baseUrl}/admin/magic-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': ADMIN_TOKEN },
      body: JSON.stringify({ userId: 'no-such-user' }),
    })
    expect(r404.status).toBe(404)

    const r400 = await fetch(`${s.baseUrl}/admin/magic-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': ADMIN_TOKEN },
      body: JSON.stringify({}),
    })
    expect(r400.status).toBe(400)

    const r403 = await fetch(`${s.baseUrl}/admin/magic-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'whatever' }),
    })
    expect(r403.status).toBe(403)
  })

  test('magic-link: opening a bogus token → 410 on both GET and POST', async () => {
    expect((await fetch(`${s.baseUrl}/login/not-a-real-magic-token`, { redirect: 'manual' })).status).toBe(410)
    expect(
      (await fetch(`${s.baseUrl}/login/not-a-real-magic-token`, { method: 'POST', redirect: 'manual' })).status,
    ).toBe(410)
  })

  test('admin disabled when ADMIN_TOKEN is empty: /admin/invites → 403 even with empty header', async () => {
    const dir2 = await mkdtemp(join(tmpdir(), 'voice-clip-no-admin-'))
    const noAdmin = await startServer({
      dataDir: dir2,
      transcribe: async () => ({ text: 'x', usage: { audioTokens: 1, textTokens: 1, outputTokens: 0 } }),
      copyToClipboard: async () => undefined,
      port: 0,
      useTls: false,
      adminToken: '',
    })
    try {
      expect(
        (
          await fetch(`http://localhost:${noAdmin.port}/admin/invites`, {
            method: 'POST',
            headers: { 'X-Admin-Token': '' },
          })
        ).status,
      ).toBe(403)
    } finally {
      noAdmin.stop()
      await rm(dir2, { recursive: true, force: true })
    }
  })
})
