/**
 * World ID trust steps (6 Nov 2026, ETHGlobal) — server/lib/trust/world.mjs.
 *
 *   1. startApproval: the authorize URL (PKCE S256, nonce, state with the pending id, max_age, redirect).
 *   2. finishApproval: success, and every way it must refuse (state, signature, aud, nonce, stale
 *      auth_time, expired pending, wrong issuer, alg none).
 *   3. Approver binding: the first sub binds, a different one is refused, unbind frees it.
 *   4. verifyHuman: success, the same nullifier again, wrong environment (no network), World says no.
 *   5. humanRpContext is signed and carries no key.
 *   6. Both pages escape titles; no secret appears in any result or page.
 *
 * No real network: fetch is replaced and every URL it sees is recorded.
 *
 *   node scripts/test-trust-world.mjs
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-world-'))
process.chdir(tmp)

const SECRETS = {
  WORLD_OIDC_CLIENT_SECRET: 'sek-client-secret-9f3a',
  WORLD_SIGNING_KEY: crypto.randomBytes(32).toString('hex'),
}
Object.assign(process.env, {
  WORLD_OIDC_ISSUER: 'https://auth.world.org',
  WORLD_OIDC_CLIENT_ID: 'app_client_test',
  WORLD_APP_ID: 'app_test123',
  WORLD_RP_ID: 'rp_test123',
  WORLD_ENV: 'staging',
  ...SECRETS,
})

let passed = 0, failed = 0
const ok = (cond, msg) => { if (cond) passed++; else { failed++; console.log(`  FAIL: ${msg}`) } }
const section = (n, t) => console.log(`${n}. ${t}`)

/* ---- the fake network ---- */
const seenHosts = new Set()
const calls = []
let tokenBody = null // what the token endpoint should answer with
let verifyAnswer = { success: true }
const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
const ed = crypto.generateKeyPairSync('ed25519')
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = (pub, kid, alg) => ({ ...pub.export({ format: 'jwk' }), kid, alg, use: 'sig' })
const JWKS = { keys: [jwk(rsa.publicKey, 'rsa1', 'RS256'), jwk(ec.publicKey, 'ec1', 'ES256'), jwk(ed.publicKey, 'ed1', 'EdDSA')] }

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url))
  seenHosts.add(u.host)
  calls.push({ url: u.href, method: init.method || 'GET', body: init.body ? String(init.body) : '' })
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })
  if (u.href === 'https://auth.world.org/.well-known/jwks.json') return json(JWKS)
  if (u.href === 'https://auth.world.org/api/v1/token') return tokenBody ? json(tokenBody) : json({ error: 'invalid_grant' }, 400)
  if (u.href === 'https://developer.world.org/api/v4/verify/rp_test123') return json(verifyAnswer, verifyAnswer.success ? 200 : 400)
  return json({ error: 'unexpected host in test' }, 500)
}

const sign = (claims, { alg = 'RS256', kid = 'rsa1', key } = {}) => {
  const h = Buffer.from(JSON.stringify({ alg, kid, typ: 'JWT' })).toString('base64url')
  const p = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const data = Buffer.from(`${h}.${p}`)
  let sig
  if (alg === 'RS256') sig = crypto.sign('sha256', data, key || rsa.privateKey)
  else if (alg === 'ES256') sig = crypto.sign('sha256', data, { key: key || ec.privateKey, dsaEncoding: 'ieee-p1363' })
  else if (alg === 'EdDSA') sig = crypto.sign(null, data, key || ed.privateKey)
  else sig = Buffer.alloc(0)
  return `${h}.${p}.${sig.toString('base64url')}`
}

