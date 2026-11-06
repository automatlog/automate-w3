/**
 * USDC on Arc (Circle's testnet) for the trust steps (6 Nov 2026, ETHGlobal).
 *
 * "Ask for payment": the flow pauses, the customer opens a pay page, pays an exact
 * USDC amount to the merchant address, and the watcher tick finds that transfer
 * on chain and resumes the flow. "Send USDC": the server wallet pays someone out.
 *
 * Why an exact unique amount instead of a memo: a plain wallet transfer carries no
 * reference, so each open request gets its own price (12.34 + 0.000417). Two
 * customers buying the same thing at the same time still differ by a few micro-USDC.
 *
 * Why raw JSON-RPC and not ethers' provider: ethers' node build talks over node:http,
 * which the offline test cannot fake; plain fetch keeps one path for tests and
 * production. ethers is used only to sign and to check addresses.
 *
 * Testnet only. The private key is read at call time and never logged or returned.
 */
import fs from 'node:fs'
import path from 'node:path'
import { Wallet, isAddress, getAddress, Interface, AbiCoder, keccak256, getBytes, hexlify, randomBytes } from 'ethers'

export const ARC_CHAIN_ID = 5042002
const DEFAULT_RPC = 'https://rpc.testnet.arc.io'
const ALT_RPCS = [
  'https://rpc.blockdaemon.testnet.arc.io',
  'https://rpc.drpc.testnet.arc.io',
  'https://rpc.quicknode.testnet.arc.io',
]
const EXPLORER = 'https://explorer.testnet.arc.io'
export const USDC_ADDRESS = '0x3600000000000000000000000000000000000000'
/* The docs say a system emitter logs every USDC Transfer; they do not say whether
   the log's address is the token or the emitter, so we accept both. */
const SYSTEM_EMITTER = '0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE'
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const DECIMALS = 6

const MAX_REQUEST_USDC = 10_000          // what one payment request may ask for
const DEFAULT_MAX_SEND_USDC = 100        // what sendUsdc may move per call, unless raised
const DEFAULT_PAY_MINUTES = 30
const MAX_TAG_MICRO = 9999               // unique tag, in micro-USDC (0.000001 each)
const FROM_BLOCK_MARGIN = 20             // blocks before "now" we start looking, for clock skew
const LOG_WINDOW_BLOCKS = 9000           // most RPCs refuse wider getLogs ranges
const MAX_WINDOWS_PER_CALL = 12          // ~108k blocks; older requests have long expired
const RPC_TIMEOUT_MS = 15_000
const CONFIRM_TIMEOUT_MS = 60_000        // how long sendUsdc waits for 1 confirmation
const CONFIRM_POLL_MS = 1500
const MAX_SEEN = 2000

const env = (k) => (process.env[k] || '').trim()
const dataFile = (n) => path.join(process.cwd(), 'data', n)

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}
/* Atomic: a crash mid-write must not leave half a file (tmp + rename). */
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value))
  fs.renameSync(`${file}.tmp`, file)
}

/* ---------- exact money math ---------- */

/** "12.34" -> "12340000" (6-decimal units). Throws on anything that is not a plain decimal. */
export function toUnits(amount) {
  const s = String(amount ?? '').trim()
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new Error('Amount must be a plain number with at most 6 decimals')
  const [w, f = ''] = s.split('.')
  return (BigInt(w) * 10n ** 6n + BigInt(f.padEnd(DECIMALS, '0'))).toString()
}

/** "12340000" -> "12.34". Keeps at least two decimals, drops trailing zeros beyond that. */
export function fromUnits(units) {
  const u = BigInt(String(units))
  const w = u / 10n ** 6n
  let f = (u % 10n ** 6n).toString().padStart(DECIMALS, '0').replace(/0+$/, '')
  if (f.length < 2) f = f.padEnd(2, '0')
  return `${w}.${f}`
}

/* ---------- config ---------- */

