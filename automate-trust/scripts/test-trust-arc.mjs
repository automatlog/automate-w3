/**
 * Arc USDC for the trust steps (6 Nov 2026, ETHGlobal) - server/lib/trust/arc.mjs.
 *
 *   1. Unit math: exact strings, no floats, bad input refused.
 *   2. newPayment: unique amounts for the same price, validation, open set on disk.
 *   3. findPayments: exact amount only, wrong recipient ignored, a tx never matched
 *      twice, 9,000-block windows, the open amount freed.
 *   4. sendUsdc: bad address, over the limit (names the limit and env var), no key;
 *      success signs transfer(to, units) to the USDC contract on chain 5042002.
 *   5. The pay page escapes a hostile label; the key never appears anywhere.
 *   6. No host other than the fake RPC was reached.
 *
 * Testnet only, no real network: globalThis.fetch is a fake JSON-RPC node.
 *
 *   node scripts/test-trust-arc.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Wallet, Transaction, Interface } from 'ethers'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-arc-'))
process.chdir(tmp)

let passed = 0, failed = 0
const ok = (cond, msg) => {
  if (cond) { passed++; return }
  failed++
  console.error(`FAIL: ${msg}`)
}
const throws = async (fn) => { try { await fn(); return null } catch (e) { return String(e.message) } }

const wallet = Wallet.createRandom()
const KEY = wallet.privateKey
const OTHER = Wallet.createRandom().address
const RPC = 'https://rpc.test.invalid/'
process.env.ARC_RPC_URL = RPC
process.env.ARC_PRIVATE_KEY = KEY
delete process.env.ARC_MERCHANT_ADDRESS
delete process.env.ARC_MAX_SEND_USDC

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const USDC = '0x3600000000000000000000000000000000000000'
const pad = (a) => `0x${a.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`
const hex = (n) => `0x${BigInt(n).toString(16)}`

/* The fake node. */
const hosts = new Set()
const calls = []
const node = { block: 100_000, logs: [], rawTxs: [], receipt: true }
globalThis.fetch = async (url, init) => {
  hosts.add(new URL(url).host)
  const { method, params, id } = JSON.parse(init.body)
  calls.push({ method, params })
  const reply = (result) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { status: 200 })
  switch (method) {
    case 'eth_blockNumber': return reply(hex(node.block))
    case 'eth_chainId': return reply(hex(5042002))
    case 'eth_getLogs': {
      const f = params[0]
      const lo = Number(BigInt(f.fromBlock)), hi = Number(BigInt(f.toBlock))
      const want = f.topics[2]
      const wantList = Array.isArray(want) ? want : [want]
      return reply(node.logs.filter((l) => {
        const b = Number(BigInt(l.blockNumber))
        return b >= lo && b <= hi && wantList.includes(l.topics[2])
      }))
    }
    case 'eth_getTransactionCount': return reply('0x7')
    case 'eth_gasPrice': return reply(hex(1_000_000_000n))
    case 'eth_estimateGas': return reply(hex(60_000))
    case 'eth_sendRawTransaction': {
      node.rawTxs.push(params[0])
      return reply(Transaction.from(params[0]).hash)
    }
    case 'eth_getTransactionReceipt': return reply(node.receipt ? { status: '0x1', blockNumber: hex(node.block) } : null)
    default: return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: `fake node: no ${method}` } }), { status: 200 })
  }
}

const arc = await import(pathToFileURL(path.join(ROOT, 'server', 'lib', 'trust', 'arc.mjs')).href)
const merchant = wallet.address

