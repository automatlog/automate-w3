/**
 * World ID for trust steps (6 Nov 2026, ETHGlobal) — two checks a flow can wait on.
 *
 *   approval  "a real person says yes": World's IdP (OIDC, issuer auth.world.org),
 *             authorization-code + PKCE, a fresh login (prompt=login + max_age) so the
 *             yes is a step-up made now, not a session left open from last week.
 *   human     "one claim per human": IDKit proof of human. The browser makes the
 *             proof; this file signs the request (the key never leaves the server)
 *             and asks World's verify API whether the proof is real.
 *
 * Nothing here persists a pending record or resumes a flow — the caller owns that.
 * These functions read the record and return what to save. Only two small files
 * live here: the approver binding and the used nullifiers.
 *
 * What was read in node_modules/@worldcoin (idkit-core 4.6.0, not guessed):
 *  - idkit-core/dist/index.d.ts: IDKit.request({ app_id, action, rp_context,
 *    allow_legacy_proofs, environment?, return_to? }).preset(proofOfHuman({ signal }))
 *    resolves to a request with `connectorURI` and `pollUntilCompletion()` ->
 *    { success:true, result } | { success:false, error }. rp_context =
 *    { rp_id, nonce, created_at, expires_at, signature }.
 *  - idkit-core/dist/signing.d.ts re-exports idkit-server's
 *    signRequest({ signingKeyHex, action?, ttl? }) -> { sig, nonce, createdAt, expiresAt }.
 *  - idkit-core/dist/idkit.global.js (package.json "jsdelivr") sets window.IDKit with
 *    request + proofOfHuman, so the page loads that one file and needs no bundler.
 *  - Result items: V4 `responses[].nullifier` is decimal, V3 is hex; `environment` is
 *    on the result. The README posts the result unchanged to
 *    /api/v4/verify/{rp_id} and reads `success`.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const IDKIT_VERSION = '4.6.0'
const IDKIT_SRC = `https://cdn.jsdelivr.net/npm/@worldcoin/idkit-core@${IDKIT_VERSION}/dist/idkit.global.js`
const QR_SRC = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/+esm'
const CALLBACK_PATH = '/webhook/trust/approve/callback'
const SKEW_SEC = 60
const NET_MS = 10_000
const JWKS_TTL = 10 * 60_000

const env = (k) => String(process.env[k] || '').trim()
const issuer = () => (env('WORLD_OIDC_ISSUER') || 'https://auth.world.org').replace(/\/+$/, '')
const worldEnv = () => (env('WORLD_ENV').toLowerCase() === 'production' ? 'production' : 'staging')
const verifyBase = () => (env('WORLD_VERIFY_BASE') || 'https://developer.world.org').replace(/\/+$/, '')

/** What is set and what is missing — names only, never values. */
export function worldConfig() {
  const need = (names) => names.filter((n) => !env(n))
  const a = need(['WORLD_OIDC_CLIENT_ID', 'WORLD_OIDC_CLIENT_SECRET'])
  const h = need(['WORLD_APP_ID', 'WORLD_RP_ID', 'WORLD_SIGNING_KEY'])
  return {
    approval: { ready: !a.length, missing: a },
    human: { ready: !h.length, missing: h, appId: env('WORLD_APP_ID'), rpId: env('WORLD_RP_ID'), env: worldEnv() },
  }
}

/* ---------- small helpers ---------- */

export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const b64u = (buf) => Buffer.from(buf).toString('base64url')
const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}
const fail = (reason) => ({ ok: false, reason })

/** JSON file under data/, read fresh each time (tiny files; no stale cache). */
const dataFile = (name) => path.join(process.cwd(), 'data', name)
function readJson(name) {
  try {
    const v = JSON.parse(fs.readFileSync(dataFile(name), 'utf8'))
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch { return {} }
}
/** tmp + rename, so a crash mid-write never leaves half a file (same as flow-waits). */
function writeJson(name, obj) {
  const f = dataFile(name)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(obj))
  fs.renameSync(`${f}.tmp`, f)
}

const netFetch = (url, init = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(NET_MS) })