function keyAddress() {
  const k = env('ARC_PRIVATE_KEY')
  if (!k) return ''
  try { return new Wallet(k).address } catch { return '' }
}
function merchantAddress() {
  const m = env('ARC_MERCHANT_ADDRESS')
  if (m) return isAddress(m) ? getAddress(m) : ''
  return keyAddress()
}
function rpcList() {
  const own = env('ARC_RPC_URL')
  return own ? [own] : [DEFAULT_RPC, ...ALT_RPCS]
}
function maxSend() {
  const n = Number(env('ARC_MAX_SEND_USDC') || DEFAULT_MAX_SEND_USDC)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_SEND_USDC
}
const payMinutes = () => {
  const n = Number(env('ARC_PAY_MINUTES') || DEFAULT_PAY_MINUTES)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PAY_MINUTES
}

/** What the flow builder may show. Never includes the key. */
export function arcConfig() {
  const merchant = merchantAddress()
  const missing = []
  if (!merchant) {
    if (env('ARC_MERCHANT_ADDRESS')) missing.push('ARC_MERCHANT_ADDRESS (not a valid address)')
    else if (env('ARC_PRIVATE_KEY')) missing.push('ARC_PRIVATE_KEY (not a valid key)')
    else missing.push('ARC_MERCHANT_ADDRESS or ARC_PRIVATE_KEY')
  }
  return {
    ready: missing.length === 0,
    canSend: !!keyAddress(),
    missing,
    chainId: ARC_CHAIN_ID,
    rpcUrl: rpcList()[0],
    usdc: USDC_ADDRESS,
    merchant,
    explorer: EXPLORER,
  }
}

export const explorerTx = (hash) => `${EXPLORER}/tx/${hash}`

/* ---------- JSON-RPC ---------- */

let rpcId = 1
async function rpc(method, params = []) {
  let lastErr = null
  for (const url of rpcList()) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(`Arc RPC answered ${res.status}`)
      const j = await res.json()
      if (j.error) {
        // A node-level refusal is final for this call (bad tx, revert): do not try the next node.
        const e = new Error(`Arc RPC refused ${method}: ${String(j.error.message || 'error').slice(0, 160)}`)
        e.final = true
        throw e
      }
      return j.result
    } catch (e) {
      if (e.final) throw e
      lastErr = e
    }
  }
  throw new Error(`Arc network is not reachable (${lastErr?.message || 'no answer'})`)
}
const hexToNum = (h) => Number(BigInt(h))

/* ---------- open amounts (collision guard) ---------- */

function loadOpen() {
  const now = Date.now()
  const o = readJson(dataFile('arc-open.json'), {})
  const live = {}
  for (const [k, exp] of Object.entries(o && typeof o === 'object' ? o : {})) if (exp > now) live[k] = exp
  return live
}
function freeOpen(units) {
  const o = loadOpen()
  if (units in o) { delete o[units]; writeJson(dataFile('arc-open.json'), o) }
}

/**
 * Validate the price and hand back the exact amount to ask for.
 * `amount` is what the merchant typed (max 2 decimals); the tag is ours.
 */
export async function newPayment({ amount, label, minutes } = {}) {
  const cfg = arcConfig()
  if (!cfg.ready) throw new Error(`Arc payments are not set up: set ${cfg.missing.join(', ')}`)
  const raw = String(amount ?? '').trim()
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) throw new Error('Amount must be a number with at most 2 decimals, like 12.50')
  const base = BigInt(toUnits(raw))
  if (base <= 0n) throw new Error('Amount must be more than 0')
  if (base > BigInt(MAX_REQUEST_USDC) * 10n ** 6n) throw new Error(`Amount cannot be more than ${MAX_REQUEST_USDC} USDC`)
  if (escrowAddress()) return newEscrowPayment({ units: base.toString(), label, minutes })

  const open = loadOpen()
  let units = ''
  for (let i = 0; i < 200 && !units; i++) {
    const cand = (base + BigInt(1 + Math.floor(Math.random() * MAX_TAG_MICRO))).toString()
    if (!(cand in open)) units = cand
  }
  if (!units) throw new Error('Too many open payments at this price; try again in a few minutes')
  open[units] = Date.now() + (payMinutes() + 10) * 60_000
  writeJson(dataFile('arc-open.json'), open)

  const latest = hexToNum(await rpc('eth_blockNumber'))
  return {
    amountUnits: units,
    amountText: `${fromUnits(units)} USDC`,
    label: String(label || '').slice(0, 120),
    merchant: cfg.merchant,
    chainId: ARC_CHAIN_ID,
    usdc: USDC_ADDRESS,
    fromBlock: Math.max(0, latest - FROM_BLOCK_MARGIN),
  }
}