/* ---- 1. unit math ---- */
console.log('1. unit math')
ok(arc.toUnits('12.34') === '12340000', 'toUnits 12.34')
ok(arc.toUnits('0.000001') === '1', 'toUnits one micro')
ok(arc.toUnits('0') === '0', 'toUnits zero')
ok(arc.toUnits('10000') === '10000000000', 'toUnits whole')
ok(arc.toUnits('123456789.123456') === '123456789123456', 'toUnits large exact (no float loss)')
ok(arc.fromUnits('12340000') === '12.34', 'fromUnits 12.34')
ok(arc.fromUnits('12340731') === '12.340731', 'fromUnits keeps micro digits')
ok(arc.fromUnits('5000000') === '5.00', 'fromUnits keeps two decimals')
ok(arc.fromUnits('1') === '0.000001', 'fromUnits one micro')
ok(arc.fromUnits('0') === '0.00', 'fromUnits zero')
for (const bad of ['', '1.', '.5', '-1', '1e3', '1,5', '0.0000001', 'abc', null]) {
  ok(await throws(() => arc.toUnits(bad)), `toUnits refuses ${JSON.stringify(bad)}`)
}
ok(arc.fromUnits(arc.toUnits('99.999999')) === '99.999999', 'round trip')

/* ---- 2. config + newPayment ---- */
console.log('2. config and newPayment')
const cfg = arc.arcConfig()
ok(cfg.ready && cfg.merchant === merchant && cfg.chainId === 5042002 && cfg.usdc === USDC, 'config from key')
ok(!JSON.stringify(cfg).includes(KEY.slice(2)), 'config has no key')
process.env.ARC_MERCHANT_ADDRESS = OTHER
ok(arc.arcConfig().merchant === OTHER, 'ARC_MERCHANT_ADDRESS wins')
delete process.env.ARC_MERCHANT_ADDRESS
const savedKey = process.env.ARC_PRIVATE_KEY
delete process.env.ARC_PRIVATE_KEY
const noKey = arc.arcConfig()
ok(!noKey.ready && noKey.missing.length === 1, 'not ready without key or merchant')
process.env.ARC_PRIVATE_KEY = savedKey

const pays = []
for (let i = 0; i < 40; i++) pays.push(await arc.newPayment({ amount: '12.34', label: 'Pizza' }))
const set = new Set(pays.map((p) => p.amountUnits))
ok(set.size === 40, '40 requests for the same price are all different')
ok(pays.every((p) => BigInt(p.amountUnits) > 12340000n && BigInt(p.amountUnits) <= 12349999n), 'tag is 1..9999 micro-USDC')
ok(pays[0].amountText === `${arc.fromUnits(pays[0].amountUnits)} USDC` && pays[0].merchant === merchant && pays[0].usdc === USDC, 'amountText, merchant, usdc')
ok(pays[0].fromBlock === 100_000 - 20, 'fromBlock is block minus margin')
const openOnDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'arc-open.json'), 'utf8'))
ok(Object.keys(openOnDisk).length === 40, 'open amounts persisted')
for (const bad of ['0', '0.00', '-1', '10000.01', '1.234', 'abc', '']) {
  ok(await throws(() => arc.newPayment({ amount: bad, label: 'x' })), `newPayment refuses ${JSON.stringify(bad)}`)
}
ok(!(await throws(() => arc.newPayment({ amount: '10000', label: 'max' }))), 'newPayment accepts 10000')

/* ---- 3. findPayments ---- */
console.log('3. findPayments')
const mk = (id, p) => ({ id, kind: 'pay', status: 'pending', createdAt: 0, expiresAt: Date.now() + 1e6, data: { label: 'x', amount: '12.34', ...p } })
const P1 = pays[0], P2 = pays[1]
const log = (tx, to, units, block, from = OTHER) => ({
  address: USDC, topics: [TRANSFER_TOPIC, pad(from), pad(to)], data: hex(BigInt(units)), blockNumber: hex(block),
  transactionHash: `0x${tx.repeat(64).slice(0, 64)}`, removed: false,
})
node.logs = [
  log('a', merchant, P1.amountUnits, 99_990),                         // exact
  log('b', merchant, String(BigInt(P2.amountUnits) + 1n), 99_995),    // wrong amount
  log('c', OTHER, P2.amountUnits, 99_996),                            // wrong recipient
]
calls.length = 0
const pend = [mk('id1', P1), mk('id2', P2), { ...mk('id3', P2), status: 'paid' }, { ...mk('id4', P2), kind: 'verify' }]
let got = await arc.findPayments(pend)
ok(got.length === 1 && got[0].id === 'id1', 'only the exact amount to the merchant matched')
ok(got[0].txHash === `0x${'a'.repeat(64)}` && got[0].payer.toLowerCase() === OTHER.toLowerCase() && got[0].blockNumber === 99_990, 'hash, payer, block')
const logCall = calls.find((c) => c.method === 'eth_getLogs')
ok(logCall.params[0].topics[0] === TRANSFER_TOPIC && logCall.params[0].topics[2] === pad(merchant), 'getLogs topics: Transfer, any sender, merchant')
ok(logCall.params[0].address.map((a) => a.toLowerCase()).includes(USDC), 'getLogs address includes USDC')
ok(!JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'arc-open.json'), 'utf8'))[P1.amountUnits], 'matched amount freed')
ok(JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'arc-seen.json'), 'utf8')).includes(`0x${'a'.repeat(64)}`), 'tx recorded as seen')