const W = await import(pathToFileURL(path.join(ROOT, 'server', 'lib', 'trust', 'world.mjs')).href)
const BASE = 'https://automateplatform.in'
const now = () => Math.floor(Date.now() / 1000)
const mkPending = (over = {}) => ({ id: crypto.randomBytes(12).toString('hex'), kind: 'approval', status: 'pending', createdAt: Date.now(), expiresAt: Date.now() + 600_000, workspaceId: 'ws1', slug: 's', from: '919999999999', nodeId: 'n1', data: { title: 'Refund 500', summary: 'Pay it', maxAgeSec: 300 }, ...over })
const claimsFor = (p, over = {}) => ({ iss: 'https://auth.world.org', sub: 'sub-alice', aud: 'app_client_test', exp: now() + 300, iat: now(), auth_time: now(), nonce: p.data.oidc.nonce, acr: 'https://world.org/oidc/acr/orb', ...over })
const begin = (over) => { const p = mkPending(over); const s = W.startApproval(p, { baseUrl: BASE }); p.data.oidc = s.oidc; return { p, s } }
const finish = (p, state) => W.finishApproval({ code: 'c0de', state: state ?? p.data.oidc.state }, p, { baseUrl: BASE })

/* ---- 1 ---- */
section(1, 'startApproval')
{
  const { p, s } = begin()
  const u = new URL(s.url)
  ok(u.origin + u.pathname === 'https://auth.world.org/api/v1/authorize', 'authorize endpoint')
  const q = u.searchParams
  ok(q.get('response_type') === 'code' && q.get('scope') === 'openid', 'code flow, scope openid')
  ok(q.get('client_id') === 'app_client_test', 'client id')
  ok(q.get('redirect_uri') === `${BASE}/webhook/trust/approve/callback`, 'redirect uri')
  ok(q.get('prompt') === 'login' && q.get('max_age') === '300', 'fresh login with max_age')
  ok(q.get('code_challenge_method') === 'S256', 'PKCE S256')
  const want = crypto.createHash('sha256').update(s.oidc.verifier).digest('base64url')
  ok(q.get('code_challenge') === want, 'challenge is the hash of the stored verifier')
  ok(q.get('nonce') === s.oidc.nonce && q.get('state') === s.oidc.state, 'nonce and state match what is saved')
  ok(s.oidc.state.startsWith(`${p.id}.`) && s.oidc.state.length > p.id.length + 20, 'state embeds the pending id plus randomness')
  ok(s.oidc.maxAgeSec === 300, 'maxAgeSec saved')
  ok(!s.url.includes(SECRETS.WORLD_OIDC_CLIENT_SECRET) && !JSON.stringify(s).includes(SECRETS.WORLD_OIDC_CLIENT_SECRET), 'no secret in the start result')
  ok(calls.length === 0, 'starting makes no network call')
}

