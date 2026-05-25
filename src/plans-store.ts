// User plan + monthly usage counter — the data layer for the Free/Pro
// scaffold. Pricing is a product decision that isn't wired up yet:
// the rows exist, /me reports them, /upload enforces the free-tier limit,
// but no payment integration runs. Once Stripe is in we'll add a
// webhook-driven setPlan() call from a billing module.

import type { DB } from './db'

export type Plan = 'free' | 'pro'

export interface UserPlanRow {
  user_id: string
  plan: Plan
  updated_at: number
}

export interface UsageRow {
  user_id: string
  month_key: string
  clips_count: number
}

export interface PlansStore {
  getPlan(userId: string): Plan
  setPlan(userId: string, plan: Plan): void
  incrementUsage(userId: string, monthKey: string): number
  getUsage(userId: string, monthKey: string): number
}

function monthKeyOf(now: number): string {
  const d = new Date(now)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

export { monthKeyOf }

export function createPlansStore(db: DB, now: () => number = Date.now): PlansStore {
  const selectPlan = db.query<UserPlanRow, [string]>(
    'SELECT * FROM user_plans WHERE user_id = ?',
  )
  const upsertPlan = db.prepare(
    `INSERT INTO user_plans (user_id, plan, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE
     SET plan = excluded.plan, updated_at = excluded.updated_at`,
  )

  // Atomic increment-or-insert. ON CONFLICT keeps it single-statement so
  // two concurrent /upload calls can't both observe a stale clips_count.
  const incrementUsageStmt = db.query<UsageRow, [string, string]>(
    `INSERT INTO usage_counters (user_id, month_key, clips_count)
     VALUES (?, ?, 1)
     ON CONFLICT(user_id, month_key) DO UPDATE
     SET clips_count = clips_count + 1
     RETURNING *`,
  )
  const selectUsage = db.query<{ clips_count: number }, [string, string]>(
    'SELECT clips_count FROM usage_counters WHERE user_id = ? AND month_key = ?',
  )

  return {
    getPlan(userId: string): Plan {
      const row = selectPlan.get(userId)
      return row?.plan === 'pro' ? 'pro' : 'free'
    },
    setPlan(userId: string, plan: Plan): void {
      upsertPlan.run(userId, plan, now())
    },
    incrementUsage(userId: string, monthKey: string): number {
      const row = incrementUsageStmt.get(userId, monthKey)
      return row?.clips_count ?? 0
    },
    getUsage(userId: string, monthKey: string): number {
      return selectUsage.get(userId, monthKey)?.clips_count ?? 0
    },
  }
}
