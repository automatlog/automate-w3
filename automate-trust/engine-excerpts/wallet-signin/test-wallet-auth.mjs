/**
 * Sign in with MetaMask (6 Nov 2026) — app/lib/wallet-auth.server.js:
 *
 *   1. A message the browser builds (siweMessage) with a nonce we issued, signed
 *      by the wallet, verifies — once. The same message again is refused (nonce
 *      spent); a nonce we never issued is refused.
 *   2. Refused: another website's domain or URI, a "link" signature used to sign
 *      in, a message issued too long ago, a signature from another wallet,
 *      garbage. A failed attempt does not spend the nonce.
 *   3. Links: one wallet per account, a wallet linked elsewhere is refused,
 *      unlink frees it, the address is case-insensitive.
 *   4. sessionForAccount: reads the account by id, generates a one-time token
 *      with the service key (no email is sent) and verifies it on the request's
 *      own client; an unknown or disabled account gets no session.
 *
 * Supabase is faked; the test fails if anything else is reached. Temp folder.
 *
 *   node scripts/test-wallet-auth.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Wallet, getBytes } from 'ethers'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..')
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-auth-')))
process.env.SUPABASE_URL = 'https://sb.test'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-test'
process.env.SUPABASE_ANON_KEY = 'anon-test'
process.env.PUBLIC_URL = 'https://automateplatform.in'
process.env.NODE_ENV = 'production'

let passed = 0, failed = 0
const ok = (cond, msg, extra = '') => { if (cond) passed++; else { failed++; console.error(`FAIL: ${msg}${extra ? `\n      ${String(extra).slice(0, 300)}` : ''}`) } }

/* Fake Supabase auth: the admin user lookup, generate_link, and verify. */
const calls = [], outside = []
const USERS = { '11111111-1111-4111-8111-111111111111': { id: '11111111-1111-4111-8111-111111111111', email: 'owner@shop.test' }, '22222222-2222-4222-8222-222222222222': { id: '22222222-2222-4222-8222-222222222222', email: 'off@shop.test', banned_until: '2999-01-01T00:00:00Z' } }
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url))
  if (u.hostname !== 'sb.test') { outside.push(u.hostname); throw new Error(`network call outside the test: ${url}`) }
  const body = init.body ? JSON.parse(init.body) : null
  calls.push({ path: u.pathname, method: init.method || 'GET', body })
  const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } })
  const m = u.pathname.match(/^\/auth\/v1\/admin\/users\/([^/]+)$/)
  if (m) return USERS[m[1]] ? json(USERS[m[1]]) : json({ msg: 'User not found' }, 404)
  if (u.pathname === '/auth/v1/admin/generate_link') return json({ action_link: 'x', hashed_token: `hash-${body.email}`, properties: { hashed_token: `hash-${body.email}` }, ...USERS['11111111-1111-4111-8111-111111111111'] })
  if (u.pathname === '/auth/v1/verify') return body.token_hash === 'hash-owner@shop.test'
    ? json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, token_type: 'bearer', user: USERS['11111111-1111-4111-8111-111111111111'] })
    : json({ msg: 'Token has expired or is invalid' }, 403)
  return json({}, 404)
}

const W = await import(pathToFileURL(path.join(ROOT, 'app', 'lib', 'wallet-auth.server.js')).href)
const { siweMessage } = await import(pathToFileURL(path.join(ROOT, 'app', 'lib', 'wallet-client.js')).href)

const req = (host = 'automateplatform.in') => new Request(`https://${host}/login`, { method: 'POST', headers: { host, 'x-forwarded-proto': 'https' } })
const w = Wallet.createRandom()
const signed = async ({ wallet = w, purpose = 'signin', host = 'automateplatform.in', nonce = W.issueNonce(), now = new Date() } = {}) => {
  const message = siweMessage({ host, origin: `https://${host}`, address: wallet.address.toLowerCase(), chainId: 5042002, nonce, purpose, now })
  return { message, signature: await wallet.signMessage(message), nonce }
}

