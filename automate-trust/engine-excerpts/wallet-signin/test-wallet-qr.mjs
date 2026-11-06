/**
 * Sign in with MetaMask by QR (6 Nov 2026) — app/lib/wallet-auth.server.js
 * (startQr / qrRequest / approveQr / claimQr) and the computer's status route
 * app/routes/wallet-qr-status.js:
 *
 *   1. A sign-in request: a wallet nobody linked is refused on the phone and
 *      the request stays open; a linked wallet approves it and the PHONE gets a
 *      6-digit code; the computer that holds the cookie collects the account
 *      only with that code, and only ONCE.
 *   1b. The relay guard (security review): a computer with the cookie but not
 *      the phone's code gets nothing; wrong codes count down and the fifth ends
 *      the request.
 *   2. The id alone is not enough: no cookie, or another browser's secret,
 *      learns nothing; the secret is not stored as is.
 *   3. Signatures are tied to their request: a message for another request, a
 *      plain sign-in message, or a QR message replayed as a plain sign-in is
 *      refused; a used or expired request is refused on both screens.
 *   4. A link request carries the signed-in account; a wallet linked elsewhere
 *      is refused; the wallet is linked only after the computer types the code.
 *   5. The status route: pending while waiting, confirm once the phone signed;
 *      with the code it sets the session cookies and clears the request cookie;
 *      a second ask is expired.
 *
 * Supabase is faked; the test fails if anything else is reached. Temp folder.
 *
 *   node scripts/test-wallet-qr.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Wallet } from 'ethers'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-qr-'))
process.chdir(TMP)
process.env.SUPABASE_URL = 'https://sb.test'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-test'
process.env.SUPABASE_ANON_KEY = 'anon-test'
process.env.PUBLIC_URL = 'https://automateplatform.in'
process.env.NODE_ENV = 'production'

let passed = 0, failed = 0
const ok = (cond, msg, extra = '') => { if (cond) passed++; else { failed++; console.error(`FAIL: ${msg}${extra ? `\n      ${String(extra).slice(0, 300)}` : ''}`) } }

const OWNER = '11111111-1111-4111-8111-111111111111'
const OTHER = '44444444-4444-4444-8444-444444444444'
const outside = []
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url))
  if (u.hostname !== 'sb.test') { outside.push(u.hostname); throw new Error(`network call outside the test: ${url}`) }
  const body = init.body ? JSON.parse(init.body) : null
  const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } })
  const user = { id: OWNER, email: 'owner@shop.test' }
  if (u.pathname === `/auth/v1/admin/users/${OWNER}`) return json(user)
  if (u.pathname === '/auth/v1/admin/generate_link') return json({ hashed_token: `hash-${body.email}`, properties: { hashed_token: `hash-${body.email}` }, ...user })
  if (u.pathname === '/auth/v1/verify') return body.token_hash === 'hash-owner@shop.test'
    ? json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, token_type: 'bearer', user })
    : json({ msg: 'Token has expired or is invalid' }, 403)
  return json({}, 404)
}

const W = await import(pathToFileURL(path.join(ROOT, 'app', 'lib', 'wallet-auth.server.js')).href)
const { siweMessage } = await import(pathToFileURL(path.join(ROOT, 'app', 'lib', 'wallet-client.js')).href)
const status = await import(pathToFileURL(path.join(ROOT, 'app', 'routes', 'wallet-qr-status.js')).href)

const HOST = 'automateplatform.in'
const cookieOf = (setCookie) => setCookie.split(';')[0]
const req = (cookie = '', p = '/wallet/qr/x') => new Request(`https://${HOST}${p}`, { method: 'POST', headers: { host: HOST, 'x-forwarded-proto': 'https', ...(cookie ? { cookie } : {}) } })
const phone = Wallet.createRandom(), stranger = Wallet.createRandom()

/* The phone page: its own nonce (and cookie), then a message naming the request. */
const phoneSigns = async ({ id, purpose, wallet = phone, requestId = id }) => {
  const nonce = W.issueNonce()
  const message = siweMessage({ host: HOST, origin: `https://${HOST}`, address: wallet.address, chainId: 1, nonce, purpose, requestId })
  return { id, message, signature: await wallet.signMessage(message), request: req(), cookieNonce: nonce }
}

/* ---- 1. sign-in request, happy path ---- */
const q = W.startQr({ purpose: 'signin' })
const desk = cookieOf(W.qrCookie(q, req()))
ok(/^[0-9a-f]{32}$/.test(q.id) && /^[0-9a-f]{32}$/.test(q.secret) && q.id !== q.secret, 'a request has a 32-hex id and a separate secret', JSON.stringify(q))
ok(/HttpOnly/.test(W.qrCookie(q, req())) && /Secure/.test(W.qrCookie(q, req())) && /SameSite=Lax/.test(W.qrCookie(q, req())), 'the secret travels in an httpOnly, Secure, Lax cookie')
const view = W.qrRequest(q.id)
ok(view?.purpose === 'signin' && !('secret' in view) && !('userId' in view), 'the phone page sees the purpose, not the secret', JSON.stringify(view))
ok(!fs.readFileSync(path.join(TMP, 'data', 'wallet-qr.json'), 'utf8').includes(q.secret), 'the secret is not stored as is')

