/**
 * The pages a trust step's link opens (6 Nov 2026, ETHGlobal) — public, above
 * the operator-auth gate, because the person opening them (an approver, a
 * customer) has no Automate account. The 24-hex token in the path is the only
 * key, so:
 *   - every outcome is checked on the server (World's id_token and proof, the
 *     USDC transfer on Arc) — nothing the browser says is taken as an outcome;
 *   - the only outcomes a bare link can cause are the SAFE ones: deny, cancel
 *     (the protected step does not run);
 *   - pages are no-store and send no Referer, so the token stays out of
 *     caches and other sites' logs.
 *
 *   GET  /webhook/trust/approve/:id            the approval page
 *   GET  /webhook/trust/approve/:id/start      → World ID sign-in (Agent Pass)
 *   GET  /webhook/trust/approve/callback       ← World ID returns here
 *   POST /webhook/trust/approve/:id/deny
 *   GET  /webhook/trust/human/:id              the World ID (IDKit) page
 *   GET  /webhook/trust/human/:id/rp           the signed request for IDKit
 *   POST /webhook/trust/human/:id/verify       the proof, checked with World
 *   POST /webhook/trust/human/:id/cancel
 *   GET  /webhook/trust/pay/:id                the USDC payment page
 *   GET  /webhook/trust/pay/:id/status         polled by that page
 */
import crypto from 'node:crypto'

const HEAD = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' }
export const trustBase = () => String(process.env.TRUST_BASE_URL || process.env.PUBLIC_URL || 'https://automateplatform.in').replace(/\/+$/, '')
const short = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16)