got = await arc.findPayments(pend)
ok(got.length === 0, 'a seen tx is never matched again')
// Same amount, new tx, but another pending with the same units cannot reuse the first tx
node.logs.push(log('d', merchant, P1.amountUnits, 99_999))
got = await arc.findPayments([mk('id1', P1)])
ok(got.length === 1 && got[0].txHash === `0x${'d'.repeat(64)}`, 'a different tx for the same amount can match')
ok((await arc.findPayments([])).length === 0, 'no pendings, no match')
calls.length = 0
await arc.findPayments([{ ...mk('z', P1), status: 'paid' }])
ok(calls.length === 0, 'nothing pending means no RPC call')

// A log from before fromBlock is not ours
node.logs = [log('e', merchant, P2.amountUnits, P2.fromBlock - 5)]
got = await arc.findPayments([mk('id2', P2)])
ok(got.length === 0, 'a transfer before the request began is ignored')

// Chunked windows
node.logs = []
const old = { ...P2, fromBlock: 100_000 - 25_000 }
calls.length = 0
await arc.findPayments([mk('id2', old)])
const wins = calls.filter((c) => c.method === 'eth_getLogs').map((c) => [Number(BigInt(c.params[0].fromBlock)), Number(BigInt(c.params[0].toBlock))])
ok(wins.length === 3, `25,000 blocks scanned in 3 windows (got ${wins.length})`)
ok(wins.every(([a, b]) => b - a + 1 <= 9000), 'every window is at most 9,000 blocks')
ok(wins[0][0] === 75_000 && wins.at(-1)[1] === 100_000 && wins.every((w, i) => i === 0 || w[0] === wins[i - 1][1] + 1), 'windows are contiguous and end at the latest block')
calls.length = 0
node.block = 200_000
await arc.findPayments([mk('id2', { ...P2, fromBlock: 0 })])
node.block = 100_000
ok(calls.filter((c) => c.method === 'eth_getLogs').length === 12, 'window count is capped per call')

/* ---- 4. sendUsdc ---- */
console.log('4. sendUsdc')
let e = await throws(() => arc.sendUsdc({ to: 'nope', amount: '1' }))
ok(e && /address/i.test(e), 'bad address refused')
e = await throws(() => arc.sendUsdc({ to: OTHER, amount: '100.01' }))
ok(e && e.includes('100') && e.includes('ARC_MAX_SEND_USDC'), 'over-limit error names the limit and env var')
process.env.ARC_MAX_SEND_USDC = '5'
e = await throws(() => arc.sendUsdc({ to: OTHER, amount: '5.5' }))
ok(e && e.includes('5 USDC') && e.includes('ARC_MAX_SEND_USDC'), 'raised/lowered limit is reported')
delete process.env.ARC_MAX_SEND_USDC
for (const bad of ['0', '-1', 'x']) ok(await throws(() => arc.sendUsdc({ to: OTHER, amount: bad })), `amount ${bad} refused`)
process.env.ARC_PRIVATE_KEY = ''
e = await throws(() => arc.sendUsdc({ to: OTHER, amount: '1' }))
ok(e && e.includes('ARC_PRIVATE_KEY'), 'missing key is a plain error')
process.env.ARC_PRIVATE_KEY = KEY
ok(node.rawTxs.length === 0, 'nothing was signed by the refused calls')

