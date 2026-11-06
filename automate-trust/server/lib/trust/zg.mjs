/**
 * Proof on 0G — a run's record, stored where anyone can check it (6 Nov 2026, ETHGlobal).
 *
 * A flow with the "Proof on 0G" step has its run sealed when the run ends: a
 * redacted record of what ran (the steps in order, their timing, the trust
 * outcomes — approvals, payments, proofs of human — and their on-chain ids) is
 * uploaded to 0G Storage, and the run keeps the root hash. The run page shows
 * it, and Verify downloads the file again by that root hash, with 0G's Merkle
 * proof, and checks it byte for byte against what the run says now.
 *
 * WHAT GOES IN, AND WHAT NEVER DOES
 * 0G Storage is public. So the record carries no message text, no phone number,
 * no name, and no step log lines (those quote customers). The contact is an
 * HMAC with a server secret, so the same customer reads the same across runs
 * without the number being guessable from the hash. Trust outcomes are written
 * by the trust steps themselves as small fixed objects (see graph-runtime).
 *
 * The record is canonical JSON (keys sorted), so the same run always hashes the
 * same, and its sha256 is kept beside the root hash: Verify compares three
 * things — the downloaded bytes, the digest stored at sealing, and the record
 * rebuilt from the run now — so a local edit to the run shows as well as a
 * changed upload.
 */
import crypto from 'node:crypto'

const DEFAULTS = {
  rpcUrl: 'https://evmrpc-testnet.0g.ai',
  indexerUrl: 'https://indexer-storage-testnet-turbo.0g.ai',
  explorer: 'https://chainscan-galileo.0g.ai',
  network: '0G Galileo testnet',
}
/** An upload waits this long for 0G before the run is marked "not sealed". */
const UPLOAD_TIMEOUT_MS = 120_000
/** Verify waits this long for the download. */
const DOWNLOAD_TIMEOUT_MS = 60_000
/** Path entries and trust outcomes kept in one record. */
const MAX_PATH = 200
const MAX_TRUST = 40