let r = W.approveQr(await phoneSigns({ id: q.id, purpose: 'qrsignin' }))
ok(!r.ok && /not linked/.test(r.reason), 'a wallet nobody linked is refused on the phone', JSON.stringify(r))
ok(W.qrRequest(q.id), '…and the request stays open for a linked wallet')
ok(W.claimQr(req(desk)).status === 'pending', 'the computer sees pending meanwhile')

W.linkWallet({ userId: OWNER, email: 'owner@shop.test', address: phone.address })
r = W.approveQr(await phoneSigns({ id: q.id, purpose: 'qrsignin' }))
ok(r.ok && r.purpose === 'signin' && /^\d{6}$/.test(r.confirmCode), 'a linked wallet approves the request and the phone gets a 6-digit code', JSON.stringify(r))
const code1 = r.confirmCode
ok(!fs.readFileSync(path.join(TMP, 'data', 'wallet-qr.json'), 'utf8').includes(`"${code1}"`), 'the code is not stored as is')
ok(W.qrRequest(q.id) === null, 'the phone page shows it as used afterwards')
r = W.approveQr(await phoneSigns({ id: q.id, purpose: 'qrsignin' }))
ok(!r.ok && /expired or was already used/.test(r.reason), 'a second approval is refused', JSON.stringify(r))

/* ---- 2. the id alone is not enough ---- */
ok(W.claimQr(req()).status === 'expired', 'no cookie: nothing to learn')
const other = W.startQr({ purpose: 'signin' })
ok(W.claimQr(req(`${W.QR_COOKIE}=${q.id}.${other.secret}`)).status === 'expired', 'the right id with another browser\'s secret: nothing to learn')
ok(W.claimQr(req(`${W.QR_COOKIE}=${q.id}.${other.secret}`), code1).status === 'expired', '…even with the phone\'s code')

/* ---- 1b. the relay guard: the cookie is not enough without the phone's code ---- */
let c1 = W.claimQr(req(desk))
ok(c1.status === 'confirm' && !c1.userId, 'with the cookie but no code: asked for the code, no account given', JSON.stringify(c1))
const wrong = code1 === '000000' ? '111111' : '000000'
c1 = W.claimQr(req(desk), wrong)
ok(c1.status === 'confirm' && c1.wrong && c1.left === 4 && !c1.userId, 'a wrong code: no account, four tries left', JSON.stringify(c1))
c1 = W.claimQr(req(desk), `${code1.slice(0, 3)} ${code1.slice(3)}`)
ok(c1.status === 'approved' && c1.userId === OWNER && c1.address === phone.address, 'the phone\'s code (spaces allowed) gives the computer the account', JSON.stringify(c1))
ok(W.claimQr(req(desk), code1).status === 'expired', 'collected once only')

const q1b = W.startQr({ purpose: 'signin' })
const desk1b = cookieOf(W.qrCookie(q1b, req()))
const code1b = W.approveQr(await phoneSigns({ id: q1b.id, purpose: 'qrsignin' })).confirmCode
const bad = code1b === '999999' ? '888888' : '999999'
for (let i = 0; i < 4; i++) W.claimQr(req(desk1b), bad)
ok(W.claimQr(req(desk1b), bad).status === 'expired', 'the fifth wrong code ends the request')
ok(W.claimQr(req(desk1b), code1b).status === 'expired', '…and the right code after that gets nothing')

/* ---- 3. signatures are tied to their request ---- */
const q3 = W.startQr({ purpose: 'signin' })
r = W.approveQr({ ...(await phoneSigns({ id: q3.id, purpose: 'qrsignin', requestId: other.id })) })
ok(!r.ok && /something else/.test(r.reason), 'a message naming another request is refused', JSON.stringify(r))
r = W.approveQr({ ...(await phoneSigns({ id: q3.id, purpose: 'signin', requestId: '' })) })
ok(!r.ok && /something else/.test(r.reason), 'a plain sign-in message cannot approve a QR request', JSON.stringify(r))
const qrMsg = await phoneSigns({ id: q3.id, purpose: 'qrsignin' })
const v = W.verifyWalletMessage({ message: qrMsg.message, signature: qrMsg.signature, request: req(), purpose: 'signin', cookieNonce: qrMsg.cookieNonce })
ok(!v.ok, 'a QR message cannot be used as a plain sign-in', JSON.stringify(v))
const v2 = W.verifyWalletMessage({ message: qrMsg.message, signature: qrMsg.signature, request: req(), purpose: 'qrsignin', cookieNonce: qrMsg.cookieNonce })
ok(!v2.ok, '…nor checked without naming its request', JSON.stringify(v2))
r = W.approveQr({ ...(await phoneSigns({ id: q3.id, purpose: 'qrsignin', wallet: stranger })), message: qrMsg.message })
ok(!r.ok, 'a signature from another wallet is refused', JSON.stringify(r))
r = W.approveQr({ ...(await phoneSigns({ id: q3.id, purpose: 'qrsignin' })), cookieNonce: 'aaaaaaaaaaaaaaaaaaaaaaaa' })
ok(!r.ok && /another browser/.test(r.reason), 'the phone needs its own nonce cookie', JSON.stringify(r))

