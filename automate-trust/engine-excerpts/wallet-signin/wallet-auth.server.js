/**
 * Sign in with MetaMask (6 Nov 2026) — Sign-In with Ethereum (EIP-4361), for
 * accounts that already exist.
 *
 * WHY NOT supabase.auth.signInWithWeb3: it creates a NEW Supabase user for any
 * wallet that signs. Automate is invite-only (login.jsx), and a person's
 * workspaces, team access and settings hang off their existing account. So a
 * wallet is LINKED to an existing account first (Settings → Sign in with
 * MetaMask, while signed in), and signing in with it opens a session for THAT
 * account — never a new one. A wallet nobody linked gets no session.
 *
 * THE MESSAGE is built in the browser (it needs the wallet's address and chain)
 * and checked field by field here: our domain and origin, version 1, a nonce we
 * issued and have not seen used, issued within NONCE_TTL_MS, not expired, and
 * the statement for what it is for (sign in vs link). The signature must
 * recover to the address in the message.
 *
 * THE SESSION is minted the way Supabase's own magic link does, without any
 * email: the service key generates a one-time token for the account's email and
 * the request's own client verifies it, which sets the usual httpOnly cookies.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { verifyMessage, isAddress, getAddress } from 'ethers'
import { createClient as createSb } from '@supabase/supabase-js'

import { STATEMENTS } from './wallet-client.js'

/** A nonce lives this long; the message's Issued At must be at most this old. */
const NONCE_TTL_MS = 10 * 60_000
/** Nonces kept at most (oldest dropped) — enough for many open login pages. */
const MAX_NONCES = 5_000
export { STATEMENTS }

const file = (n) => path.join(process.cwd(), 'data', n)
const readJson = (n, fb) => { try { return JSON.parse(fs.readFileSync(file(n), 'utf8')) } catch { return fb } }
const writeJson = (n, v) => {
  fs.mkdirSync(path.dirname(file(n)), { recursive: true })
  fs.writeFileSync(`${file(n)}.tmp`, JSON.stringify(v))
  fs.renameSync(`${file(n)}.tmp`, file(n))
}

/** A fresh single-use nonce (EIP-4361 wants at least 8 alphanumerics). */
export function issueNonce() {
  const now = Date.now()
  const nonce = crypto.randomBytes(12).toString('hex')
  const live = Object.entries(readJson('wallet-nonces.json', {})).filter(([, exp]) => exp > now)
  live.push([nonce, now + NONCE_TTL_MS])
  writeJson('wallet-nonces.json', Object.fromEntries(live.slice(-MAX_NONCES)))
  return nonce
}
function spendNonce(nonce) {
  const all = readJson('wallet-nonces.json', {})
  const exp = all[nonce]
  if (!exp) return false
  delete all[nonce]
  writeJson('wallet-nonces.json', all)
  return exp > Date.now()
}

/** Read an EIP-4361 message into its fields (null if it is not one). */
export function parseSiwe(message) {
  const lines = String(message || '').split('\n')
  const head = lines[0]?.match(/^(\S+) wants you to sign in with your Ethereum account:$/)
  if (!head || !isAddress(lines[1] || '')) return null
  const field = (k) => (lines.find((l) => l.startsWith(`${k}: `)) || '').slice(k.length + 2).trim()
  return {
    domain: head[1],
    address: getAddress(lines[1]),
    statement: lines[2] === '' && lines[3] && !/^[A-Z][\w ]+: /.test(lines[3]) ? lines[3] : '',
    uri: field('URI'), version: field('Version'), chainId: field('Chain ID'), nonce: field('Nonce'),
    issuedAt: field('Issued At'), expirationTime: field('Expiration Time'), requestId: field('Request ID'),
  }
}

/*
 * WHICH WEBSITE a message may name is SERVER CONFIGURATION, never a request
 * header (security review, 6 Nov). Taken from X-Forwarded-Host, a phishing site
 * could have a victim sign "evil.example wants you to sign in…" — MetaMask sees
 * no mismatch on evil.example — and replay it to us with a forged header. So the
 * allowed origins are WALLET_AUTH_ORIGINS, else PUBLIC_URL / SITE_URL /
 * TRUST_BASE_URL; local dev also allows localhost. None set: wallet sign-in is off.
 */
