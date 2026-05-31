// Thin fetch client for /devices.
// Matches the real server contract (src/server.ts):
//   GET  /devices       → DeviceRow[]
//   DELETE /devices/:id → { ok: true }
//
// POST /admin/invites (owner-only) → { token: string; url: string }
// is also included here because it is surfaced from the ProfileModal.

export interface DeviceRow {
  id: string
  label: string | null
  created_at: number
  last_seen_at: number
}

export interface InviteResult {
  token: string
  url: string
}

export async function fetchDevices(): Promise<DeviceRow[]> {
  const res = await fetch('/devices', { credentials: 'same-origin' })
  if (!res.ok) throw new Error(`/devices responded ${res.status}`)
  return res.json() as Promise<DeviceRow[]>
}

export async function revokeDevice(id: string): Promise<void> {
  const res = await fetch(`/devices/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  })
  if (!res.ok) throw new Error(`DELETE /devices/${id} responded ${res.status}`)
}

export async function generateInvite(): Promise<InviteResult> {
  const res = await fetch('/admin/invites', {
    method: 'POST',
    credentials: 'same-origin',
  })
  if (!res.ok) throw new Error(`/admin/invites responded ${res.status}`)
  return res.json() as Promise<InviteResult>
}