/* ---------- finding payments ---------- */

const pad32 = (addr) => `0x${addr.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`

/**
 * One scan for every open payment: ERC-20 Transfers to the merchant whose amount
 * equals a pending request exactly. A transaction hash can settle one request once.
 */
export async function findPayments(pendings) {
  const all = (pendings || []).filter((p) => p && p.kind === 'pay' && p.status === 'pending')
  const escrowRows = all.filter((p) => p.data?.mode === 'escrow')
  const found0 = escrowRows.length ? await findEscrowPayments(escrowRows) : []
  const open = all.filter((p) => p.data?.mode !== 'escrow' && p.data?.amountUnits && p.data?.merchant)
  if (!open.length) return found0
  const latest = hexToNum(await rpc('eth_blockNumber'))
  let from = Math.min(...open.map((p) => (Number.isFinite(p.data.fromBlock) ? p.data.fromBlock : Math.max(0, latest - 1000))))
  from = Math.max(from, latest - MAX_WINDOWS_PER_CALL * LOG_WINDOW_BLOCKS + 1, 0)
  const merchants = [...new Set(open.map((p) => pad32(p.data.merchant)))]

  const logs = []
  for (let start = from; start <= latest; start += LOG_WINDOW_BLOCKS) {
    const end = Math.min(latest, start + LOG_WINDOW_BLOCKS - 1)
    const got = await rpc('eth_getLogs', [{
      fromBlock: `0x${start.toString(16)}`,
      toBlock: `0x${end.toString(16)}`,
      address: [USDC_ADDRESS, SYSTEM_EMITTER],
      topics: [TRANSFER_TOPIC, null, merchants.length === 1 ? merchants[0] : merchants],
    }])
    if (Array.isArray(got)) logs.push(...got)
  }

  const seenList = readJson(dataFile('arc-seen.json'), [])
  const seen = new Set(Array.isArray(seenList) ? seenList : [])
  const found = []
  const taken = new Set()
  for (const l of logs) {
    if (!l || l.removed || !l.transactionHash || seen.has(l.transactionHash)) continue
    if (!Array.isArray(l.topics) || l.topics[0] !== TRANSFER_TOPIC || l.topics.length < 3) continue
    let units
    try { units = BigInt(l.data).toString() } catch { continue }
    const p = open.find((x) => !taken.has(x.id)
      && x.data.amountUnits === units
      && pad32(x.data.merchant) === String(l.topics[2]).toLowerCase()
      && hexToNum(l.blockNumber) >= (Number(x.data.fromBlock) || 0))
    if (!p) continue
    taken.add(p.id)
    seen.add(l.transactionHash)
    found.push({
      id: p.id,
      txHash: l.transactionHash,
      payer: `0x${String(l.topics[1]).slice(-40)}`,
      blockNumber: hexToNum(l.blockNumber),
    })
    freeOpen(p.data.amountUnits)
  }
  if (found.length) writeJson(dataFile('arc-seen.json'), [...seen].slice(-MAX_SEEN))
  return [...found0, ...found]
}

/* ---------- paying out ---------- */

const ERC20 = new Interface(['function transfer(address to, uint256 amount) returns (bool)'])

/**
 * The server wallet pays `to`. `memo` is accepted for the flow's sake but not sent:
 * the memo contract needs its own call and nothing here depends on it (our matching
 * is by amount), so it is left out rather than half-done.
 */