/* ---- 1. good message, once ---- */
const s1 = await signed()
let v = W.verifyWalletMessage({ ...s1, request: req(), purpose: 'signin', cookieNonce: s1.nonce })
ok(v.ok && v.address === w.address, 'a fresh signed message verifies, with the checksummed address', JSON.stringify(v))
v = W.verifyWalletMessage({ ...s1, request: req(), purpose: 'signin', cookieNonce: s1.nonce })
ok(!v.ok && /already used/.test(v.reason), 'the same message again is refused (nonce spent)', v.reason)
v = W.verifyWalletMessage({ ...(await signed({ nonce: 'deadbeefdeadbeefdeadbeef' })), request: req(), purpose: 'signin', cookieNonce: 'deadbeefdeadbeefdeadbeef' })
ok(!v.ok && /already used|expired/.test(v.reason), 'a nonce we never issued is refused', v.reason)
ok(W.parseSiwe(s1.message)?.statement === 'Sign in to Automate with this wallet.', 'the browser message parses back to its fields')

/* ---- 2. refusals, and a failure does not spend the nonce ---- */
const keep = await signed()
/* Request headers no longer decide anything: a message for OUR domain verifies
   whatever Host it arrives with, and (below) one for another domain never does. */
const anyHost = await signed()
v = W.verifyWalletMessage({ ...anyHost, request: req('evil.example'), purpose: 'signin', cookieNonce: anyHost.nonce })
ok(v.ok, 'the Host header is not trusted either way: a message for our domain verifies on its own merits', JSON.stringify(v))
v = W.verifyWalletMessage({ ...keep, request: req(), purpose: 'link', cookieNonce: keep.nonce })
ok(!v.ok && /something else/.test(v.reason), 'a sign-in signature cannot be used to link (and vice versa)', v.reason)
v = W.verifyWalletMessage({ message: keep.message, signature: await Wallet.createRandom().signMessage(keep.message), request: req(), purpose: 'signin', cookieNonce: keep.nonce })
ok(!v.ok && /not from that wallet/.test(v.reason), 'a signature from another wallet is refused', v.reason)
v = W.verifyWalletMessage({ ...keep, request: req(), purpose: 'signin', cookieNonce: keep.nonce })
ok(v.ok, 'after those failures the good message still works (failures did not spend its nonce)', JSON.stringify(v))
const oldOne = await signed({ now: new Date(Date.now() - 11 * 60_000) })
v = W.verifyWalletMessage({ ...oldOne, request: req(), purpose: 'signin', cookieNonce: oldOne.nonce })
ok(!v.ok && /too old|expired/.test(v.reason), 'a message issued 11 minutes ago is refused', v.reason)
const otherHost = await signed({ host: 'evil.example' })
v = W.verifyWalletMessage({ ...otherHost, request: req(), purpose: 'signin', cookieNonce: otherHost.nonce })
ok(!v.ok && /another website/.test(v.reason), 'a message made for another domain is refused here', v.reason)
v = W.verifyWalletMessage({ message: 'hello', signature: '0x00', request: req(), purpose: 'signin' })
ok(!v.ok, 'garbage is refused without throwing')
ok(getBytes(s1.signature).length === 65, 'the signature is a 65-byte personal_sign signature')

/* The security review's attack (6 Nov): a phishing site gets a message signed for
   ITS domain, then replays it to us with a forged X-Forwarded-Host. */