export function allowedOrigins() {
  const list = String(process.env.WALLET_AUTH_ORIGINS || [process.env.PUBLIC_URL, process.env.SITE_URL, process.env.TRUST_BASE_URL].filter(Boolean).join(','))
    .split(',').map((s) => { try { return new URL(s.trim()).origin } catch { return '' } }).filter(Boolean)
  /* localhost only for a dev box with NO site configured — never beside a real
     domain, where it would let a phishing page claim "localhost" (6 Nov). */
  if (!list.length && process.env.NODE_ENV !== 'production') list.push('http://localhost:5173', 'http://localhost:3000')
  return [...new Set(list)]
}

/*
 * The nonce is also bound to the BROWSER it was issued to: the page that issues
 * it sets it in an httpOnly cookie, and the message must carry that same nonce.
 * A nonce harvested in one browser (an attacker's) cannot complete a sign-in
 * from another, and page script cannot read or set the cookie.
 */
export const NONCE_COOKIE = 'automate_siwe'
export function nonceCookie(nonce, request) {
  const secure = new URL(request.url).protocol === 'https:' || String(request.headers.get('x-forwarded-proto') || '').startsWith('https')
  return `${NONCE_COOKIE}=${nonce}; Path=/; Max-Age=${NONCE_TTL_MS / 1000}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
}
export function readNonceCookie(request) {
  const m = String(request.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${NONCE_COOKIE}=([0-9a-f]{24})(?:;|$)`))
  return m ? m[1] : ''
}

/**
 * Check a signed message for `purpose` ('signin' | 'link') from this request.
 * `cookieNonce` is readNonceCookie(request). Returns { ok: true, address } or
 * { ok: false, reason } — never throws.
 */
export function verifyWalletMessage({ message, signature, request, purpose, cookieNonce, requestId = '' }) {
  const m = parseSiwe(message)
  if (!m) return { ok: false, reason: 'That was not a sign-in message.' }
  void request
  const origins = allowedOrigins()
  if (!origins.length) return { ok: false, reason: 'Wallet sign-in is not set up on this server.' }
  const origin = origins.find((o) => new URL(o).host === m.domain)
  if (!origin) return { ok: false, reason: 'The message was made for another website.' }
  if (m.uri !== origin && !m.uri.startsWith(`${origin}/`)) return { ok: false, reason: 'The message was made for another website.' }
  if (!cookieNonce || m.nonce !== cookieNonce) return { ok: false, reason: 'This sign-in request belongs to another browser or page. Reload and try again.' }
  if (m.version !== '1') return { ok: false, reason: 'Unsupported sign-in message.' }
  if (m.statement !== STATEMENTS[purpose]) return { ok: false, reason: 'The message was for something else.' }
  /* A phone's QR signature names the request it answers; nothing else may carry one. */
  if (m.requestId !== String(requestId || '')) return { ok: false, reason: 'The message was for something else.' }
  const issued = Date.parse(m.issuedAt)
  if (!issued || issued > Date.now() + 60_000 || Date.now() - issued > NONCE_TTL_MS) return { ok: false, reason: 'The message is too old. Try again.' }
  if (m.expirationTime && Date.parse(m.expirationTime) < Date.now()) return { ok: false, reason: 'The message has expired. Try again.' }
  let signer
  try { signer = getAddress(verifyMessage(String(message), String(signature || ''))) } catch { return { ok: false, reason: 'The signature could not be checked.' } }
  if (signer !== m.address) return { ok: false, reason: 'The signature is not from that wallet.' }
  /* The nonce is spent only after everything else passed, so a bad attempt
     cannot burn a good page's nonce — and a replay of a good one fails here. */
  if (!spendNonce(m.nonce)) return { ok: false, reason: 'This sign-in request was already used or has expired. Reload the page and try again.' }
  return { ok: true, address: m.address }
}

