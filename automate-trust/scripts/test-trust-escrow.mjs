/**
 * Escrow mode of trust/arc.mjs — TrustEscrow, built in Arc Studio (6 Nov 2026, ETHGlobal):
 *
 *   1. newPayment with ARC_ESCROW_ADDRESS set: a fresh 32-byte order id, the exact
 *      amount (no unique tag), a deadline, approve(escrow, amount) and
 *      pay(orderId, amount, deadline, signature) calldata — and the signature is
 *      the operator's EIP-191 signature over the digest the contract checks.
 *   2. A key that is not the contract's operator is refused before any link is made.
 *   3. findPayments matches Paid(orderId, payer, amount) by order id and exact
 *      amount; a wrong amount or another order does not match; direct (non-escrow)
 *      rows still work beside escrow rows.
 *   4. settleEscrow signs refund(orderId) / release(orderId) to the escrow on chain
 *      5042002; a missing order id or no escrow is refused before anything is signed.
 *   5. The escrow pay page: two wallet steps, the escrow address, no QR, escaped label.
 *
 * Arc's RPC is faked; the test fails if anything else is reached. Temp folder.
 *
 *   node scripts/test-trust-escrow.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Wallet, Transaction, Interface, AbiCoder, keccak256, getBytes, verifyMessage, getAddress } from 'ethers'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..')
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'trust-escrow-')))
for (const k of Object.keys(process.env)) if (/^ARC_/.test(k)) delete process.env[k]

let passed = 0, failed = 0
const ok = (cond, msg, extra = '') => { if (cond) passed++; else { failed++; console.error(`FAIL: ${msg}${extra ? `\n      ${String(extra).slice(0, 300)}` : ''}`) } }
const throws = async (fn) => { try { await fn(); return null } catch (e) { return String(e.message) } }

const op = Wallet.createRandom()
const ESCROW = getAddress('0x00000000000000000000000000000000000e5c40')
const USDC = '0x3600000000000000000000000000000000000000'
process.env.ARC_RPC_URL = 'https://rpc.escrow.test/'
process.env.ARC_PRIVATE_KEY = op.privateKey
process.env.ARC_ESCROW_ADDRESS = ESCROW

const E = new Interface([
  'function pay(bytes32 orderId, uint256 amount, uint256 deadline, bytes signature)',
  'function refund(bytes32 orderId)', 'function release(bytes32 orderId)', 'function operator() view returns (address)',
  'event Paid(bytes32 indexed orderId, address indexed payer, uint256 amount)',
])
const U = new Interface(['function approve(address spender, uint256 amount)', 'function transfer(address to, uint256 amount)'])
const PAID = E.getEvent('Paid').topicHash
const pad = (h) => `0x${String(h).toLowerCase().replace(/^0x/, '').padStart(64, '0')}`
const hex = (n) => `0x${BigInt(n).toString(16)}`
const chain = { block: 900_000, logs: [], raw: [], operator: op.address }
const outside = []
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url))
  if (u.hostname !== 'rpc.escrow.test') { outside.push(u.hostname); throw new Error(`network call outside the test: ${url}`) }
  const { method, params, id: rid } = JSON.parse(init.body)
  const reply = (result) => new Response(JSON.stringify({ jsonrpc: '2.0', id: rid, result }), { status: 200 })
  switch (method) {
    case 'eth_blockNumber': return reply(hex(chain.block))
    case 'eth_call': return reply(params[0].data === E.encodeFunctionData('operator') ? pad(chain.operator) : '0x')
    case 'eth_getLogs': {
      const f = params[0], want = [].concat(f.topics[1] || []).map((t) => String(t).toLowerCase())
      return reply(chain.logs.filter((l) => (!f.address || [].concat(f.address).map((a) => a.toLowerCase()).includes(l.address.toLowerCase())) && (f.topics[0] == null || l.topics[0] === f.topics[0]) && (!want.length || want.includes(l.topics[1].toLowerCase()))))
    }
    case 'eth_getTransactionCount': return reply('0x3')
    case 'eth_gasPrice': return reply(hex(1_000_000_000n))
    case 'eth_estimateGas': return reply(hex(80_000))
    case 'eth_sendRawTransaction': chain.raw.push(params[0]); return reply(Transaction.from(params[0]).hash)
    case 'eth_getTransactionReceipt': return reply({ status: '0x1', blockNumber: hex(chain.block) })
    default: return new Response(JSON.stringify({ jsonrpc: '2.0', id: rid, error: { code: -32601, message: `no ${method}` } }), { status: 200 })
  }
}
const A = await import(pathToFileURL(path.join(ROOT, 'server', 'lib', 'trust', 'arc.mjs')).href)

/* ---- 1. newPayment in escrow mode ---- */
const t0 = Math.floor(Date.now() / 1000)
const p = await A.newPayment({ amount: '12.50', label: 'Order 7 <b>', minutes: 20 })
ok(p.mode === 'escrow' && p.escrow === ESCROW && p.merchant === ESCROW, 'escrow mode: the escrow is where the money goes', JSON.stringify(p))
ok(/^0x[0-9a-f]{64}$/.test(p.orderId), 'a 32-byte order id')
ok(p.amountUnits === '12500000' && p.amountText === '12.50 USDC', 'the exact amount, no unique tag (the order id identifies the payment)', p.amountUnits)
ok(p.deadline >= t0 + 20 * 60 && p.deadline <= t0 + 20 * 60 + 5, 'the deadline is the step\'s minutes from now', p.deadline - t0)
const ap = U.decodeFunctionData('approve', p.approveData)
ok(ap[0] === ESCROW && ap[1] === 12_500_000n, 'approve(escrow, exact amount)')
const pd = E.decodeFunctionData('pay', p.payData)
ok(pd[0] === p.orderId && pd[1] === 12_500_000n && pd[2] === BigInt(p.deadline), 'pay(orderId, amount, deadline, signature)')
const digest = keccak256(AbiCoder.defaultAbiCoder().encode(['uint256', 'address', 'bytes32', 'uint256', 'uint256'], [5042002n, ESCROW, p.orderId, 12_500_000n, BigInt(p.deadline)]))
ok(A.escrowDigest({ escrow: ESCROW, orderId: p.orderId, units: '12500000', deadline: p.deadline }) === digest, 'the digest is keccak256(abi.encode(chainid, escrow, orderId, amount, deadline))')
ok(verifyMessage(getBytes(digest), pd[3]) === op.address, 'the signature recovers to the operator (EIP-191 over the 32-byte digest)')
const p2 = await A.newPayment({ amount: '12.50', minutes: 20 })
ok(p2.orderId !== p.orderId, 'every payment gets its own order id')
ok(await throws(() => A.newPayment({ amount: '12.345' })), 'a third decimal is still refused')