export async function sendUsdc({ to, amount } = {}) {
  const key = env('ARC_PRIVATE_KEY')
  if (!key) throw new Error('Cannot send USDC: ARC_PRIVATE_KEY is not set')
  if (!isAddress(String(to || ''))) throw new Error('Cannot send USDC: the address is not valid')
  const units = toUnits(amount)
  if (BigInt(units) <= 0n) throw new Error('Cannot send USDC: the amount must be more than 0')
  const limit = maxSend()
  if (BigInt(units) > BigInt(Math.round(limit * 1e6))) {
    throw new Error(`Cannot send ${fromUnits(units)} USDC: the limit is ${limit} USDC per send. Raise it with ARC_MAX_SEND_USDC`)
  }
  let wallet
  try { wallet = new Wallet(key) } catch { throw new Error('Cannot send USDC: ARC_PRIVATE_KEY is not a valid key') }

  const data = ERC20.encodeFunctionData('transfer', [getAddress(to), BigInt(units)])
  const nonce = hexToNum(await rpc('eth_getTransactionCount', [wallet.address, 'pending']))
  const gasPrice = BigInt(await rpc('eth_gasPrice'))
  const gas = BigInt(await rpc('eth_estimateGas', [{ from: wallet.address, to: USDC_ADDRESS, data }]))
  const raw = await wallet.signTransaction({
    type: 0,
    chainId: ARC_CHAIN_ID,
    nonce,
    to: USDC_ADDRESS,
    data,
    value: 0n,
    gasLimit: gas + gas / 5n,
    gasPrice: gasPrice + gasPrice / 5n,
  })
  const txHash = await rpc('eth_sendRawTransaction', [raw])

  const deadline = Date.now() + CONFIRM_TIMEOUT_MS
  for (;;) {
    const r = await rpc('eth_getTransactionReceipt', [txHash])
    if (r) {
      if (r.status === '0x0') throw new Error(`The USDC transfer was rejected on chain (${explorerTx(txHash)})`)
      return { txHash, explorerUrl: explorerTx(txHash) }
    }
    if (Date.now() > deadline) throw new Error(`The USDC transfer was sent but not confirmed in time; check ${explorerTx(txHash)}`)
    await new Promise((r2) => setTimeout(r2, CONFIRM_POLL_MS))
  }
}

/* ---------- escrow mode: TrustEscrow, built in Arc Studio (6 Nov 2026, ETHGlobal) ----------
 *
 * With ARC_ESCROW_ADDRESS set, a payment goes INTO the escrow instead of
 * straight to the merchant, and only the operator (this server's wallet) can
 * release it to the merchant or refund it to the payer — and the flow lets it
 * do so only after a Human approval. The customer can reclaim after 14 days if
 * nobody acts. The contract (arc-escrow/ in automate-w3) takes
 *
 *   pay(bytes32 orderId, uint256 amount, uint256 deadline, bytes signature)
 *
 * where `signature` is the operator's EIP-191 signature over
 * keccak256(abi.encode(chainid, escrow, orderId, amount, deadline)) — so only
 * the exact amount we quoted, for this order, before the deadline, is payable.
 * Matching is by orderId (an indexed topic of Paid), not by a unique amount.
 */
const ESCROW_ABI = new Interface([
  'function pay(bytes32 orderId, uint256 amount, uint256 deadline, bytes signature)',
  'function release(bytes32 orderId)',
  'function refund(bytes32 orderId)',
  'function operator() view returns (address)',
  'event Paid(bytes32 indexed orderId, address indexed payer, uint256 amount)',
])
const USDC_ABI = new Interface(['function approve(address spender, uint256 amount) returns (bool)'])
const PAID_TOPIC = ESCROW_ABI.getEvent('Paid').topicHash

export const escrowAddress = () => { const a = env('ARC_ESCROW_ADDRESS'); return a && isAddress(a) ? getAddress(a) : '' }

/** The digest the contract checks (before the EIP-191 prefix). */
export function escrowDigest({ escrow, orderId, units, deadline, chainId = ARC_CHAIN_ID }) {
  return keccak256(AbiCoder.defaultAbiCoder().encode(['uint256', 'address', 'bytes32', 'uint256', 'uint256'], [BigInt(chainId), getAddress(escrow), orderId, BigInt(units), BigInt(deadline)]))
}