const phish = await signed({ host: 'evil.example' })
const forged = new Request('https://automateplatform.in/login', { method: 'POST', headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' } })
v = W.verifyWalletMessage({ ...phish, request: forged, purpose: 'signin', cookieNonce: phish.nonce })
ok(!v.ok && /another website/.test(v.reason), 'a forged X-Forwarded-Host cannot make another domain message count (the origin is configuration)', v.reason)
const bound = await signed()
v = W.verifyWalletMessage({ ...bound, request: req(), purpose: 'signin', cookieNonce: '' })
ok(!v.ok && /another browser/.test(v.reason), 'no nonce cookie: refused (a nonce harvested elsewhere cannot be used)', v.reason)
v = W.verifyWalletMessage({ ...bound, request: req(), purpose: 'signin', cookieNonce: 'aaaaaaaaaaaaaaaaaaaaaaaa' })
ok(!v.ok && /another browser/.test(v.reason), 'a nonce cookie from a different browser: refused', v.reason)
v = W.verifyWalletMessage({ ...bound, request: req(), purpose: 'signin', cookieNonce: bound.nonce })
ok(v.ok, '…and those refusals did not spend the nonce of this browser', JSON.stringify(v))
ok(W.readNonceCookie(new Request('https://x/', { headers: { cookie: `a=1; ${W.NONCE_COOKIE}=${bound.nonce}; b=2` } })) === bound.nonce, 'the nonce cookie is read back from the Cookie header')
const ck = W.nonceCookie(bound.nonce, req())
ok(/HttpOnly/.test(ck) && /SameSite=Lax/.test(ck) && /Secure/.test(ck) && /Max-Age=600/.test(ck), 'the cookie is HttpOnly, SameSite=Lax, Secure on https, 10 minutes', ck)
process.env.NODE_ENV = 'development'
const local = await signed({ host: 'localhost:5173' })
const localMsg = { ...local, message: local.message.replace('URI: https://localhost:5173', 'URI: http://localhost:5173') }
localMsg.signature = await w.signMessage(localMsg.message)
v = W.verifyWalletMessage({ ...localMsg, request: req(), purpose: 'signin', cookieNonce: local.nonce })
ok(!v.ok && /another website/.test(v.reason), 'with a real site configured, a "localhost" message is refused even outside production', v.reason)
process.env.NODE_ENV = 'production'
const savedPub = process.env.PUBLIC_URL; delete process.env.PUBLIC_URL
const unset = await signed()
v = W.verifyWalletMessage({ ...unset, request: req(), purpose: 'signin', cookieNonce: unset.nonce })
ok(!v.ok && /not set up/.test(v.reason), 'no configured origin in production: wallet sign-in is off', v.reason)
process.env.PUBLIC_URL = savedPub

/* ---- 3. links ---- */
ok(W.linkWallet({ userId: '11111111-1111-4111-8111-111111111111', email: 'owner@shop.test', address: w.address.toLowerCase() }).ok, 'link a wallet to an account')
ok(W.walletOf('11111111-1111-4111-8111-111111111111') === w.address && W.accountOf(w.address.toLowerCase())?.userId === '11111111-1111-4111-8111-111111111111', 'looked up both ways, case-insensitively')
const r = W.linkWallet({ userId: 'u-2', email: 'x@shop.test', address: w.address })
ok(!r.ok && /another account/.test(r.reason), 'a wallet already linked to another account is refused', JSON.stringify(r))
const w2 = Wallet.createRandom()
W.linkWallet({ userId: '11111111-1111-4111-8111-111111111111', email: 'owner@shop.test', address: w2.address })
ok(W.walletOf('11111111-1111-4111-8111-111111111111') === w2.address && !W.accountOf(w.address), 'one wallet per account: linking a new one replaces the old')
ok(W.unlinkWallet('11111111-1111-4111-8111-111111111111') && !W.walletOf('11111111-1111-4111-8111-111111111111') && !W.accountOf(w2.address), 'unlink frees it')

/* ---- 4. sessions ---- */
const { createServerClient } = await import('@supabase/ssr')
const cookies = []
const sb = createServerClient('https://sb.test', 'anon-test', { cookies: { getAll: () => [], setAll: (c) => cookies.push(...c) } })
calls.length = 0
let s = await W.sessionForAccount(sb, '11111111-1111-4111-8111-111111111111')
ok(s.ok, 'a linked account gets a session', JSON.stringify(s))
ok(calls.some((c) => c.path === '/auth/v1/admin/users/11111111-1111-4111-8111-111111111111') && calls.some((c) => c.path === '/auth/v1/admin/generate_link' && c.body?.type === 'magiclink' && c.body?.email === 'owner@shop.test') && calls.some((c) => c.path === '/auth/v1/verify'), 'it reads the account, makes a one-time token with the service key and verifies it', JSON.stringify(calls.map((c) => c.path)))
ok(!calls.some((c) => /\/(magiclink|otp|recover)$/.test(c.path)), 'no email is sent (no /otp or /magiclink call)')
ok(cookies.length > 0, 'the session cookie is set on the request\'s client')
s = await W.sessionForAccount(sb, '33333333-3333-4333-8333-333333333333')
ok(!s.ok && /could not be found/.test(s.reason), 'an unknown account gets no session')
s = await W.sessionForAccount(sb, '22222222-2222-4222-8222-222222222222')
ok(!s.ok && /disabled/.test(s.reason), 'a disabled account gets no session')

ok(outside.length === 0, 'nothing outside the fakes was reached', outside.join(', '))
console.log(`${passed} passed${failed ? `, ${failed} failed` : ''}`)
process.exit(failed ? 1 : 0)