/** Handles a /webhook/trust/... request; returns false for any other path. */
export async function handleTrustRoute({ req, res, url, readBody, push = () => {} }) {
  const m = url.pathname.match(/^\/webhook\/trust\/(approve|human|pay)\/([0-9a-f]{24}|callback)(?:\/(start|deny|rp|verify|cancel|status))?$/)
  if (!m) return false
  const [, kind, idOrCb, action = ''] = m
  const html = (code, body) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', ...HEAD }); res.end(body); return true }
  const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', ...HEAD }); res.end(JSON.stringify(body)); return true }
  const redirect = (to) => { res.writeHead(302, { Location: to, ...HEAD }); res.end(); return true }
  const P = await import('./pending.mjs')
  const base = trustBase()

  /* A row past its time is expired even if the 10-second sweep has not
     reached it yet — the page must never offer an action that will not count. */
  const fresh = async (row) => {
    if (row?.status === 'pending' && row.expiresAt <= Date.now()) await P.resolvePending(row.id, 'expired')
    return row ? P.getPending(row.id) : null
  }

  if (kind === 'approve') {
    const W = await import('./world.mjs')
    if (idOrCb === 'callback') {
      if (req.method !== 'GET') return json(405, { error: 'method not allowed' })
      const state = String(url.searchParams.get('state') || '')
      const row = await fresh(P.getPending(state.split('.')[0]))
      if (!row || row.kind !== 'approval') return html(404, W.approvalPageHtml({ pending: { data: { title: 'Approval' } }, state: 'error', message: 'This approval link is not valid.' }))
      const page = (state, message) => html(200, W.approvalPageHtml({ pending: row, startUrl: `${base}/webhook/trust/approve/${row.id}/start`, denyUrl: `${base}/webhook/trust/approve/${row.id}/deny`, state, message }))
      if (row.status !== 'pending') return page(row.status)
      if (url.searchParams.get('error')) return page('error', 'World ID sign-in did not finish. You can try again, or deny.')
      const r = await W.finishApproval({ code: String(url.searchParams.get('code') || ''), state }, row, { baseUrl: base })
      if (!r.ok) {
        push('flow', `approval ${row.id.slice(0, 6)}: World ID check failed — ${r.reason}`, undefined, row.workspaceId)
        return page('error', r.reason)
      }
      await P.resolvePending(row.id, 'approved', { approval_by: short(r.sub), approval_acr: r.acr || '', approval_at: new Date().toISOString() })
      push('flow', `approval ${row.id.slice(0, 6)} approved with World ID`, undefined, row.workspaceId)
      return page('approved')
    }
    const row = await fresh(P.getPending(idOrCb))
    if (!row || row.kind !== 'approval') return html(404, W.approvalPageHtml({ pending: { data: { title: 'Approval' } }, state: 'error', message: 'This approval link is not valid.' }))
    const startUrl = `${base}/webhook/trust/approve/${row.id}/start`, denyUrl = `${base}/webhook/trust/approve/${row.id}/deny`
    if (action === 'start') {
      if (row.status !== 'pending') return redirect(`${base}/webhook/trust/approve/${row.id}`)
      try {
        const { url: to, oidc } = W.startApproval(row, { baseUrl: base, maxAgeSec: 300 })
        P.patchPending(row.id, { oidc })
        return redirect(to)
      } catch (e) { return html(503, W.approvalPageHtml({ pending: row, startUrl, denyUrl, state: 'error', message: e.message })) }
    }
    if (action === 'deny') {
      if (req.method !== 'POST') return json(405, { error: 'method not allowed' })
      if (await P.resolvePending(row.id, 'denied', { approval_at: new Date().toISOString() })) push('flow', `approval ${row.id.slice(0, 6)} denied`, undefined, row.workspaceId)
      return html(200, W.approvalPageHtml({ pending: P.getPending(row.id), startUrl, denyUrl, state: P.getPending(row.id).status }))
    }
    if (action) return json(404, { error: 'not found' })
    return html(200, W.approvalPageHtml({ pending: row, startUrl, denyUrl, state: row.status === 'pending' ? 'open' : row.status }))
  }

  if (kind === 'human') {
    const W = await import('./world.mjs')
    const row = await fresh(P.getPending(idOrCb))
    const urls = (id) => ({ rpUrl: `${base}/webhook/trust/human/${id}/rp`, verifyUrl: `${base}/webhook/trust/human/${id}/verify`, cancelUrl: `${base}/webhook/trust/human/${id}/cancel` })
    if (!row || row.kind !== 'human') return action ? json(404, { ok: false, reason: 'This link is not valid.' }) : html(404, W.humanPageHtml({ pending: { data: { title: 'Verify' } }, action: '', ...urls('x'), state: 'error', message: 'This link is not valid.' }))
    const action_ = row.data?.action || 'refund'
    const closed = row.status !== 'pending'
    if (action === 'rp') {
      if (closed) return json(409, { ok: false, reason: `This request is already ${row.status}.` })
      try {
        const rp = await W.humanRpContext(action_)
        /* The nonce is kept on the row: verifyHuman accepts only a proof made
           for a request this server signed for THIS link (the last few, as a
           page can be reloaded). */
        P.patchPending(row.id, { rpNonces: [...(row.data?.rpNonces || []).slice(-4), String(rp.nonce)] })
        return json(200, { rp_context: rp })
      } catch (e) { return json(503, { ok: false, reason: e.message }) }
    }
    if (action === 'verify') {
      if (req.method !== 'POST') return json(405, { error: 'method not allowed' })
      if (closed) return json(409, { ok: false, reason: `This request is already ${row.status}.` })
      let result
      try { result = JSON.parse((await readBody(req)) || '{}') } catch { return json(400, { ok: false, reason: 'The proof could not be read.' }) }
      const r = await W.verifyHuman(row, result, { action: action_ })
      if (r.ok) {
        await P.resolvePending(row.id, 'verified', { human_id: short(`${action_}|${r.nullifier}`) })
        push('flow', `World ID proof verified for "${action_}"`, undefined, row.workspaceId)
      } else if (r.already) {
        await P.resolvePending(row.id, 'already', {})
        push('flow', `World ID: this person already passed "${action_}" — refused`, undefined, row.workspaceId)
      }
      return json(r.ok ? 200 : r.already ? 409 : 400, r.ok ? { ok: true } : { ok: false, already: !!r.already, reason: r.reason })
    }
    if (action === 'cancel') {
      if (req.method !== 'POST') return json(405, { error: 'method not allowed' })
      await P.resolvePending(row.id, 'cancelled', {})
      const now = P.getPending(row.id)
      return html(200, W.humanPageHtml({ pending: now, action: action_, ...urls(row.id), state: now.status === 'pending' ? 'open' : now.status }))
    }
    if (action) return json(404, { error: 'not found' })
    return html(200, W.humanPageHtml({ pending: row, action: action_, ...urls(row.id), state: closed ? row.status : 'open' }))
  }

  /* pay */
  const A = await import('./arc.mjs')
  const row = await fresh(P.getPending(idOrCb))
  if (!row || row.kind !== 'pay') return action ? json(404, { status: 'missing' }) : html(404, A.payPageHtml({ pending: { data: { label: 'Payment' } }, statusUrl: '', state: 'error', message: 'This payment link is not valid.' }))
  const txHash = row.vars?.usdc_tx || ''
  if (action === 'status') return json(200, { status: row.status, txHash: txHash || null, explorerUrl: txHash ? A.explorerTx(txHash) : null })
  if (action) return json(404, { error: 'not found' })
  return html(200, A.payPageHtml({ pending: row, statusUrl: `${base}/webhook/trust/pay/${row.id}/status`, state: row.status === 'pending' ? 'open' : row.status === 'paid' ? 'paid' : 'expired', txHash }))
}