let operatorChecked = ''
async function operatorWallet(escrow) {
  const key = env('ARC_PRIVATE_KEY')
  if (!key) throw new Error('Escrow payments need ARC_PRIVATE_KEY (the escrow operator) to sign them')
  let wallet
  try { wallet = new Wallet(key) } catch { throw new Error('ARC_PRIVATE_KEY is not a valid key') }
  /* Once per escrow and key: a key that is not the contract's operator would
     sign payment links the contract refuses — say so now, not at the customer's tap. */
  if (operatorChecked !== `${escrow}:${wallet.address}`) {
    const op = ESCROW_ABI.decodeFunctionResult('operator', await rpc('eth_call', [{ to: escrow, data: ESCROW_ABI.encodeFunctionData('operator') }, 'latest']))[0]
    if (getAddress(op) !== wallet.address) throw new Error(`ARC_PRIVATE_KEY is not the escrow's operator (${op}); payments it signs would be refused`)
    operatorChecked = `${escrow}:${wallet.address}`
  }
  return wallet
}

async function newEscrowPayment({ units, label, minutes }) {
  const escrow = escrowAddress()
  const wallet = await operatorWallet(escrow)
  const orderId = hexlify(randomBytes(32))
  const mins = Number(minutes) > 0 ? Number(minutes) : payMinutes()
  const deadline = Math.floor(Date.now() / 1000) + Math.round(mins * 60)
  const signature = await wallet.signMessage(getBytes(escrowDigest({ escrow, orderId, units, deadline })))
  const latest = hexToNum(await rpc('eth_blockNumber'))
  return {
    mode: 'escrow',
    escrow,
    orderId,
    deadline,
    amountUnits: units,
    amountText: `${fromUnits(units)} USDC`,
    label: String(label || '').slice(0, 120),
    merchant: escrow,
    chainId: ARC_CHAIN_ID,
    usdc: USDC_ADDRESS,
    approveData: USDC_ABI.encodeFunctionData('approve', [escrow, BigInt(units)]),
    payData: ESCROW_ABI.encodeFunctionData('pay', [orderId, BigInt(units), BigInt(deadline), signature]),
    fromBlock: Math.max(0, latest - FROM_BLOCK_MARGIN),
  }
}

/** Paid(orderId, payer, amount) events for the open escrow orders, exact amount only. */
async function findEscrowPayments(rows) {
  const latest = hexToNum(await rpc('eth_blockNumber'))
  let from = Math.min(...rows.map((p) => (Number.isFinite(p.data.fromBlock) ? p.data.fromBlock : Math.max(0, latest - 1000))))
  from = Math.max(from, latest - MAX_WINDOWS_PER_CALL * LOG_WINDOW_BLOCKS + 1, 0)
  const byEscrow = new Map()
  for (const p of rows) { const k = getAddress(p.data.escrow); if (!byEscrow.has(k)) byEscrow.set(k, []); byEscrow.get(k).push(p) }
  const found = []
  for (const [escrow, list] of byEscrow) {
    const ids = list.map((p) => String(p.data.orderId).toLowerCase())
    for (let start = from; start <= latest; start += LOG_WINDOW_BLOCKS) {
      const end = Math.min(latest, start + LOG_WINDOW_BLOCKS - 1)
      const logs = await rpc('eth_getLogs', [{ fromBlock: `0x${start.toString(16)}`, toBlock: `0x${end.toString(16)}`, address: escrow, topics: [PAID_TOPIC, ids.length === 1 ? ids[0] : ids] }])
      for (const l of Array.isArray(logs) ? logs : []) {
        if (!l || l.removed || !Array.isArray(l.topics) || l.topics[0] !== PAID_TOPIC) continue
        const p = list.find((x) => String(x.data.orderId).toLowerCase() === String(l.topics[1]).toLowerCase())
        if (!p || found.some((f) => f.id === p.id)) continue
        let units
        try { units = BigInt(l.data).toString() } catch { continue }
        if (units !== p.data.amountUnits) continue
        found.push({ id: p.id, txHash: l.transactionHash, payer: getAddress(`0x${String(l.topics[2]).slice(-40)}`), blockNumber: hexToNum(l.blockNumber), orderId: p.data.orderId })
      }
    }
  }
  return found
}