/* ---- 2 ---- */
section(2, 'finishApproval')
{
  W._resetJwksCache()
  let { p } = begin({ workspaceId: 'wsA' })
  tokenBody = { id_token: sign(claimsFor(p)) }
  let r = await finish(p)
  ok(r.ok === true && r.sub === 'sub-alice' && r.acr.endsWith('/orb') && r.authTime > 0, 'RS256 success')
  const tc = calls.find((c) => c.url.endsWith('/api/v1/token'))
  ok(tc && tc.body.includes('client_secret=') && tc.body.includes('code_verifier=') && tc.body.includes('grant_type=authorization_code'), 'token call is client_secret_post with the verifier')
  ok(calls.filter((c) => c.url.endsWith('jwks.json')).length === 1, 'JWKS fetched once')

  ;({ p } = begin({ workspaceId: 'wsB' }))
  tokenBody = { id_token: sign(claimsFor(p), { alg: 'ES256', kid: 'ec1' }) }
  r = await finish(p)
  ok(r.ok === true, 'ES256 success')
  ok(calls.filter((c) => c.url.endsWith('jwks.json')).length === 1, 'JWKS cached across calls')
  ;({ p } = begin({ workspaceId: 'wsC' }))
  tokenBody = { id_token: sign(claimsFor(p), { alg: 'EdDSA', kid: 'ed1' }) }
  ok((await finish(p)).ok === true, 'EdDSA success')

  ;({ p } = begin({ workspaceId: 'wsD' }))
  tokenBody = { id_token: sign(claimsFor(p)) }
  r = await finish(p, `${p.id}.deadbeef`)
  ok(r.ok === false && /match/.test(r.reason), 'wrong state refused')
  r = await W.finishApproval({ code: 'x', state: '' }, p, { baseUrl: BASE })
  ok(r.ok === false, 'missing state refused')

  tokenBody = { id_token: sign(claimsFor(p), { key: other.privateKey }) }
  r = await finish(p)
  ok(r.ok === false && /signature/.test(r.reason), 'bad signature refused')
  tokenBody = { id_token: sign(claimsFor(p), { alg: 'none' }) }
  r = await finish(p)
  ok(r.ok === false && /signing method/.test(r.reason), 'alg none refused')
  tokenBody = { id_token: sign(claimsFor(p), { kid: 'nope' }) }
  const before = calls.filter((c) => c.url.endsWith('jwks.json')).length
  r = await finish(p)
  ok(r.ok === false && /unknown key/.test(r.reason) && calls.filter((c) => c.url.endsWith('jwks.json')).length === before + 1, 'unknown kid refetches once, then refuses')

  tokenBody = { id_token: sign(claimsFor(p, { aud: 'someone_else' })) }
  ok((await finish(p)).ok === false, 'wrong aud refused')
  tokenBody = { id_token: sign(claimsFor(p, { aud: ['x', 'app_client_test'] })) }
  ok((await finish(p)).ok === true, 'aud array containing our client id accepted')
  tokenBody = { id_token: sign(claimsFor(p, { nonce: 'not-mine' })) }
  ok((await finish(p)).ok === false, 'wrong nonce refused')
  tokenBody = { id_token: sign(claimsFor(p, { auth_time: now() - 3600 })) }
  r = await finish(p)
  ok(r.ok === false && /recent/.test(r.reason), 'stale auth_time refused')
  tokenBody = { id_token: sign(claimsFor(p, { iss: 'https://evil.example' })) }
  ok((await finish(p)).ok === false, 'wrong issuer refused')
  tokenBody = { id_token: sign(claimsFor(p, { exp: now() - 600 })) }
  ok((await finish(p)).ok === false, 'expired token refused')

  const exp = begin({ expiresAt: Date.now() - 1000 }).p
  tokenBody = { id_token: sign(claimsFor(exp)) }
  const n = calls.length
  r = await finish(exp)
  ok(r.ok === false && /expired/.test(r.reason) && calls.length === n, 'expired pending refused before any network call')
  const done = begin({ status: 'approved' }).p
  ok((await finish(done)).ok === false, 'already answered refused')
  tokenBody = null
  ok((await finish(begin().p)).ok === false, 'token endpoint refusal handled')
}

/* ---- 3 ---- */
section(3, 'approver binding')
{
  ok(W.approverFor('wsX') === null, 'nobody bound at first')
  let { p } = begin({ workspaceId: 'wsX' })
  tokenBody = { id_token: sign(claimsFor(p, { sub: 'sub-first' })) }
  ok((await finish(p)).ok === true && W.approverFor('wsX') === 'sub-first', 'first approval binds its sub')
  ;({ p } = begin({ workspaceId: 'wsX' }))
  tokenBody = { id_token: sign(claimsFor(p, { sub: 'sub-first' })) }
  ok((await finish(p)).ok === true, 'same sub approves again')
  ;({ p } = begin({ workspaceId: 'wsX' }))
  tokenBody = { id_token: sign(claimsFor(p, { sub: 'sub-second' })) }
  const r = await finish(p)
  ok(r.ok === false && r.reason === "a different World ID than this account's approver", 'a different sub is refused')
  ok(W.approverFor('wsX') === 'sub-first', 'binding unchanged by the refusal')
  W.unbindApprover('wsX')
  ok(W.approverFor('wsX') === null, 'unbind frees it')
  ok(!fs.existsSync(path.join(tmp, 'data', 'world-approvers.json.tmp')), 'atomic write left no tmp file')
  W.bindApprover('wsY', 'sub-y')
  ok(W.approverFor('wsY') === 'sub-y', 'bindApprover sets directly')
}