const realNow = Date.now
Date.now = () => realNow() + 4 * 60_000
ok(W.qrRequest(q3.id) === null, 'after three minutes the phone page shows it as expired')
r = W.approveQr(await phoneSigns({ id: q3.id, purpose: 'qrsignin' }))
ok(!r.ok && /expired/.test(r.reason), 'and approving it is refused', JSON.stringify(r))
Date.now = realNow
ok(W.qrRequest('not-an-id') === null && W.qrRequest('') === null, 'a malformed id is just "gone"')

/* ---- 4. link requests ---- */
let threw = false
try { W.startQr({ purpose: 'link' }) } catch { threw = true }
ok(threw, 'a link request needs a signed-in account')
threw = false
try { W.startQr({ purpose: 'other' }) } catch { threw = true }
ok(threw, 'an unknown purpose is refused')
const fresh = Wallet.createRandom()
const ql = W.startQr({ purpose: 'link', userId: OTHER, email: 'other@shop.test' })
const deskL = cookieOf(W.qrCookie(ql, req()))
ok(W.qrRequest(ql.id)?.account === 'o•••@shop.test', 'the phone sees which account, masked', JSON.stringify(W.qrRequest(ql.id)))
r = W.approveQr(await phoneSigns({ id: ql.id, purpose: 'qrsignin', wallet: fresh }))
ok(!r.ok, 'a sign-in message cannot approve a link request')
r = W.approveQr(await phoneSigns({ id: ql.id, purpose: 'qrlink', wallet: phone }))
ok(!r.ok && /another account/.test(r.reason), 'a wallet linked to another account is refused', JSON.stringify(r))
r = W.approveQr(await phoneSigns({ id: ql.id, purpose: 'qrlink', wallet: fresh }))
ok(r.ok && r.purpose === 'link' && /^\d{6}$/.test(r.confirmCode), 'the phone approves the link and gets a code', JSON.stringify(r))
ok(W.accountOf(fresh.address) === null, '…but nothing is linked yet')
ok(W.claimQr(req(deskL)).status === 'confirm' && W.accountOf(fresh.address) === null, 'the computer without the code links nothing')
const lc = W.claimQr(req(deskL), r.confirmCode)
ok(lc.status === 'approved' && lc.purpose === 'link' && W.accountOf(fresh.address)?.userId === OTHER, 'with the code the wallet is linked to the requesting account', JSON.stringify(lc))

/* ---- 5. the status route ---- */
const q5 = W.startQr({ purpose: 'signin' })
const desk5 = cookieOf(W.qrCookie(q5, req()))
let res = await status.action({ request: req(desk5, '/wallet/qr-status') })
let body = await res.json()
ok(body.status === 'pending' && res.headers.get('cache-control') === 'no-store', 'the status route says pending, uncached', JSON.stringify(body))
ok((await (await status.action({ request: req('', '/wallet/qr-status') })).json()).status === 'expired', 'without the cookie it says expired')
const code5 = W.approveQr(await phoneSigns({ id: q5.id, purpose: 'qrsignin' })).confirmCode
ok(/^\d{6}$/.test(code5), 'the phone approves')
res = await status.action({ request: req(desk5, '/wallet/qr-status') })
body = await res.json()
ok(body.status === 'confirm' && !res.headers.getSetCookie().length, 'then the status route asks for the code and sets no cookie', JSON.stringify(body))
const withCode = (code) => new Request(`https://${HOST}/wallet/qr-status`, { method: 'POST', headers: { host: HOST, 'x-forwarded-proto': 'https', cookie: desk5, 'content-type': 'application/json' }, body: JSON.stringify({ code }) })
res = await status.action({ request: withCode(code5 === '123456' ? '654321' : '123456') })
body = await res.json()
ok(body.status === 'confirm' && body.wrong && body.left === 4 && !res.headers.getSetCookie().length, 'a wrong code: no session, tries left', JSON.stringify(body))
res = await status.action({ request: withCode(code5) })
body = await res.json()
const set = res.headers.getSetCookie()
ok(body.status === 'done', 'with the phone\'s code the status route says done', JSON.stringify(body))
ok(set.some((c) => /^sb-.*auth-token/.test(c) && /HttpOnly/i.test(c)), 'and sets the httpOnly session cookie', set.join(' | '))
ok(set.some((c) => c.startsWith(`${W.QR_COOKIE}=;`) && /Max-Age=0/.test(c)), 'and clears the request cookie', set.join(' | '))
body = await (await status.action({ request: withCode(code5) })).json()
ok(body.status === 'expired', 'a second ask gets nothing', JSON.stringify(body))
ok((await status.action({ request: new Request(`https://${HOST}/wallet/qr-status`) })).status === 405, 'GET is not allowed')

ok(outside.length === 0, 'nothing outside the fakes was reached', outside.join(', '))
console.log(`${passed} passed${failed ? `, ${failed} failed` : ''}`)
process.exit(failed ? 1 : 0)