export function zgConfig() {
  const key = String(process.env.ZG_PRIVATE_KEY || '').trim()
  return {
    ready: Boolean(key),
    missing: key ? [] : ['ZG_PRIVATE_KEY'],
    rpcUrl: process.env.ZG_RPC_URL || DEFAULTS.rpcUrl,
    indexerUrl: process.env.ZG_INDEXER_URL || DEFAULTS.indexerUrl,
    explorer: (process.env.ZG_EXPLORER_URL || DEFAULTS.explorer).replace(/\/+$/, ''),
    network: process.env.ZG_NETWORK_NAME || DEFAULTS.network,
  }
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')
/** The contact, as a stable id that does not reveal the number. */
const contactId = (ws, from) => {
  const salt = process.env.ZG_CONTACT_SALT || process.env.ENGINE_SECRET || 'automate-0g'
  return `c_${crypto.createHmac('sha256', salt).update(`${ws || ''}|${from || ''}`).digest('hex').slice(0, 16)}`
}

/** JSON with every object's keys sorted — the same record always gives the same bytes. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  return JSON.stringify(v ?? null)
}

/* A trust outcome is copied field by field from a short allow-list, so nothing
   a step happens to add later (a phone, a message) can ride along. */
const TRUST_FIELDS = ['step', 'node', 'outcome', 'amount', 'tx', 'chain', 'payer', 'approver', 'acr', 'action', 'nullifier', 'requestId', 'model', 'provider', 'at']
const cleanTrust = (d) => Object.fromEntries(TRUST_FIELDS.filter((k) => d?.[k] != null).map((k) => [k, String(d[k]).slice(0, 120)]))

/** The public record of one run. */
export function proofRecord(exec) {
  return {
    v: 1,
    kind: 'automate.run',
    app: 'https://automateplatform.in',
    run: exec.id,
    /* This contact's previous sealed run — the runs of one conversation chain. */
    prev: exec.proofPrev || null,
    at: exec.at,
    flow: exec.flowId || null,
    trigger: exec.trigger || 'message',
    channel: exec.channel || null,
    contact: exec.from ? contactId(exec.workspaceId, exec.from) : null,
    status: exec.status || null,
    ms: exec.ms ?? null,
    errors: exec.errors || 0,
    path: (exec.path || []).slice(0, MAX_PATH).map((n) => ({ id: n.id, type: n.type, title: String(n.title || '').slice(0, 60), t: n.t ?? null })),
    trust: (exec.steps || []).filter((s) => s.type === 'trust' && s.detail).slice(0, MAX_TRUST).map((s) => cleanTrust(s.detail)),
  }
}

const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} took longer than ${ms / 1000} s`)), ms).unref?.())])

/* One upload at a time: they all spend from the same wallet, and two at once
   would race for the same nonce. */
let queue = Promise.resolve()

/**
 * Upload a finished run's record. Returns the proof to keep on the run:
 * { status: 'sealed', root, tx, digest, bytes, network, explorer, at } — or
 * { status: 'skipped' | 'failed', reason } (never throws).
 * `sdk` / `ethers` are injected by tests.
 */
export function sealRun(exec, { sdk, ethers } = {}) {
  const job = queue.then(() => sealNow(exec, { sdk, ethers }))
  queue = job.catch(() => {})
  return job
}

async function sealNow(exec, { sdk, ethers: eth } = {}) {
  const cfg = zgConfig()
  if (!cfg.ready) return { status: 'skipped', reason: `0G is not set up on this server (${cfg.missing.join(', ')})` }
  const body = canonical(proofRecord(exec))
  const digest = sha256(body)
  try {
    const { Indexer, MemData } = sdk || await import('@0gfoundation/0g-storage-ts-sdk')
    const { ethers } = eth ? { ethers: eth } : await import('ethers')
    const provider = new ethers.JsonRpcProvider(cfg.rpcUrl)
    const signer = new ethers.Wallet(String(process.env.ZG_PRIVATE_KEY).trim(), provider)
    const mem = new MemData(new TextEncoder().encode(body))
    const [tree, treeErr] = await mem.merkleTree()
    if (treeErr) throw new Error(`could not hash the record: ${treeErr.message || treeErr}`)
    const [tx, upErr] = await withTimeout(new Indexer(cfg.indexerUrl).upload(mem, cfg.rpcUrl, signer), UPLOAD_TIMEOUT_MS, 'the 0G upload')
    if (upErr) throw new Error(upErr.message || String(upErr))
    const root = tx?.rootHash || tree?.rootHash?.()
    const txHash = tx?.txHash || null
    if (!root) throw new Error('0G returned no root hash')
    return { status: 'sealed', root, tx: txHash, digest, bytes: body.length, network: cfg.network, explorer: txHash ? `${cfg.explorer}/tx/${txHash}` : null, at: new Date().toISOString() }
  } catch (e) {
    /* The wallet key is never in these messages: ethers does not echo it, and
       the caller's push() redacts key shapes as a second guard. */
    return { status: 'failed', reason: `not sealed on 0G: ${String(e.message || e).slice(0, 200)}`, digest }
  }
}

/**
 * Check a sealed run: download its record from 0G by root hash (with the Merkle
 * proof) and compare. Returns { ok, checks: { downloaded, stored, rebuilt }, ... }.
 */
export async function verifyRun(exec, { sdk } = {}) {
  const p = exec?.proof
  if (!p || p.status !== 'sealed' || !p.root) return { ok: false, reason: 'this run was not sealed on 0G' }
  const rebuilt = sha256(canonical(proofRecord(exec)))
  let downloaded = null
  try {
    const { Indexer } = sdk || await import('@0gfoundation/0g-storage-ts-sdk')
    const [blob, err] = await withTimeout(new Indexer(zgConfig().indexerUrl).downloadToBlob(p.root, { proof: true }), DOWNLOAD_TIMEOUT_MS, 'the 0G download')
    if (err) throw new Error(err.message || String(err))
    downloaded = sha256(Buffer.from(await blob.arrayBuffer()).toString('utf8'))
  } catch (e) {
    return { ok: false, reason: `could not download the record from 0G: ${String(e.message || e).slice(0, 200)}`, root: p.root, stored: p.digest, rebuilt }
  }
  const ok = downloaded === p.digest && rebuilt === p.digest
  return {
    ok, root: p.root, tx: p.tx || null, explorer: p.explorer || null,
    checks: { downloaded, stored: p.digest, rebuilt },
    reason: ok ? 'the record on 0G matches this run' : downloaded !== p.digest ? 'the file on 0G differs from what was sealed' : 'this run has changed since it was sealed',
  }
}

/* The public check (6 Nov 2026, ETHGlobal): a root hash is all anyone needs —
   the judges cannot sign in, and a customer should not have to. It shows only
   what 0G already holds publicly; when this server still has the run, all
   three digests are compared as in verifyRun. A result is kept 10 minutes per
   root, so a busy page does not hammer the 0G indexer; a failed download is
   never kept. `findRun(root)` and `sdk` are injected (webhook-core, tests). */
const ROOT_RE = /^0x[0-9a-f]{64}$/
const ROOT_CACHE_MS = 10 * 60_000
const ROOT_CACHE_MAX = 200
const rootCache = new Map() // root → { at, out }

export async function verifyRoot(root, { findRun, sdk, cache = true } = {}) {
  const r = String(root || '').trim().toLowerCase()
  if (!ROOT_RE.test(r)) return { ok: false, root: null, reason: 'that is not a 0G root hash (0x and 64 hex characters)' }
  const hit = cache && rootCache.get(r)
  if (hit && Date.now() - hit.at < ROOT_CACHE_MS) return hit.out
  let text
  try {
    const { Indexer } = sdk || await import('@0gfoundation/0g-storage-ts-sdk')
    const [blob, err] = await withTimeout(new Indexer(zgConfig().indexerUrl).downloadToBlob(r, { proof: true }), DOWNLOAD_TIMEOUT_MS, 'the 0G download')
    if (err) throw new Error(err.message || String(err))
    text = Buffer.from(await blob.arrayBuffer()).toString('utf8')
  } catch (e) {
    return { ok: false, root: r, reason: `could not download this record from 0G: ${String(e.message || e).slice(0, 200)}` }
  }
  let record = null
  try { const j = JSON.parse(text); if (j && j.kind === 'automate.run') record = j } catch { /* not JSON: not a run record */ }
  const run = (findRun && findRun(r)) || null
  const downloaded = sha256(text)
  const stored = run?.proof?.digest || null
  const rebuilt = run ? sha256(canonical(proofRecord(run))) : null
  const ok = !record ? false : run ? downloaded === stored && rebuilt === stored : null
  const out = {
    ok, root: r, record, tx: run?.proof?.tx || null, explorer: run?.proof?.explorer || null,
    checks: { downloaded, stored, rebuilt },
    reason: !record ? 'the file at this root is not a run record'
      : ok === null ? 'downloaded from 0G with its Merkle proof; this server no longer has the run to compare it with'
        : ok ? 'the record on 0G matches the run' : downloaded !== stored ? 'the file on 0G differs from what was sealed' : 'the run has changed since it was sealed',
  }
  if (cache) {
    if (rootCache.size >= ROOT_CACHE_MAX) rootCache.delete(rootCache.keys().next().value)
    rootCache.set(r, { at: Date.now(), out })
  }
  return out
}