/* ---- 4 ---- */
section(4, 'verifyHuman')
{
  const hp = mkPending({ kind: 'human', data: { title: 'One refund', action: 'refund', rpNonces: ['0x1'] } })
  const proof = (nul, over = {}) => ({ protocol_version: '4.0', nonce: '0x1', action: 'refund', environment: 'staging', responses: [{ identifier: 'proof_of_human', proof: ['1', '2', '3', '4', '5'], nullifier: nul, issuer_schema_id: 1, expires_at_min: 1 }], ...over })
  verifyAnswer = { success: true }
  let n = calls.length
  let r = await W.verifyHuman(hp, proof('12345'), { action: 'refund' })
  ok(r.ok === true && r.nullifier === '12345', 'success returns the nullifier')
  const vc = calls.slice(n).find((c) => c.url.includes('/api/v4/verify/'))
  ok(vc && vc.method === 'POST' && JSON.parse(vc.body).responses[0].nullifier === '12345' && JSON.parse(vc.body).action === 'refund', 'result forwarded to World, with the server action pinned')
  const book = fs.readFileSync(path.join(tmp, 'data', 'world-nullifiers.json'), 'utf8')
  ok(book.includes('12345') && !book.includes('"proof"'), 'nullifier stored, raw proof not')

  n = calls.length
  r = await W.verifyHuman(mkPending({ kind: 'human', data: { rpNonces: ['0x1'] } }), proof('12345'), { action: 'refund' })
  ok(r.ok === false && r.already === true && calls.length === n, 'same nullifier again -> already, no network')
  r = await W.verifyHuman(hp, proof('12345'), { action: 'other-action' })
  ok(r.ok === false && !r.already, 'a proof made for another action is refused')
  r = await W.verifyHuman(hp, proof('999'), { action: 'other-action' })
  ok(r.ok === false, 'action mismatch refused even for a new nullifier')

  n = calls.length
  r = await W.verifyHuman(hp, proof('777', { environment: 'production' }), { action: 'refund' })
  ok(r.ok === false && /staging/.test(r.reason) && calls.length === n, 'environment mismatch refused without a network call')

  verifyAnswer = { success: false, detail: 'invalid proof' }
  r = await W.verifyHuman(hp, proof('555'), { action: 'refund' })
  ok(r.ok === false && !r.already && r.reason === 'invalid proof', 'World success:false refused')
  verifyAnswer = { success: true }
  r = await W.verifyHuman(hp, proof('555'), { action: 'refund' })
  ok(r.ok === true, 'a refused proof did not use up the nullifier')
  r = await W.verifyHuman(mkPending({ expiresAt: Date.now() - 1 }), proof('888'), { action: 'refund' })
  ok(r.ok === false && /expired/.test(r.reason), 'expired pending refused')
  r = await W.verifyHuman(hp, { environment: 'staging', responses: [] }, { action: 'refund' })
  ok(r.ok === false, 'proof without a nullifier refused')

  /* Bound to this request (6 Nov security review): nonce, action, signal. */
  n = calls.length
  r = await W.verifyHuman(hp, proof('4242', { nonce: '0x2' }), { action: 'refund' })
  ok(r.ok === false && /not made for this request/.test(r.reason) && calls.length === n, 'a nonce this server did not issue for this link is refused, no network')
  r = await W.verifyHuman(mkPending({ kind: 'human' }), proof('4243'), { action: 'refund' })
  ok(r.ok === false && calls.length === n, 'a link that never issued a request accepts no proof')
  const noAction = proof('4244'); delete noAction.action
  n = calls.length
  r = await W.verifyHuman(hp, noAction, { action: 'refund' })
  const pinned = calls.slice(n).find((c) => c.url.includes('/api/v4/verify/'))
  ok(r.ok === true && pinned && JSON.parse(pinned.body).action === 'refund', 'a proof with no action is verified by World against OUR action (not skipped)')
  const { hashSignal } = await import('@worldcoin/idkit-core/hashing')
  const withSig = (nul, sig) => proof(nul, { responses: [{ identifier: 'proof_of_human', proof: ['1'], nullifier: nul, signal_hash: sig }] })
  r = await W.verifyHuman(hp, withSig('4245', hashSignal('some-other-link')), { action: 'refund' })
  ok(r.ok === false && /different link/.test(r.reason), 'a signal hash for another link is refused')
  r = await W.verifyHuman(hp, withSig('4246', hashSignal(hp.id)), { action: 'refund' })
  ok(r.ok === true, 'the signal hash of this link passes')
}