/* ---- 2. a key that is not the operator ---- */
chain.operator = Wallet.createRandom().address
process.env.ARC_PRIVATE_KEY = Wallet.createRandom().privateKey
const notOp = await throws(() => A.newPayment({ amount: '1' }))
ok(/not the escrow's operator/.test(notOp || ''), 'a key that is not the contract\'s operator is refused before a link is made', notOp)
chain.operator = op.address
process.env.ARC_PRIVATE_KEY = op.privateKey

/* ---- 3. findPayments ---- */
const PAYER = Wallet.createRandom().address
const row = (data, idx) => ({ id: `row${idx}`, kind: 'pay', status: 'pending', data: { ...data, fromBlock: chain.block - 10 } })
const r1 = row(p, 1), r2 = row(p2, 2)
const log = (orderId, units, tx) => ({ address: ESCROW, topics: [PAID, orderId, pad(PAYER)], data: pad(hex(units)), blockNumber: hex(chain.block), transactionHash: `0x${tx.repeat(64).slice(0, 64)}`, removed: false })
chain.logs = [log(p.orderId, 12_500_000n, 'a'), log(p2.orderId, 12_499_999n, 'b'), log(`0x${'77'.repeat(32)}`, 12_500_000n, 'c')]
const found = await A.findPayments([r1, r2])
ok(found.length === 1 && found[0].id === 'row1' && found[0].payer === PAYER && found[0].orderId === p.orderId, 'Paid for this order and this exact amount matches; a short payment and another order do not', JSON.stringify(found))

/* ---- 4. settleEscrow ---- */
let n = chain.raw.length
const ref = await A.settleEscrow({ orderId: p.orderId, action: 'refund' })
const tx = Transaction.from(chain.raw[n])
ok(chain.raw.length === n + 1 && tx.to === ESCROW && tx.chainId === 5042002n && E.decodeFunctionData('refund', tx.data)[0] === p.orderId && ref.txHash === tx.hash, 'refund(orderId) is signed to the escrow on Arc (chain 5042002)')
ok(Transaction.from(chain.raw[n]).from === op.address, '…by the operator wallet')
n = chain.raw.length
await A.settleEscrow({ orderId: p.orderId, action: 'release' })
ok(E.decodeFunctionData('release', Transaction.from(chain.raw[n]).data)[0] === p.orderId, 'release(orderId) likewise')
n = chain.raw.length
ok(/usdc_order/.test(await throws(() => A.settleEscrow({ orderId: '', action: 'refund' })) || '') && chain.raw.length === n, 'no order id: refused, nothing signed')
ok(await throws(() => A.settleEscrow({ orderId: p.orderId, action: 'drain' })) && chain.raw.length === n, 'only refund or release')
delete process.env.ARC_ESCROW_ADDRESS
ok(/ARC_ESCROW_ADDRESS/.test(await throws(() => A.settleEscrow({ orderId: p.orderId, action: 'refund' })) || '') && chain.raw.length === n, 'no escrow set up: refused')
process.env.ARC_ESCROW_ADDRESS = ESCROW

/* ---- 5. the escrow pay page ---- */
const html = A.payPageHtml({ pending: { data: p }, statusUrl: 'https://app.test/status', state: 'open' })
ok(html.includes(ESCROW) && /Step 1 of 2/.test(html) && /Step 2 of 2/.test(html), 'the page shows the escrow and the two wallet steps')
ok(!/ethereum:0x3600/.test(html), 'no EIP-681 QR in escrow mode (one transfer cannot pay into escrow)')
ok(!html.includes('<b>') && html.includes('&lt;b&gt;'), 'the label is escaped')
ok(!html.includes(op.privateKey.slice(2)), 'no key in the page')
ok(/<a id="mm" class="btn" hidden>Open in MetaMask<\/a>/.test(html) && html.includes("'https://metamask.app.link/dapp/'+location.host+location.pathname"), "opened where there is no wallet (WhatsApp's browser), the page offers Open in MetaMask for this same page")
ok(html.includes('<footer>Paid in USDC on Arc</footer>') && !/Automate/.test(html), "no platform name on the customer's page (white-label)")

ok(outside.length === 0, 'nothing outside the fake RPC was reached', outside.join(', '))
console.log(`${passed} passed${failed ? `, ${failed} failed` : ''}`)
process.exit(failed ? 1 : 0)
