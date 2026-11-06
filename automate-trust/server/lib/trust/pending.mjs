/**
 * Trust steps that pause a run until a person acts on a link (6 Nov 2026, ETHGlobal).
 *
 *   Human approval (World ID)  — the owner approves a payout or refund
 *   Verify human (World ID)    — the customer proves they are one unique person
 *   Collect USDC (Arc)         — the customer pays a link
 *
 * Each step writes one row here, sends the link, and the run stops. The link's
 * page (webhook-core, /webhook/trust/...) resolves the row with an outcome, and
 * the run re-enters AT THE SAME STEP through flow-waits, the way a Wait coming
 * due does. The step then finds its row resolved, takes the outcome's wire
 * (approved / denied / expired / paid ...) and sets the outcome's variables.
 * Re-entering the step rather than the next node keeps one place — the step —
 * deciding which wire an outcome means, and a row is consumed when its wire is
 * taken, so the same person passing the step again later starts afresh.
 *
 * The first outcome wins: a page cannot approve a row that already expired, and
 * a payment that lands after expiry does not reopen it (the page says so).
 *
 * Stored on disk, so a deploy or restart in the middle of a pause loses nothing.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const FILE = () => path.join(process.cwd(), 'data', 'trust-pending.json')
/** Rows kept at most; the oldest finished ones go first. */
const MAX_ROWS = 5_000
/** A finished row is kept this long so its page can still say what happened. */
const KEEP_DONE_MS = 7 * 24 * 3_600_000
/** A pause lasts at least a minute and at most seven days. */
const MIN_TTL_MS = 60_000
const MAX_TTL_MS = 7 * 24 * 3_600_000

export const TRUST_KINDS = ['approval', 'human', 'pay']
const ID = /^[0-9a-f]{24}$/

let rows = null
const load = () => {
  if (rows) return rows
  try { rows = JSON.parse(fs.readFileSync(FILE(), 'utf8')) } catch { rows = [] }
  if (!Array.isArray(rows)) rows = []
  return rows
}
let timer = null
const save = () => {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    try {
      fs.mkdirSync(path.dirname(FILE()), { recursive: true })
      fs.writeFileSync(`${FILE()}.tmp`, JSON.stringify(rows))
      fs.renameSync(`${FILE()}.tmp`, FILE())
    } catch (e) { console.warn(`[trust] save failed: ${e.message}`) }
  }, 200)
  timer.unref?.()
}
/** Tests and shutdown: write now. */
export function flushPending() {
  if (timer) { clearTimeout(timer); timer = null }
  if (!rows) return
  fs.mkdirSync(path.dirname(FILE()), { recursive: true })
  fs.writeFileSync(FILE(), JSON.stringify(rows))
}
/** Tests: forget the in-memory copy so the next call reads the file again. */
export function _resetPending() { rows = null; if (timer) { clearTimeout(timer); timer = null } }

/* Whoever wants to know a row was resolved — webhook-core's resume tick, so a
   person who just approved does not wait up to 30 s for the flow to move. */
const listeners = new Set()
export function onResolved(fn) { listeners.add(fn); return () => listeners.delete(fn) }

const prune = (list, now) => {
  const keep = list.filter((r) => r.status === 'pending' || now - (r.resolvedAt || r.createdAt) < KEEP_DONE_MS)
  if (keep.length > MAX_ROWS) keep.splice(0, keep.length - MAX_ROWS)
  return keep
}

/**
 * Open a pause. `where` is the conversation and step the run re-enters:
 * { slug, workspaceId, phoneId, wabaId, from, profileName, flowKey, nodeId }.
 */
export function createPending({ kind, ttlMs, data = {}, ...where }) {
  if (!TRUST_KINDS.includes(kind)) throw new Error(`unknown trust step kind "${kind}"`)
  if (!where.slug || !where.from || !where.nodeId) throw new Error('a trust step needs the channel, the contact and the step to come back to')
  const now = Date.now()
  const ttl = Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Number(ttlMs) || 30 * 60_000))
  const row = {
    id: crypto.randomBytes(12).toString('hex'), kind, status: 'pending', createdAt: now, expiresAt: now + ttl,
    slug: String(where.slug), workspaceId: where.workspaceId || null, phoneId: where.phoneId || '', wabaId: where.wabaId || '',
    from: String(where.from), profileName: where.profileName || '', flowKey: where.flowKey || null, nodeId: String(where.nodeId),
    data, vars: {}, consumed: false,
  }
  rows = prune(load(), now)
  rows.push(row)
  save()
  return row
}

export const getPending = (id) => (ID.test(String(id || '')) ? load().find((r) => r.id === id) || null : null)

/** Merge into a row's data (a page saving its OIDC state, the payment's block). */
export function patchPending(id, data) {
  const r = getPending(id)
  if (!r) return null
  r.data = { ...r.data, ...data }
  save()
  return r
}

/** The row this person's run left at this step and has not used yet, newest first. */
export function openAt({ slug, from, nodeId }) {
  const list = load()
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i]
    if (r.slug === slug && r.from === from && r.nodeId === nodeId && !r.consumed) return r
  }
  return null
}

/**
 * Give a row its outcome and schedule the run to come back to the step. The
 * first outcome wins; a second returns null and changes nothing.
 * `addWait` is injected by tests; production uses flow-waits.
 */
export async function resolvePending(id, status, vars = {}, { addWait } = {}) {
  const r = getPending(id)
  if (!r || r.status !== 'pending') return null
  r.status = String(status)
  r.vars = Object.fromEntries(Object.entries(vars || {}).slice(0, 20).map(([k, v]) => [String(k).slice(0, 40), String(v ?? '').slice(0, 300)]))
  r.resolvedAt = Date.now()
  save()
  const add = addWait || (await import('../flow-waits.mjs')).addWait
  add({ slug: r.slug, workspaceId: r.workspaceId, phoneId: r.phoneId, wabaId: r.wabaId, from: r.from, nodeId: r.nodeId, dueAt: Date.now(), profileName: r.profileName, flowKey: r.flowKey })
  for (const fn of listeners) { try { fn(r) } catch { /* a listener never blocks the outcome */ } }
  return r
}

/** The step took this row's wire; the next pass through the step opens a new one. */
export function consumePending(id) {
  const r = getPending(id)
  if (!r) return null
  r.consumed = true
  save()
  return r
}

/** Every open row of one kind — the payment watcher's list. */
export const listPending = (kind) => load().filter((r) => r.kind === kind && r.status === 'pending')

/** Rows past their time become "expired", and their runs come back to take that wire. */
export async function sweepExpired(now = Date.now(), opts = {}) {
  const due = load().filter((r) => r.status === 'pending' && r.expiresAt <= now)
  const out = []
  for (const r of due) { const x = await resolvePending(r.id, 'expired', {}, opts); if (x) out.push(x) }
  return out
}