/* ---- 5 ---- */
section(5, 'humanRpContext')
{
  const c = await W.humanRpContext('refund')
  ok(c.rp_id === 'rp_test123' && c.nonce && c.signature && c.created_at < c.expires_at, 'rp_context has id, nonce, signature, window')
  ok(!JSON.stringify(c).includes(SECRETS.WORLD_SIGNING_KEY), 'rp_context carries no signing key')
  const keep = process.env.WORLD_SIGNING_KEY
  delete process.env.WORLD_SIGNING_KEY
  let msg = ''
  try { await W.humanRpContext('refund') } catch (e) { msg = e.message }
  ok(/WORLD_SIGNING_KEY/.test(msg) && !msg.includes(keep), 'unconfigured throws naming the variable only')
  const cfg = W.worldConfig()
  ok(cfg.human.ready === false && cfg.human.missing.includes('WORLD_SIGNING_KEY') && cfg.approval.ready === true, 'worldConfig reports what is missing')
  process.env.WORLD_SIGNING_KEY = keep
  ok(!JSON.stringify(W.worldConfig()).includes(keep) && !JSON.stringify(W.worldConfig()).includes(SECRETS.WORLD_OIDC_CLIENT_SECRET), 'worldConfig has no secret')
}

/* ---- 6 ---- */
section(6, 'pages')
{
  const evil = mkPending({ data: { title: '<script>alert(1)</script>', summary: '"><img src=x onerror=alert(2)>' } })
  const pages = [
    W.approvalPageHtml({ pending: evil, startUrl: '/s?a=1&b="2"', denyUrl: '/d', state: 'open' }),
    ...['approved', 'denied', 'expired', 'error'].map((state) => W.approvalPageHtml({ pending: evil, state, message: '<b>x</b>' })),
    W.humanPageHtml({ pending: evil, action: 'refund', rpUrl: '/rp', verifyUrl: '/v', cancelUrl: '/c', state: 'open' }),
    ...['verified', 'already', 'cancelled', 'expired', 'error'].map((state) => W.humanPageHtml({ pending: evil, action: 'refund', state })),
  ]
  ok(pages.every((h) => !h.includes('<script>alert(1)') && !h.includes('<img src=x') && !h.includes('<b>x</b>')), 'titles, summaries and messages are escaped on every state')
  ok(pages.every((h) => h.startsWith('<!doctype html>') && h.includes('Secured by World ID · Automate')), 'full documents with the footer')
  ok(pages[0].includes('Approve with World ID') && pages[0].includes('method="post" action="/d"') && pages[0].includes('&quot;2&quot;'), 'approval page: approve link, deny form, attributes escaped')
  const human = pages.find((h) => h.includes('idkit-core@4.6.0'))
  ok(human && human.includes('qrcode-generator@1.4.4') && human.includes('Open World App') && human.includes('action="/c"'), 'human page: idkit, QR, deep link, cancel')
  ok(human.includes('app_test123') && !human.includes('rp_test123'), 'human page carries the app id only')
  ok(pages.every((h) => !h.toLowerCase().includes('#fff') && !h.includes(SECRETS.WORLD_SIGNING_KEY) && !h.includes(SECRETS.WORLD_OIDC_CLIENT_SECRET)), 'no pure white, no secret in any page')
  ok(!JSON.stringify(calls).includes(SECRETS.WORLD_SIGNING_KEY), 'signing key never went over the network')
}

section(7, 'network')
{
  const allowed = new Set(['auth.world.org', 'developer.world.org'])
  const bad = [...seenHosts].filter((h) => !allowed.has(h))
  ok(bad.length === 0, `only the expected hosts were fetched (saw ${[...seenHosts].join(', ')})`)
}

process.chdir(ROOT)
try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* temp dir cleanup is best effort */ }
console.log(`${passed} passed${failed ? `, ${failed} FAILED` : ''}`)
process.exit(failed ? 1 : 0)
