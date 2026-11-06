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
 *   GET  /webhook/trust/verify[/:root]         the public "verify a run" page:
 *                                              a 0G root hash in, the sealed
 *                                              record and its checks out
 */
import crypto from 'node:crypto'

const HEAD = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' }
export const trustBase = () => String(process.env.TRUST_BASE_URL || process.env.PUBLIC_URL || 'https://automateplatform.in').replace(/\/+$/, '')
const short = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16)

/** Handles a /webhook/trust/... request; returns false for any other path. */
export async function handleTrustRoute({ req, res, url, readBody, push = () => {}, findRun = null }) {
  const m = url.pathname.match(/^\/webhook\/trust\/(approve|human|pay)\/([0-9a-f]{24}|callback)(?:\/(start|deny|rp|verify|cancel|status))?$/)
  const vm = url.pathname.match(/^\/webhook\/trust\/verify(?:\/([^/]+))?\/?$/)
  if (!m && !vm) return false
  const html = (code, body) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', ...HEAD }); res.end(body); return true }
  const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', ...HEAD }); res.end(JSON.stringify(body)); return true }
  const redirect = (to) => { res.writeHead(302, { Location: to, ...HEAD }); res.end(); return true }

  /* The public "verify a run" page (6 Nov 2026). Read-only: GET, and nothing
     it does writes anything. ?root= (the form) redirects to the path form, so
     a checked run has one shareable address. */
  if (vm) {
    if (req.method !== 'GET') return json(405, { error: 'method not allowed' })
    const asked = decodeURIComponent(vm[1] || '').trim()
    const q = String(url.searchParams.get('root') || '').trim()
    if (!asked && q) return redirect(`/webhook/trust/verify/${encodeURIComponent(q)}`)
    if (!asked) return html(200, verifyPageHtml({}))
    const Z = await import('./zg.mjs')
    const result = await Z.verifyRoot(asked, { findRun })
    return html(result.root ? 200 : 400, verifyPageHtml({ asked, result }))
  }

  const [, kind, idOrCb, action = ''] = m
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

/* ── the public "verify a run" page ─────────────────────────────────────────
   Everything shown comes from the record on 0G, which is public already: step
   titles, outcomes and transaction hashes — never a phone number or message
   text (proofRecord keeps them out). Every value is escaped. No platform name:
   the businesses using this are white-label. */
const escH = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const ARC_TX = 'https://explorer.testnet.arc.io/tx/'
const STEP_NAMES = {
  world_approval: 'Human approval · World ID', world_human: 'Verify human · World ID',
  usdc_collect: 'Collect USDC · Arc', usdc_send: 'Send USDC · Arc', aistep: 'AI step · 0G Compute Router', proof0g: 'Proof on 0G',
}
const isHash = (s) => /^0x[0-9a-fA-F]{64}$/.test(String(s || ''))
const clipMid = (s, n = 10) => { const t = String(s || ''); return t.length > n * 2 + 1 ? `${t.slice(0, n)}…${t.slice(-6)}` : t }

export function verifyPageHtml({ asked = '', result = null } = {}) {
  const r = result || {}
  const rec = r.record || null
  const tag = !result ? '' : r.ok === true ? '<p class="tag ok">Matches</p>' : r.ok === null ? '<p class="tag">Found on 0G</p>' : '<p class="tag bad">Does not match</p>'
  const check = (label, v) => (v ? `<div class="row"><span class="k">${escH(label)}</span><code>${escH(v)}</code>${r.checks?.downloaded && v === r.checks.downloaded ? '<span class="yes">✓</span>' : '<span class="no">✗</span>'}</div>` : '')
  const trustRows = (rec?.trust || []).map((t) => {
    const tx = isHash(t.tx) ? `<a class="link" href="${escH(ARC_TX + t.tx)}" rel="noopener">${escH(clipMid(t.tx))}</a>` : ''
    const more = [t.amount && escH(t.amount), tx, t.requestId && `0G request ${escH(clipMid(t.requestId, 8))}`, t.model && escH(t.model), t.approver && `approver ${escH(clipMid(t.approver, 6))}`, t.action && `action “${escH(t.action)}”`].filter(Boolean).join(' · ')
    return `<tr><td>${escH(STEP_NAMES[t.step] || t.step || '')}</td><td><b>${escH(t.outcome || '')}</b></td><td>${more}</td></tr>`
  }).join('')
  const pathRows = (rec?.path || []).map((p) => `<li>${escH(p.title || p.type)} <span class="dim">${escH(STEP_NAMES[p.type] ? STEP_NAMES[p.type] : p.type)}</span></li>`).join('')
  const body = !result
    ? `<h1>Verify a run</h1><p class="note">Paste the root hash shown on a run's Proof on 0G. The record is downloaded from 0G Storage with its Merkle proof and checked.</p>`
    : !r.root
      ? `<h1>Verify a run</h1><p class="note">${escH(r.reason)}</p>`
      : `${tag}<h1>Run record on 0G</h1><p class="note">${escH(r.reason)}</p>
        <div class="box"><span class="k">Root hash</span><code>${escH(r.root)}</code>
          ${r.explorer ? `<p><a class="link" href="${escH(r.explorer)}" rel="noopener">The upload transaction on 0G</a></p>` : ''}</div>
        ${r.checks?.downloaded ? `<div class="box"><span class="k">sha256 of the record</span>
          ${check('Downloaded from 0G', r.checks.downloaded)}${check('Stored when sealed', r.checks.stored)}${check('Rebuilt from the run now', r.checks.rebuilt)}</div>` : ''}
        ${rec ? `<div class="box"><span class="k">The run</span>
          <p>${escH(rec.run || '')} · ${escH(rec.status || '')} · ${escH(String(rec.at || '').replace('T', ' ').slice(0, 19))} UTC · ${escH(rec.channel || rec.trigger || '')}</p>
          ${pathRows ? `<ol class="path">${pathRows}</ol>` : ''}</div>
        ${trustRows ? `<div class="box"><span class="k">Approvals, payments and proofs</span><table>${trustRows}</table></div>` : ''}` : ''}`
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Verify a run on 0G</title>
<style>
:root{--bg:#0B0D0C;--ink:#D1D1D1;--dim:#8A8F8C;--line:#242826;--panel:#141715;--accent:#3DDC84;--bad:#FF6A5C}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:720px;margin:0 auto;padding:32px 16px}
h1{font-size:24px;font-weight:600;margin:0 0 8px}
.note{color:var(--dim);font-size:15px;margin:8px 0 16px}
.tag{display:inline-block;margin:0 0 12px;padding:4px 12px;border-radius:8px;border:1px solid var(--line);font-weight:700}
.tag.ok{background:var(--accent);color:#0B0D0C;border-color:var(--accent)}
.tag.bad{border-color:var(--bad);color:var(--bad)}
.box{margin:16px 0;padding:12px 16px;border:1px solid var(--line);border-radius:12px;background:var(--panel)}
.k{display:block;color:var(--dim);font-size:13px;margin-bottom:6px}
code{font:13px/1.4 ui-monospace,Consolas,monospace;overflow-wrap:anywhere}
.row{display:grid;grid-template-columns:1fr;gap:2px;margin:8px 0}
.row .k{margin:0}.yes{color:var(--accent);font-weight:700}.no{color:var(--bad);font-weight:700}
.path{margin:8px 0 0;padding-left:20px}.dim{color:var(--dim);font-size:13px}
table{width:100%;border-collapse:collapse;font-size:14px}td{padding:8px 6px;border-top:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}
.link{color:var(--ink);text-decoration:underline;overflow-wrap:anywhere}
form{display:flex;gap:8px;margin:24px 0 0;flex-wrap:wrap}
input{flex:1;min-width:0;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--panel);color:var(--ink);font:13px ui-monospace,Consolas,monospace}
button{padding:12px 16px;border:0;border-radius:10px;background:var(--accent);color:#0B0D0C;font:inherit;font-weight:700;cursor:pointer}
footer{margin-top:32px;color:var(--dim);font-size:13px}
</style></head>
<body><main>${body}
<form method="get" action="/webhook/trust/verify"><input name="root" placeholder="0x… root hash" value="${escH(asked)}" aria-label="0G root hash" autocomplete="off" spellcheck="false"><button type="submit">Check</button></form>
<footer>Records are stored on 0G Storage and checked live, with the Merkle proof.</footer></main></body></html>`
}