/* ---- links: one wallet ↔ one account ---- */
const links = () => readJson('wallet-links.json', {})
export const walletOf = (userId) => Object.entries(links()).find(([, v]) => v.userId === userId)?.[0] || null
export const accountOf = (address) => (isAddress(address || '') ? links()[getAddress(address)] || null : null)
export function linkWallet({ userId, email, address }) {
  const all = links()
  const a = getAddress(address)
  if (all[a] && all[a].userId !== userId) return { ok: false, reason: 'This wallet is already linked to another account.' }
  for (const [k, v] of Object.entries(all)) if (v.userId === userId) delete all[k] // one wallet per account
  all[a] = { userId, email: String(email || ''), linkedAt: new Date().toISOString() }
  writeJson('wallet-links.json', all)
  return { ok: true, address: a }
}
export function unlinkWallet(userId) {
  const all = links()
  let changed = false
  for (const [k, v] of Object.entries(all)) if (v.userId === userId) { delete all[k]; changed = true }
  if (changed) writeJson('wallet-links.json', all)
  return changed
}

function admin() {
  const url = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '')
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  if (!url || !key) throw new Error('Wallet sign-in is not available on this server.')
  return createSb(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

/**
 * Open a session for the linked account on `supabase` (the request's own
 * server client, whose cookie writes go out in `headers`). The account's
 * CURRENT email is read by id, so a changed email still works.
 */
export async function sessionForAccount(supabase, userId) {
  /* Never throws: supabase-js throws (rather than returns) on a malformed id,
     and a sign-in page must answer in words, not with a 500. */
  try {
    const sb = admin()
    const { data: u, error: e1 } = await sb.auth.admin.getUserById(userId)
    if (e1 || !u?.user?.email) return { ok: false, reason: 'The linked account could not be found.' }
    if (u.user.banned_until && Date.parse(u.user.banned_until) > Date.now()) return { ok: false, reason: 'This account is disabled.' }
    const { data: link, error: e2 } = await sb.auth.admin.generateLink({ type: 'magiclink', email: u.user.email })
    const token_hash = link?.properties?.hashed_token
    if (e2 || !token_hash) return { ok: false, reason: 'Sign-in failed. Try again.' }
    const { error: e3 } = await supabase.auth.verifyOtp({ type: 'magiclink', token_hash })
    if (e3) return { ok: false, reason: 'Sign-in failed. Try again.' }
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: /UUID/.test(e.message) ? 'The linked account could not be found.' : 'Sign-in failed. Try again.' }
  }
}

/* ---- QR: MetaMask on a phone, for this computer (6 Nov 2026) ----
 *
 * The computer asks for a QR request (startQr) and keeps its SECRET in an
 * httpOnly cookie; the QR opens /wallet/qr/<id> in the MetaMask app, which
 * signs a message naming that id (approveQr, with the phone's own nonce
 * cookie). Only the browser holding the secret can then collect the result
 * (claimQr) — the id alone, seen on the screen or in the QR, is not enough.
 *
 *   signin: the wallet must already be linked; the computer gets the session.
 *   link:   made while signed in, so the request carries that account; the
 *           phone's signature links the wallet to it (the phone shows which,
 *           masked) and the computer just reloads.
 *
 * Each request is single-use and lives QR_TTL_MS. Both screens show the same
 * two-digit code, so someone shown a code that is not theirs can tell.
 */
const QR_TTL_MS = 3 * 60_000
const MAX_QR = 1_000
export const QR_COOKIE = 'automate_qr'
const QR_PURPOSE = { signin: 'qrsignin', link: 'qrlink' }
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex')
const qrAll = () => readJson('wallet-qr.json', {})
const qrSave = (all) => {
  const now = Date.now()
  writeJson('wallet-qr.json', Object.fromEntries(Object.entries(all).filter(([, r]) => r.exp > now).slice(-MAX_QR)))
}