/* ---------- approver binding ----------
   The first World ID to approve for a workspace becomes its approver; a different
   human cannot later approve on the owner's behalf. */
export const approverFor = (workspaceId) => readJson('world-approvers.json')[String(workspaceId)]?.sub || null
export function bindApprover(workspaceId, sub) {
  const all = readJson('world-approvers.json')
  all[String(workspaceId)] = { sub: String(sub), at: Date.now() }
  writeJson('world-approvers.json', all)
}
export function unbindApprover(workspaceId) {
  const all = readJson('world-approvers.json')
  delete all[String(workspaceId)]
  writeJson('world-approvers.json', all)
}

/* ---------- approval: OIDC code + PKCE ---------- */

export function startApproval(pending, { baseUrl, maxAgeSec = 300 } = {}) {
  const cfg = worldConfig().approval
  if (!cfg.ready) throw new Error(`World approval is not set up (missing ${cfg.missing.join(', ')})`)
  const state = `${pending.id}.${crypto.randomBytes(16).toString('hex')}`
  const nonce = crypto.randomBytes(16).toString('hex')
  const verifier = b64u(crypto.randomBytes(32))
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: env('WORLD_OIDC_CLIENT_ID'),
    redirect_uri: `${baseUrl}${CALLBACK_PATH}`,
    scope: 'openid',
    state,
    nonce,
    prompt: 'login', // always a fresh login: a step-up, not a lingering session
    max_age: String(maxAgeSec),
    code_challenge: b64u(crypto.createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
  })
  return { url: `${issuer()}/api/v1/authorize?${q}`, oidc: { state, nonce, verifier, maxAgeSec } }
}

/* JWKS cache, keyed by issuer so a changed WORLD_OIDC_ISSUER never reuses old keys. */
let jwks = { iss: '', at: 0, keys: [] }
export const _resetJwksCache = () => { jwks = { iss: '', at: 0, keys: [] } }
async function loadJwks(force) {
  const iss = issuer()
  if (!force && jwks.iss === iss && Date.now() - jwks.at < JWKS_TTL) return jwks.keys
  const r = await netFetch(`${iss}/.well-known/jwks.json`)
  if (!r.ok) throw new Error('could not fetch World signing keys')
  const body = await r.json()
  jwks = { iss, at: Date.now(), keys: Array.isArray(body?.keys) ? body.keys : [] }
  return jwks.keys
}

const ALGS = {
  RS256: (data, sig, key) => crypto.verify('sha256', data, key, sig),
  ES256: (data, sig, key) => crypto.verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig),
  EdDSA: (data, sig, key) => crypto.verify(null, data, key, sig),
}

/** Verify an id_token's signature and return its claims; throws plain-word errors. */
async function verifyJwt(token) {
  const parts = String(token || '').split('.')
  if (parts.length !== 3) throw new Error('the id token is malformed')
  let header, claims
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString())
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString())
  } catch { throw new Error('the id token is malformed') }
  const check = ALGS[header.alg] // "none" and HMAC are not in the table, on purpose
  if (!check) throw new Error('the id token uses a signing method we do not accept')
  const find = (keys) => keys.find((k) => k.kid === header.kid && (!k.alg || k.alg === header.alg))
  let jwk = find(await loadJwks(false))
  if (!jwk) jwk = find(await loadJwks(true)) // key rotation: one refetch on an unknown kid
  if (!jwk) throw new Error('the id token was signed with an unknown key')
  let good = false
  try {
    good = check(Buffer.from(`${parts[0]}.${parts[1]}`), Buffer.from(parts[2], 'base64url'), crypto.createPublicKey({ key: jwk, format: 'jwk' }))
  } catch { good = false }
  if (!good) throw new Error('the id token signature is not valid')
  return claims
}