/** The server wallet sends one contract call and waits for it to be confirmed. */
async function sendTx(to, data, what) {
  const key = env('ARC_PRIVATE_KEY')
  if (!key) throw new Error(`Cannot ${what}: ARC_PRIVATE_KEY is not set`)
  let wallet
  try { wallet = new Wallet(key) } catch { throw new Error(`Cannot ${what}: ARC_PRIVATE_KEY is not a valid key`) }
  const nonce = hexToNum(await rpc('eth_getTransactionCount', [wallet.address, 'pending']))
  const gasPrice = BigInt(await rpc('eth_gasPrice'))
  const gas = BigInt(await rpc('eth_estimateGas', [{ from: wallet.address, to, data }]))
  const raw = await wallet.signTransaction({ type: 0, chainId: ARC_CHAIN_ID, nonce, to, data, value: 0n, gasLimit: gas + gas / 5n, gasPrice: gasPrice + gasPrice / 5n })
  const txHash = await rpc('eth_sendRawTransaction', [raw])
  const deadline = Date.now() + CONFIRM_TIMEOUT_MS
  for (;;) {
    const r = await rpc('eth_getTransactionReceipt', [txHash])
    if (r) {
      if (r.status === '0x0') throw new Error(`Could not ${what}: rejected on chain (${explorerTx(txHash)})`)
      return { txHash, explorerUrl: explorerTx(txHash) }
    }
    if (Date.now() > deadline) throw new Error(`Sent, but not confirmed in time; check ${explorerTx(txHash)}`)
    await new Promise((r2) => setTimeout(r2, CONFIRM_POLL_MS))
  }
}

/** Refund the escrowed order to its payer, or release it to the merchant. Operator only. */
export async function settleEscrow({ orderId, action } = {}) {
  const escrow = escrowAddress()
  if (!escrow) throw new Error('No escrow is set up (ARC_ESCROW_ADDRESS)')
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(orderId || ''))) throw new Error('There is no escrowed order to settle — {{usdc_order}} is empty')
  if (action !== 'refund' && action !== 'release') throw new Error('The escrow can only refund or release')
  return sendTx(escrow, ESCROW_ABI.encodeFunctionData(action, [orderId]), `${action} the escrowed USDC`)
}

/* ---------- the pay page ---------- */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c])
/* JSON inside a <script>: "<" is escaped so a label can never close the tag. */
const jsonForScript = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')