const res = await arc.sendUsdc({ to: OTHER, amount: '2.5', memo: 'thanks' })
ok(node.rawTxs.length === 1, 'one raw tx sent')
const tx = Transaction.from(node.rawTxs[0])
ok(tx.chainId === 5042002n, 'chain id 5042002')
ok(tx.to.toLowerCase() === USDC, 'sent to the USDC contract')
ok(tx.value === 0n, 'no native value')
ok(tx.from.toLowerCase() === merchant.toLowerCase(), 'signed by the server wallet')
const dec = new Interface(['function transfer(address to, uint256 amount)']).parseTransaction({ data: tx.data })
ok(dec.name === 'transfer' && dec.args[0].toLowerCase() === OTHER.toLowerCase() && dec.args[1] === 2_500_000n, 'calls transfer(to, 2500000)')
ok(res.txHash === tx.hash && res.explorerUrl === `https://explorer.testnet.arc.io/tx/${tx.hash}`, 'hash and explorer URL')
ok(arc.explorerTx('0xabc') === 'https://explorer.testnet.arc.io/tx/0xabc', 'explorerTx')

/* ---- 5. page + secrets ---- */
console.log('5. page and secrets')
const evil = { id: 'x', kind: 'pay', status: 'pending', data: { ...pays[2], label: '<script>alert(1)</script>"\'&' } }
const html = arc.payPageHtml({ pending: evil, statusUrl: '/p/x/status', state: 'open' })
ok(!html.includes('<script>alert(1)</script>'), 'label script tag is escaped')
ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'label shown escaped')
ok(html.includes(pays[2].amountText) && html.includes(merchant), 'amount and merchant on the page')
ok(html.includes('wallet_addEthereumChain') && html.includes('wallet_switchEthereumChain') && html.includes('0xa9059cbb') && html.includes('4902'), 'wallet flow present')
ok(html.includes(`ethereum:${USDC}@5042002/transfer?address=${merchant}&amp;uint256=${pays[2].amountUnits}`), 'EIP-681 link present')
ok(html.includes('qrcode-generator@1.4.4') && html.includes('faucet.circle.com') && html.includes('Paid in USDC on Arc'), 'qr, faucet, footer')
ok(!/#fff\b|#ffffff/i.test(html), 'no pure white')
const paid = arc.payPageHtml({ pending: evil, statusUrl: '/s', state: 'paid', txHash: '0x' + 'a'.repeat(64) })
ok(paid.includes('https://explorer.testnet.arc.io/tx/0x' + 'a'.repeat(64)) && !paid.includes('<script type'), 'paid screen links the explorer, no script')
const exp = arc.payPageHtml({ pending: evil, statusUrl: '/s', state: 'expired' })
ok(/expired/i.test(exp), 'expired screen')
const errPage = arc.payPageHtml({ pending: evil, statusUrl: '/s', state: 'error', message: '<b>bad</b>' })
ok(errPage.includes('&lt;b&gt;bad&lt;/b&gt;'), 'error message escaped')
const everything = JSON.stringify([html, paid, exp, errPage, cfg, res, pays, got, calls.map((c) => c.method)])
ok(!everything.includes(KEY.slice(2)) && !everything.toLowerCase().includes(KEY.slice(2).toLowerCase()), 'private key appears in no output')
const files = fs.readdirSync(path.join(tmp, 'data')).map((f) => fs.readFileSync(path.join(tmp, 'data', f), 'utf8')).join('')
ok(!files.includes(KEY.slice(2)), 'private key is in no saved file')

/* ---- 6. network ---- */
console.log('6. network')
ok([...hosts].length === 1 && [...hosts][0] === new URL(RPC).host, `only the fake RPC was reached (${[...hosts].join(', ')})`)

console.log(`${passed} passed${failed ? `, ${failed} failed` : ''}`)
process.exit(failed ? 1 : 0)