export async function finishApproval({ code, state } = {}, pending, { baseUrl } = {}) {
  try {
    const o = pending?.data?.oidc
    if (!o?.state || !state || !same(state, o.state)) return fail('this approval link does not match the request')
    if (pending.status && pending.status !== 'pending') return fail('this request was already answered')
    if (Date.now() > Number(pending.expiresAt)) return fail('this request has expired')
    if (!code) return fail('World did not return a code')
    const cfg = worldConfig().approval
    if (!cfg.ready) return fail(`World approval is not set up (missing ${cfg.missing.join(', ')})`)

    const r = await netFetch(`${issuer()}/api/v1/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: `${baseUrl}${CALLBACK_PATH}`,
        client_id: env('WORLD_OIDC_CLIENT_ID'),
        client_secret: env('WORLD_OIDC_CLIENT_SECRET'),
        code_verifier: o.verifier,
      }),
    })
    const tok = await r.json().catch(() => ({}))
    if (!r.ok || !tok.id_token) return fail('World refused the sign-in code')

    const c = await verifyJwt(tok.id_token)
    const now = Math.floor(Date.now() / 1000)
    if (String(c.iss || '').replace(/\/+$/, '') !== issuer()) return fail('the id token came from a different issuer')
    const aud = Array.isArray(c.aud) ? c.aud : [c.aud]
    if (!aud.includes(env('WORLD_OIDC_CLIENT_ID'))) return fail('the id token was issued for a different app')
    if (!(Number(c.exp) > now - SKEW_SEC)) return fail('the id token has expired')
    if (!c.nonce || !same(c.nonce, o.nonce)) return fail('the id token does not belong to this request')
    const maxAge = Number(o.maxAgeSec) || 300
    const authTime = Number(c.auth_time)
    if (!Number.isFinite(authTime) || now - authTime > maxAge + SKEW_SEC || authTime - now > SKEW_SEC) return fail('the sign-in is not recent enough; please approve again')
    if (!c.sub) return fail('the id token has no subject')

    const bound = approverFor(pending.workspaceId)
    if (bound && !same(bound, c.sub)) return fail("a different World ID than this account's approver")
    if (!bound) bindApprover(pending.workspaceId, c.sub)
    return { ok: true, sub: String(c.sub), authTime, acr: c.acr ? String(c.acr) : '' }
  } catch (e) {
    return fail(e.message || 'the approval could not be checked')
  }
}

/* ---------- human: IDKit proof ---------- */

/** The signed rp_context the browser needs. The signing key stays here. */
export async function humanRpContext(action) {
  const cfg = worldConfig().human
  if (!cfg.ready) throw new Error(`World ID is not set up (missing ${cfg.missing.join(', ')})`)
  const { signRequest } = await import('@worldcoin/idkit-core/signing')
  const s = signRequest({ signingKeyHex: env('WORLD_SIGNING_KEY'), action: String(action), ttl: 600 })
  return { rp_id: cfg.rpId, nonce: s.nonce, created_at: s.createdAt, expires_at: s.expiresAt, signature: s.sig }
}

const nullifiersOf = (result) => (Array.isArray(result?.responses) ? result.responses : [])
  .map((r) => String(r?.nullifier ?? r?.session_nullifier?.[0] ?? '').toLowerCase())
  .filter(Boolean)

export async function verifyHuman(pending, result, { action } = {}) {
  try {
    const cfg = worldConfig().human
    if (!cfg.ready) return fail(`World ID is not set up (missing ${cfg.missing.join(', ')})`)
    if (!result || typeof result !== 'object') return fail('no proof was sent')
    if (Date.now() > Number(pending?.expiresAt)) return fail('this request has expired')
    // Before any network call: a proof made in the simulator must not pass as a real one.
    if (result.environment !== cfg.env) return fail(`the proof was made for ${result.environment || 'an unknown'} World ID, but this server expects ${cfg.env}`)
    if (result.action && result.action !== action) return fail('the proof was made for a different action')
    const ns = nullifiersOf(result)
    if (!ns.length) return fail('the proof has no nullifier')

    const used = (book) => ns.some((n) => book[action]?.[n])
    if (used(readJson('world-nullifiers.json'))) return { ok: false, already: true, reason: 'this person has already done this' }

    const r = await netFetch(`${verifyBase()}/api/v4/verify/${encodeURIComponent(cfg.rpId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(result), // forwarded unchanged, as World requires
    })
    const j = await r.json().catch(() => ({}))
    if (!r.ok || j.success !== true) return fail(j.detail || j.message || 'World could not confirm the proof')
    if (j.environment && j.environment !== cfg.env) return fail('World confirmed the proof for a different environment')

    const book = readJson('world-nullifiers.json') // re-read: another claim may have landed while we waited on World
    if (used(book)) return { ok: false, already: true, reason: 'this person has already done this' }
    book[action] = book[action] || {}
    for (const n of ns) book[action][n] = { at: Date.now(), pending: pending?.id || '' } // never the raw proof
    writeJson('world-nullifiers.json', book)
    return { ok: true, nullifier: ns[0] }
  } catch (e) {
    return fail(e.message || 'the proof could not be checked')
  }
}

/* ---------- pages ---------- */

const CSS = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#0B0D0C;color:#D1D1D1;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;min-height:100vh;display:flex;flex-direction:column}
main{flex:1;width:100%;max-width:480px;margin:0 auto;padding:32px 16px}
h1{font-size:22px;line-height:1.25;margin:0 0 8px;font-weight:600}
p{margin:0 0 16px}
.muted{opacity:.65;font-size:14px}
.card{border:1px solid #2a2e2c;border-radius:12px;padding:16px;margin:16px 0;background:#121513}
.card b{display:block;margin-bottom:4px}
.row{display:flex;flex-direction:column;gap:12px;margin-top:20px}
.btn{display:block;width:100%;padding:14px 16px;border-radius:12px;border:1px solid #3a3f3c;background:transparent;color:#D1D1D1;font:inherit;font-weight:600;text-align:center;text-decoration:none;cursor:pointer}
.go{background:#3DDC84;border-color:#3DDC84;color:#0B0D0C}
.tag{display:inline-block;padding:2px 10px;border-radius:8px;border:1px solid #3a3f3c;font-size:13px;margin-bottom:12px}
#qr{display:flex;justify-content:center;margin:16px 0}
#qr svg{width:224px;height:224px;border-radius:12px;background:#D1D1D1;padding:8px}
form{margin:0}
footer{padding:16px;text-align:center;font-size:13px;opacity:.5}
`

const shell = (title, body, script = '') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>${CSS}</style></head>
<body><main>${body}</main><footer>Secured by World ID · Automate</footer>${script}</body></html>`

function remaining(pending) {
  const s = Math.round((Number(pending?.expiresAt) - Date.now()) / 1000)
  if (!(s > 0)) return 'This request has expired.'
  return s >= 90 ? `Expires in about ${Math.round(s / 60)} minutes.` : `Expires in ${s} seconds.`
}

const summaryCard = (pending) => `<div class="card"><b>${escapeHtml(pending?.data?.title || 'A request')}</b>${pending?.data?.summary ? `<span>${escapeHtml(pending.data.summary)}</span>` : ''}</div>`

const END = {
  approved: ['Approved', 'Your approval was recorded. You can close this page.', true],
  verified: ['Verified', 'You are verified as a unique human. You can close this page.', true],
  denied: ['Denied', 'Nothing was done. You can close this page.'],
  cancelled: ['Cancelled', 'Nothing was done. You can close this page.'],
  expired: ['Expired', 'This request has expired, so nothing was done. Ask for a new link.'],
  already: ['Already done', 'This person has already done this, so it was not done twice.'],
  error: ['Could not finish', 'Something went wrong, so nothing was done.'],
}
// The one green mark of a view sits on the good outcome's tag.
const endScreen = (state, message, pending) => {
  const [name, text, good] = END[state] || END.error
  return `<span class="tag${good ? ' go' : ''}">${name}</span><h1>${escapeHtml(pending?.data?.title || name)}</h1><p>${escapeHtml(message || text)}</p>`
}

export function approvalPageHtml({ pending, startUrl, denyUrl, state = 'open', message = '' } = {}) {
  if (state !== 'open') return shell('Approval', endScreen(state, message, pending))
  const body = `<h1>Approve this?</h1><p class="muted">A flow is waiting for a person to say yes.</p>${summaryCard(pending)}
<p class="muted">${escapeHtml(remaining(pending))} You will sign in again with World ID so we know it is you, now.</p>
<div class="row"><a class="btn go" href="${escapeHtml(startUrl)}">Approve with World ID</a>
<form method="post" action="${escapeHtml(denyUrl)}"><button class="btn" type="submit">Deny</button></form></div>`
  return shell('Approval', body)
}

export function humanPageHtml({ pending, action, rpUrl, verifyUrl, cancelUrl, state = 'open', message = '' } = {}) {
  if (state !== 'open') return shell('Verify you are human', endScreen(state, message, pending))
  const cfg = worldConfig().human
  // Public values only: app id and environment are not secrets.
  const conf = escapeHtml(JSON.stringify({ appId: cfg.appId, env: cfg.env, action, rpUrl, verifyUrl, signal: pending?.id || '', idkit: IDKIT_SRC, qr: QR_SRC }))
  const body = `<h1>Prove you are a person</h1><p class="muted">One claim per human.</p>${summaryCard(pending)}
<p class="muted">${escapeHtml(remaining(pending))}</p>
<div id="view"><div class="row"><button id="start" class="btn go" type="button">Verify with World ID</button></div></div>
<form method="post" action="${escapeHtml(cancelUrl)}"><div class="row"><button class="btn" type="submit">Cancel</button></div></form>
<div id="cfg" data-c="${conf}" hidden></div>`
  // Plain script, no framework. Every outcome is decided by the server's answer to verifyUrl:
  // it expects JSON { ok:true } | { ok:false, already:true } | { ok:false, reason }.
  const script = `<script>
(function(){
var C=JSON.parse(document.getElementById('cfg').dataset.c),view=document.getElementById('view');
function say(tag,text){view.textContent='';var t=document.createElement('span');t.className='tag';t.textContent=tag;var p=document.createElement('p');p.textContent=text;view.append(t,p)}
function load(src){return new Promise(function(ok,no){var s=document.createElement('script');s.src=src;s.onload=ok;s.onerror=function(){no(new Error('Could not load World ID.'))};document.head.append(s)})}
async function qr(uri){try{var m=await import(C.qr);var q=(m.default||m)(0,'M');q.addData(uri);q.make();var d=document.createElement('div');d.id='qr';d.innerHTML=q.createSvgTag({cellSize:4,margin:0,scalable:true});return d}catch(e){return null}}
async function run(){
 document.getElementById('start').disabled=true;
 try{
  await load(C.idkit);
  var r=await fetch(C.rpUrl,{credentials:'same-origin'});if(!r.ok)throw new Error('Could not start the check.');
  var j=await r.json();var rp=j.rp_context||j;
  var req=await window.IDKit.request({app_id:C.appId,action:C.action,rp_context:rp,allow_legacy_proofs:true,environment:C.env,return_to:location.href}).preset(window.IDKit.proofOfHuman({signal:C.signal}));
  view.textContent='';
  var p=document.createElement('p');p.textContent='Scan with World App, or open it on this phone.';view.append(p);
  var q=await qr(req.connectorURI);if(q)view.append(q);
  var a=document.createElement('a');a.className='btn';a.href=req.connectorURI;a.textContent='Open World App';view.append(a);
  var done=await req.pollUntilCompletion({pollInterval:2000,timeout:600000});
  if(!done.success){say('Not verified','World App did not complete the check ('+done.error+'). Nothing was done.');return}
  var v=await fetch(C.verifyUrl,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(done.result)});
  var o=await v.json().catch(function(){return {}});
  if(o.ok)say('Verified','You are verified as a unique human. You can close this page.');
  else if(o.already)say('Already done','This person has already done this, so it was not done twice.');
  else say('Not verified',o.reason||o.message||'The proof could not be confirmed. Nothing was done.');
 }catch(e){say('Could not finish',(e&&e.message)||'Something went wrong.');}
}
document.getElementById('start').addEventListener('click',run);
})();
</script>`
  return shell('Verify you are human', body, script)
}