export function payPageHtml({ pending, statusUrl, state = 'open', txHash = '', message = '' } = {}) {
  const d = pending?.data || {}
  const escrowMode = d.mode === 'escrow'
  const cfg = {
    state,
    escrow: escrowMode ? d.escrow : '',
    approveData: escrowMode ? d.approveData : '',
    payData: escrowMode ? d.payData : '',
    statusUrl: String(statusUrl || ''),
    merchant: d.merchant || '',
    usdc: d.usdc || USDC_ADDRESS,
    units: d.amountUnits || '0',
    chainId: d.chainId || ARC_CHAIN_ID,
    rpcUrl: rpcList()[0],
    explorer: EXPLORER,
  }
  const eip681 = `ethereum:${cfg.usdc}@${cfg.chainId}/transfer?address=${cfg.merchant}&uint256=${cfg.units}`
  const label = d.label || 'Payment'
  const amount = d.amountText || `${fromUnits(cfg.units)} USDC`

  let body
  if (state === 'paid') {
    body = `<p class="tag">Paid</p><h1>${esc(label)}</h1><p class="amt">${esc(amount)}</p>
      <p class="note">Thank you. Your payment arrived and you can go back to WhatsApp.</p>
      ${txHash ? `<p><a class="link" href="${esc(explorerTx(txHash))}" rel="noopener">View the transaction</a></p>` : ''}`
  } else if (state === 'expired') {
    body = `<h1>${esc(label)}</h1><p class="amt dim">${esc(amount)}</p>
      <p class="note">This payment request has expired. Ask for a new one in the chat.</p>`
  } else if (state === 'error') {
    body = `<h1>Payment unavailable</h1><p class="note">${esc(message || 'Something went wrong. Please try again from the chat.')}</p>`
  } else if (escrowMode) {
    body = `<h1>${esc(label)}</h1>
      <p class="amt">${esc(amount)}</p>
      <p class="note">Held safely in escrow on Arc until your order is confirmed. If nobody acts, you can take it back after 14 days.</p>
      <button id="pay" class="btn" type="button">Pay with wallet</button>
      <p id="msg" class="note" role="status"></p>
      <div class="box"><span class="k">Escrow contract</span><code>${esc(cfg.escrow)}</code></div>
      <p class="note">Your wallet asks twice: once to allow the USDC, once to pay. Testnet USDC on Arc: <a class="link" href="https://faucet.circle.com" rel="noopener">faucet.circle.com</a>.</p>`
  } else {
    body = `<h1>${esc(label)}</h1>
      <p class="amt">${esc(amount)}</p>
      <p class="note">Send exactly this amount; the last digits identify your payment.</p>
      <button id="pay" class="btn" type="button">Pay with wallet</button>
      <p id="msg" class="note" role="status"></p>
      <div class="box"><span class="k">Pay to</span><code id="addr">${esc(cfg.merchant)}</code>
        <button id="copy" class="ghost" type="button">Copy address</button></div>
      <div class="box"><span class="k">Or scan</span><div id="qr" class="qr"><a class="link" href="${esc(eip681)}">${esc(eip681)}</a></div></div>
      <p class="note">Testnet USDC on Arc. Need some? Get it from <a class="link" href="https://faucet.circle.com" rel="noopener">faucet.circle.com</a>.</p>`
  }

  const script = state === 'open' && escrowMode ? `<script type="module">
const C=${jsonForScript(cfg)};
const $=id=>document.getElementById(id);const say=t=>{$('msg').textContent=t};
const pad=h=>h.replace(/^0x/,'').toLowerCase().padStart(64,'0');
const wait=async(eth,h)=>{for(let i=0;i<90;i++){const r=await eth.request({method:'eth_getTransactionReceipt',params:[h]});if(r)return r.status!=='0x0';await new Promise(x=>setTimeout(x,2000))}return false};
$('pay').onclick=async()=>{
  const eth=window.ethereum;if(!eth){say('Open this link in a wallet browser (MetaMask) to pay.');return}
  const hex='0x'+C.chainId.toString(16);
  try{
    try{await eth.request({method:'wallet_switchEthereumChain',params:[{chainId:hex}]})}
    catch(e){if(e&&e.code===4902){await eth.request({method:'wallet_addEthereumChain',params:[{chainId:hex,chainName:'Arc Testnet',nativeCurrency:{name:'USDC',symbol:'USDC',decimals:18},rpcUrls:[C.rpcUrl],blockExplorerUrls:[C.explorer]}]})}else throw e}
    const [from]=await eth.request({method:'eth_requestAccounts'});
    const allowance=BigInt(await eth.request({method:'eth_call',params:[{to:C.usdc,data:'0xdd62ed3e'+pad(from)+pad(C.escrow)},'latest']}));
    if(allowance<BigInt(C.units)){say('Step 1 of 2: allow the USDC…');const h=await eth.request({method:'eth_sendTransaction',params:[{from,to:C.usdc,data:C.approveData}]});if(!await wait(eth,h)){say('The allowance did not go through. Try again.');return}}
    say('Step 2 of 2: pay into escrow…');
    await eth.request({method:'eth_sendTransaction',params:[{from,to:C.escrow,data:C.payData}]});
    say('Sent. Waiting for it to arrive…');
  }catch(e){say(e&&e.code===4001?'Cancelled in the wallet.':'The wallet could not send it. Please try again.')}
};
const poll=async()=>{try{const r=await fetch(C.statusUrl,{headers:{accept:'application/json'}});const j=await r.json();if(j.status==='paid'||j.status==='expired')location.reload()}catch{}};
setInterval(poll,4000);
</script>`
  : state === 'open' ? `<script type="module">
const C=${jsonForScript(cfg)};const Q=${jsonForScript(eip681)};
const $=id=>document.getElementById(id);const say=t=>{$('msg').textContent=t};
const pad=h=>h.replace(/^0x/,'').toLowerCase().padStart(64,'0');
$('copy').onclick=async()=>{try{await navigator.clipboard.writeText(C.merchant);$('copy').textContent='Copied'}catch{say('Select the address and copy it by hand.')}};
$('pay').onclick=async()=>{
  const eth=window.ethereum;if(!eth){say('No wallet found in this browser. Scan the code or copy the address instead.');return}
  const hex='0x'+C.chainId.toString(16);
  try{
    try{await eth.request({method:'wallet_switchEthereumChain',params:[{chainId:hex}]})}
    catch(e){if(e&&e.code===4902){await eth.request({method:'wallet_addEthereumChain',params:[{chainId:hex,chainName:'Arc Testnet',nativeCurrency:{name:'USDC',symbol:'USDC',decimals:18},rpcUrls:[C.rpcUrl],blockExplorerUrls:[C.explorer]}]})}else throw e}
    const [from]=await eth.request({method:'eth_requestAccounts'});
    const data='0xa9059cbb'+pad(C.merchant)+BigInt(C.units).toString(16).padStart(64,'0');
    await eth.request({method:'eth_sendTransaction',params:[{from,to:C.usdc,data}]});
    say('Sent. Waiting for it to arrive...');
  }catch(e){say(e&&e.code===4001?'Cancelled in the wallet.':'The wallet could not send it. You can pay from the address above.')}
};
try{const m=await import('https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/+esm');const q=(m.default||m)(0,'M');q.addData(Q);q.make();$('qr').innerHTML=q.createSvgTag({cellSize:4,margin:2,scalable:true})}catch{}
const poll=async()=>{try{const r=await fetch(C.statusUrl,{headers:{accept:'application/json'}});const j=await r.json();if(j.status==='paid'||j.status==='expired')location.reload()}catch{}};
setInterval(poll,4000);
</script>` : ''

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(label)} - Pay</title>
<style>
:root{--bg:#0B0D0C;--ink:#D1D1D1;--dim:#8A8F8C;--line:#242826;--panel:#141715;--accent:#3DDC84}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:460px;margin:0 auto;padding:32px 16px}
h1{font-size:22px;font-weight:600;margin:0 0 8px;overflow-wrap:anywhere}
.amt{font-size:32px;font-weight:700;margin:0 0 8px;font-variant-numeric:tabular-nums}
.dim{color:var(--dim)}
.tag{display:inline-block;margin:0 0 12px;padding:4px 12px;border-radius:8px;background:var(--accent);color:#0B0D0C;font-weight:700}
.note{color:var(--dim);font-size:14px;margin:8px 0 16px}
.btn{width:100%;padding:14px 16px;border:0;border-radius:12px;background:var(--accent);color:#0B0D0C;font:inherit;font-weight:700;cursor:pointer}
.ghost{margin-top:8px;padding:8px 12px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--ink);font:inherit;font-size:14px;cursor:pointer}
.box{margin:16px 0;padding:12px 16px;border:1px solid var(--line);border-radius:12px;background:var(--panel)}
.k{display:block;color:var(--dim);font-size:13px;margin-bottom:4px}
code{display:block;font:13px/1.4 ui-monospace,Consolas,monospace;overflow-wrap:anywhere}
.qr{background:var(--ink);color:#0B0D0C;border-radius:8px;padding:8px;max-width:220px;overflow-wrap:anywhere;font-size:11px}
.qr svg{display:block;width:100%;height:auto}
.link{color:var(--ink);text-decoration:underline;overflow-wrap:anywhere}
.qr .link{color:#0B0D0C}
footer{margin-top:32px;color:var(--dim);font-size:13px}
</style></head>
<body><main>${body}<footer>Paid in USDC on Arc &middot; Automate</footer></main>${script}</body></html>`
}
