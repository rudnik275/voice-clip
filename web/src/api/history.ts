// Thin fetch client for GET /history.
// Matches the real server contract: `since` cursor (seq number), `limit`,
// response shape { items: HistoryClip[]; nextSince?: number }.

export interface HistoryClip {
  seq: number
  text: string
  source: string
  recordedAt: string
  ts: number
}

export interface HistoryPage {
  items: HistoryClip[]
  nextSince?: number
}

export interface FetchHistoryOptions {
  since?: number
  limit?: number
}

export async function fetchHistory(opts: FetchHistoryOptions = {}): Promise<HistoryPage> {
  const qs = new URLSearchParams()
  if (opts.limit !== undefined) qs.set('limit', String(opts.limit))
  if (opts.since !== undefined) qs.set('since', String(opts.since))
  const res = await fetch(`/history?${qs.toString()}`, { credentials: 'same-origin' })
  if (!res.ok) {
    throw new Error(`/history responded ${res.status}`)
  }
  return res.json() as Promise<HistoryPage>
}