/** A new QR request. Returns { id, secret, code, expiresAt } — the secret goes ONLY in qrCookie. */
export function startQr({ purpose, userId = null, email = '' }) {
  if (!QR_PURPOSE[purpose]) throw new Error('Unknown QR purpose.')
  if (purpose === 'link' && !userId) throw new Error('Linking needs a signed-in account.')
  const id = crypto.randomBytes(16).toString('hex')
  const secret = crypto.randomBytes(16).toString('hex')
  const code = String(crypto.randomInt(10, 100))
  const expiresAt = Date.now() + QR_TTL_MS
  const all = qrAll()
  all[id] = { purpose, secret: sha(secret), code, userId: purpose === 'link' ? userId : null, email: purpose === 'link' ? String(email || '') : '', status: 'pending', exp: expiresAt }
  qrSave(all)
  return { id, secret, code, expiresAt }
}

const secureReq = (request) => new URL(request.url).protocol === 'https:' || String(request.headers.get('x-forwarded-proto') || '').startsWith('https')
export function qrCookie({ id, secret }, request) {
  return `${QR_COOKIE}=${id}.${secret}; Path=/; Max-Age=${QR_TTL_MS / 1000}; HttpOnly; SameSite=Lax${secureReq(request) ? '; Secure' : ''}`
}
export function clearQrCookie(request) {
  return `${QR_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secureReq(request) ? '; Secure' : ''}`
}
function readQrCookie(request) {
  const m = String(request.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${QR_COOKIE}=([0-9a-f]{32})\\.([0-9a-f]{32})(?:;|$)`))
  return m ? { id: m[1], secret: m[2] } : null
}

const maskEmail = (e) => { const [u, d] = String(e || '').split('@'); return d ? `${u.slice(0, 1)}•••@${d}` : '' }

/** What the phone page may show about a request, or null if it is gone, used or expired. */
export function qrRequest(id) {
  const r = /^[0-9a-f]{32}$/.test(String(id || '')) ? qrAll()[id] : null
  if (!r || r.exp <= Date.now() || r.status !== 'pending') return null
  return { purpose: r.purpose, statement: QR_PURPOSE[r.purpose], code: r.code, account: maskEmail(r.email), expiresAt: r.exp }
}

/** The phone signed. Returns { ok: true, purpose } or { ok: false, reason } — never throws. */
export function approveQr({ id, message, signature, request, cookieNonce }) {
  const gone = { ok: false, reason: 'This code has expired or was already used. Make a new one on your computer.' }
  const pending = qrRequest(id)
  if (!pending) return gone
  const v = verifyWalletMessage({ message, signature, request, purpose: pending.statement, cookieNonce, requestId: id })
  if (!v.ok) return v
  const all = qrAll()
  const r = all[id]
  if (!r || r.status !== 'pending' || r.exp <= Date.now()) return gone
  if (r.purpose === 'signin') {
    const acct = accountOf(v.address)
    if (!acct) return { ok: false, reason: 'This wallet is not linked to an account yet. Sign in with your email on your computer, then link it under Settings → Sign in with MetaMask.' }
    r.userId = acct.userId
  } else {
    const l = linkWallet({ userId: r.userId, email: r.email, address: v.address })
    if (!l.ok) return l
  }
  Object.assign(r, { status: 'approved', address: v.address })
  qrSave(all)
  return { ok: true, purpose: r.purpose }
}

/**
 * The computer asks how its request is doing. Only the browser holding the
 * request's secret gets an answer about it; an approved request is handed out
 * once and then deleted. Returns { status: 'pending' | 'expired' | 'approved', ... }.
 */
export function claimQr(request) {
  const c = readQrCookie(request)
  if (!c) return { status: 'expired' }
  const all = qrAll()
  const r = all[c.id]
  if (!r || r.exp <= Date.now()) return { status: 'expired' }
  const a = Buffer.from(sha(c.secret)), b = Buffer.from(String(r.secret))
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { status: 'expired' }
  if (r.status !== 'approved') return { status: 'pending' }
  delete all[c.id]
  qrSave(all)
  return { status: 'approved', purpose: r.purpose, userId: r.userId, address: r.address }
}
