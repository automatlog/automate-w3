/**
 * The trust steps in a real flow walk (6 Nov 2026, ETHGlobal Mumbai):
 *
 *   1. Collect USDC sends a pay link and stops; a matching USDC transfer on Arc
 *      resolves it; the run comes back and takes "paid" with {{usdc_tx}} and
 *      {{usdc_payer}}.
 *   2. Verify human: link → "verified" → on to the approval.
 *   3. Human approval: link to the approver → "approved" → Send USDC really
 *      signs a transfer(payer, amount) on Arc → the "sent" wire.
 *   4. One approval, one payment: a second Send USDC with no new approval is
 *      refused and leaves by "failed" — nothing is signed.
 *   5. "denied" and "expired" take their own wires, and a half-wired approval
 *      (no "denied" wire) STOPS rather than falling through to "approved".
 *   6. A builder test run sends no link and waits for nothing.
 *   7. The link pages: deny from a bare link works; approve cannot be faked from
 *      the browser; a bad token is a 404; the pay status route; a page shows an
 *      expired link as expired even before the sweep reaches it.
 *   8. Proof on 0G: the record has no phone number or message text, is
 *      canonical (same run → same digest), seals through the SDK, and Verify
 *      catches a changed upload and a changed run.
 *   9. The flow checks: Send USDC not on an approval's "approved" wire, an
 *      approval with no "denied" wire.
 *
 * Nothing real is reached: Arc's RPC, World and 0G are faked. Temp folder.
 *
 *   node scripts/test-trust-flow.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Wallet, Transaction, Interface } from 'ethers'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-flow-'))
fs.mkdirSync(path.join(tmp, 'data', 'automation'), { recursive: true })
process.chdir(tmp)
for (const k of Object.keys(process.env)) if (/SUPABASE|_API_KEY|API_KEYS|SMTP_|RESEND|GEMINI|GROQ|GOOGLE|OPENAI|NVIDIA|META_|^WORLD_|^ARC_|^ZG_/i.test(k)) delete process.env[k]
process.env.SUPABASE_URL = 'https://db.test'
process.env.SUPABASE_ANON_KEY = 'anon-test'
process.env.TRUST_BASE_URL = 'https://app.test'
const wallet = Wallet.createRandom()
process.env.ARC_RPC_URL = 'https://rpc.arc.test/'
process.env.ARC_PRIVATE_KEY = wallet.privateKey
const merchant = wallet.address
const PAYER = Wallet.createRandom().address

let pass = 0, total = 0
const check = (name, ok, extra = '') => { total++; if (ok) pass++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      ${String(extra).slice(0, 400)}`}`) }

/* ── the fake world: Arc's RPC, the database host ─────────────────────────── */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const USDC = '0x3600000000000000000000000000000000000000'
const pad = (a) => `0x${a.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`
const hex = (n) => `0x${BigInt(n).toString(16)}`
const chain = { block: 500_000, logs: [], raw: [] }
const outside = []
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url))
  if (u.hostname === 'rpc.arc.test') {
    const { method, params, id } = JSON.parse(init.body)
    const reply = (result) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { status: 200 })
    switch (method) {
      case 'eth_blockNumber': return reply(hex(chain.block))
      case 'eth_chainId': return reply(hex(5042002))
      case 'eth_getLogs': {
        const f = params[0], lo = Number(BigInt(f.fromBlock)), hi = Number(BigInt(f.toBlock))
        const want = [].concat(f.topics[2])
        return reply(chain.logs.filter((l) => { const b = Number(BigInt(l.blockNumber)); return b >= lo && b <= hi && want.includes(l.topics[2]) }))
      }
      case 'eth_getTransactionCount': return reply('0x1')
      case 'eth_gasPrice': return reply(hex(1_000_000_000n))
      case 'eth_estimateGas': return reply(hex(60_000))
      case 'eth_sendRawTransaction': chain.raw.push(params[0]); return reply(Transaction.from(params[0]).hash)
      case 'eth_getTransactionReceipt': return reply({ status: '0x1', blockNumber: hex(chain.block) })
      default: return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: `no ${method}` } }), { status: 200 })
    }
  }
  if (u.hostname === 'db.test') return new Response(JSON.stringify(u.pathname.startsWith('/rest/v1/') && (init.method || 'GET') === 'GET' ? [] : { ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  outside.push(u.hostname)
  throw new Error(`network call outside the test: ${url}`)
}
const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href)
const warn = console.warn
console.warn = (...a) => { if (!/^\[(ai|trust)\]/.test(String(a[0]))) warn(...a) }

const { createRuntime, runWithGraph } = await imp('server/lib/graph-runtime.mjs')
const P = await imp('server/lib/trust/pending.mjs')
const arc = await imp('server/lib/trust/arc.mjs')

const sent = [], events = []
const rt = createRuntime({
  send: async (_p, to, payload) => { sent.push({ to, payload }); return { ok: true, simulated: true } },
  push: (type, msg, detail) => events.push({ type, msg, detail }),
  translateEnabled: false, isAllowed: () => true, isAdmin: () => false,
})
const text = (m) => m?.text?.body || m?.interactive?.body?.text || ''
const link = (m) => m?.interactive?.action?.parameters?.url || (text(m).match(/https:\/\/\S+/) || [''])[0]

const CHANNEL = { id: 'channel', type: 'channel', position: { x: -200, y: 0 }, data: { name: 'Shop', source: 'whatsapp', valid: true } }
const N = (id, type, data, x = 0) => ({ id, type, position: { x, y: 0 }, data })
const E = (source, sourceHandle, target) => ({ id: `${source}-${sourceHandle}-${target}`, source, sourceHandle, target, targetHandle: 'in' })
const graph = {
  nodes: [
    CHANNEL,
    N('trigger', 'trigger', { title: 'Start', keywords: 'order' }),
    N('pay', 'usdc_collect', { title: 'Pay', amount: '12.50', label: 'Order 7', minutes: 30 }),
    N('paid', 'msg', { msgType: 'text', body: 'Paid! tx {{usdc_tx}} from {{usdc_payer}}' }),
    N('payexp', 'msg', { msgType: 'text', body: 'Your payment link expired.' }),
    N('human', 'world_human', { title: 'Human', action: 'refund' }),
    N('approve', 'world_approval', { title: 'Approve', summary: 'Refund 12.50 USDC to Asha', approver: '9876543210', minutes: 30 }),
    N('refund', 'usdc_send', { title: 'Refund', to: '{{usdc_payer}}', amount: '12.50' }),
    N('done', 'msg', { msgType: 'text', body: 'Refunded: {{usdc_sent_tx}}' }),
    N('again', 'usdc_send', { title: 'Second refund', to: '{{usdc_payer}}', amount: '12.50' }),
    N('refused', 'msg', { msgType: 'text', body: 'Second refund refused.' }),
    N('nope', 'msg', { msgType: 'text', body: 'Your refund was not approved.' }),
    N('late', 'msg', { msgType: 'text', body: 'The approval timed out.' }),
    N('proof', 'proof0g', { title: 'Proof' }),
  ],
  edges: [
    { id: 'e0', source: 'channel', sourceHandle: 'out', target: 'trigger', targetHandle: 'src' },
    E('trigger', 'out', 'pay'), E('pay', 'paid', 'paid'), E('pay', 'expired', 'payexp'), E('paid', 'out', 'human'),
    E('human', 'verified', 'approve'), E('approve', 'approved', 'refund'), E('approve', 'denied', 'nope'), E('approve', 'expired', 'late'),
    E('refund', 'out', 'done'), E('done', 'out', 'again'), E('again', 'err', 'refused'), E('refused', 'out', 'proof'),
  ],
}
const person = () => {
  const from = `9197${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 90 + 10)}`
  const run = async (evt, g = graph) => {
    const a = sent.length
    await runWithGraph({ ...g, workspaceId: 'ws-test' }, null, () => rt.handleMessage({ from, phoneId: 'PH-SHOP', wabaId: 'w', profileName: 'Asha', channelSlug: 'shop', text: '', ...evt }), `trust_${from}`)
    return sent.slice(a)
  }
  return { from, say: (t, g) => run({ text: t }, g), resume: (nodeId, g) => run({ resumeAt: nodeId }, g) }
}

/* ── 1. Collect USDC ─────────────────────────────────────────────────────── */
const a = person()
let out = await a.say('order')
const payLink = link(out[0]?.payload)
const payRow = P.openAt({ slug: 'shop', from: a.from, nodeId: 'pay' })
check('Collect USDC sends a CTA link to the pay page and stops', /^https:\/\/app\.test\/webhook\/trust\/pay\/[0-9a-f]{24}$/.test(payLink) && out.length === 1, JSON.stringify(out))
check('the row holds a unique amount just above 12.50 and the merchant', payRow?.status === 'pending' && BigInt(payRow.data.amountUnits) > 12_500_000n && BigInt(payRow.data.amountUnits) < 12_510_000n && payRow.data.merchant.toLowerCase() === merchant.toLowerCase(), JSON.stringify(payRow?.data))
const txPay = `0x${'ab'.repeat(32)}`
chain.logs.push({ address: USDC, topics: [TRANSFER_TOPIC, pad(PAYER), pad(merchant)], data: pad(hex(BigInt(payRow.data.amountUnits))), blockNumber: hex(chain.block), transactionHash: txPay, removed: false })
chain.block += 2
const hits = await arc.findPayments(P.listPending('pay'))
check('the watcher finds the transfer of that exact amount', hits.length === 1 && hits[0].id === payRow.id && hits[0].txHash === txPay, JSON.stringify(hits))
await P.resolvePending(payRow.id, 'paid', { usdc_tx: hits[0].txHash, usdc_payer: hits[0].payer, usdc_amount: payRow.data.amountText })
out = await a.resume('pay')
check('the run comes back at the step and takes "paid" with {{usdc_tx}} and {{usdc_payer}}', text(out[0]?.payload) === `Paid! tx ${txPay} from ${hits[0].payer}`, JSON.stringify(out.map((x) => text(x.payload))))
const trustPay = events.find((e) => e.type === 'trust' && e.detail?.step === 'usdc_collect')
check('it logs a trust outcome with the tx and no phone number', trustPay?.detail?.outcome === 'paid' && trustPay.detail.tx === txPay && !JSON.stringify(trustPay.detail).includes(a.from), JSON.stringify(trustPay))

/* ── 2. Verify human ─────────────────────────────────────────────────────── */
const humanLink = link(out[1]?.payload)
check('then Verify human sends its World ID link', /\/webhook\/trust\/human\/[0-9a-f]{24}$/.test(humanLink), JSON.stringify(out.map((x) => x.payload)))
const humanRow = P.openAt({ slug: 'shop', from: a.from, nodeId: 'human' })
await P.resolvePending(humanRow.id, 'verified', { human_id: 'h1' })
out = await a.resume('human')

/* ── 3. Human approval → Send USDC ───────────────────────────────────────── */
const toApprover = out.find((x) => x.to === '919876543210')
check('"verified" leads to the approval, whose link goes to the approver\'s number (+91)', toApprover && /\/webhook\/trust\/approve\/[0-9a-f]{24}/.test(text(toApprover.payload)) && /Refund 12\.50 USDC to Asha/.test(text(toApprover.payload)), JSON.stringify(out))
check('nothing is sent to the customer while the approval waits', !out.some((x) => x.to === a.from))
const apRow = P.openAt({ slug: 'shop', from: a.from, nodeId: 'approve' })
await P.resolvePending(apRow.id, 'approved', { approval_by: 'sub-hash-1', approval_acr: 'https://world.org/oidc/acr/orb' })
const rawBefore = chain.raw.length
out = await a.resume('approve')
const raw = chain.raw.slice(rawBefore)
const tx = raw[0] ? Transaction.from(raw[0]) : null
const call = tx ? new Interface(['function transfer(address,uint256)']).parseTransaction({ data: tx.data }) : null
check('"approved" → Send USDC signs ONE transfer(payer, 12.50 USDC) on Arc chain 5042002', raw.length === 1 && tx.to.toLowerCase() === USDC && tx.chainId === 5042002n && call?.args[0].toLowerCase() === hits[0].payer.toLowerCase() && call?.args[1] === 12_500_000n, JSON.stringify({ n: raw.length, to: tx?.to, args: call?.args?.map(String) }))
check('the customer is told, with {{usdc_sent_tx}}', out.some((x) => x.to === a.from && text(x.payload) === `Refunded: ${tx?.hash}`), JSON.stringify(out.map((x) => text(x.payload))))

/* ── 4. One approval, one payment ────────────────────────────────────────── */
check('the second Send USDC, with no new approval, signs nothing and takes "failed"', out.some((x) => text(x.payload) === 'Second refund refused.') && chain.raw.length === rawBefore + 1, JSON.stringify(out.map((x) => text(x.payload))))
check('…and the refusal is a trust outcome too', events.some((e) => e.type === 'trust' && e.detail?.step === 'usdc_send' && e.detail.outcome === 'refused'))

/* ── 5. denied / expired / half-wired ────────────────────────────────────── */
const b = person()
const approvalOnly = { nodes: [CHANNEL, N('trigger', 'trigger', { keywords: 'refund' }), N('approve', 'world_approval', { summary: 'Refund', minutes: 30 }), N('refund', 'usdc_send', { to: PAYER, amount: '1' }), N('nope', 'msg', { msgType: 'text', body: 'Not approved.' }), N('late', 'msg', { msgType: 'text', body: 'Timed out.' })],
  edges: [{ id: 'e0', source: 'channel', sourceHandle: 'out', target: 'trigger', targetHandle: 'src' }, E('trigger', 'out', 'approve'), E('approve', 'approved', 'refund'), E('approve', 'denied', 'nope'), E('approve', 'expired', 'late')] }
await b.say('refund', approvalOnly)
await P.resolvePending(P.openAt({ slug: 'shop', from: b.from, nodeId: 'approve' }).id, 'denied')
let n0 = chain.raw.length
out = await b.resume('approve', approvalOnly)
check('"denied" takes its own wire and no USDC moves', out.some((x) => text(x.payload) === 'Not approved.') && chain.raw.length === n0, JSON.stringify(out.map((x) => text(x.payload))))
await b.say('refund', approvalOnly)
const row2 = P.openAt({ slug: 'shop', from: b.from, nodeId: 'approve' })
check('passing the step again opens a NEW approval (the old one was used)', row2 && row2.status === 'pending')
row2.expiresAt = Date.now() - 1
const swept = await P.sweepExpired()
out = await b.resume('approve', approvalOnly)
check('an expired link is swept to "expired", which takes its own wire', swept.some((r) => r.id === row2.id) && out.some((x) => text(x.payload) === 'Timed out.') && chain.raw.length === n0)
const halfWired = { ...approvalOnly, edges: approvalOnly.edges.filter((e) => e.sourceHandle !== 'denied') }
const c = person()
await c.say('refund', halfWired)
await P.resolvePending(P.openAt({ slug: 'shop', from: c.from, nodeId: 'approve' }).id, 'denied')
n0 = chain.raw.length
out = await c.resume('approve', halfWired)
check('with no "denied" wire, a denial STOPS — it never falls through to "approved"', chain.raw.length === n0 && out.length === 0 && events.some((e) => /ended "denied" but that wire is not connected/.test(e.msg)))
check('a resolved row cannot be resolved again (first outcome wins)', (await P.resolvePending(row2.id, 'approved')) === null)

/* ── 6. builder test run ─────────────────────────────────────────────────── */
const before = sent.length
await runWithGraph({ ...graph, workspaceId: 'ws-test' }, null, () => rt.handleMessage({ from: '919000000001', phoneId: 'PROBE', wabaId: 'p', text: 'order', profileName: 'T' }), 'trust_probe')
check('a builder test sends no pay link and opens no row', sent.length === before && !P.openAt({ slug: 'shop', from: '919000000001', nodeId: 'pay' }) && events.some((e) => /TEST — "Pay" sends a link and waits/.test(e.msg)))

/* ── 7. the link pages ───────────────────────────────────────────────────── */
const { handleTrustRoute } = await imp('server/lib/trust/routes.mjs')
const hit = async (method, p, body = '') => {
  const res = { code: 0, headers: {}, body: '', writeHead(c, h) { this.code = c; this.headers = h || {} }, end(b) { this.body = String(b ?? '') } }
  const handled = await handleTrustRoute({ req: { method }, res, url: new URL(`https://app.test${p}`), readBody: async () => body, push: () => {} })
  return { handled, ...res }
}
const d = person()
await d.say('refund', approvalOnly)
const dRow = P.openAt({ slug: 'shop', from: d.from, nodeId: 'approve' })
let r = await hit('GET', `/webhook/trust/approve/${dRow.id}`)
check('the approval page opens, no-store, with no Referer', r.handled && r.code === 200 && /Refund/.test(r.body) && r.headers['Cache-Control'] === 'no-store' && r.headers['Referrer-Policy'] === 'no-referrer')
r = await hit('GET', `/webhook/trust/approve/callback?state=${dRow.id}.${'0'.repeat(32)}&code=forged`)
check('a forged callback (state it never issued) does not approve', P.getPending(dRow.id).status === 'pending', r.body.slice(0, 200))
r = await hit('GET', `/webhook/trust/approve/${dRow.id}/deny`)
check('deny must be a POST', r.code === 405 && P.getPending(dRow.id).status === 'pending')
r = await hit('POST', `/webhook/trust/approve/${dRow.id}/deny`)
check('deny from the link resolves it "denied"', r.code === 200 && P.getPending(dRow.id).status === 'denied')
r = await hit('GET', '/webhook/trust/approve/0123456789abcdef01234567')
check('an unknown token is a 404', r.code === 404)
r = await hit('GET', '/webhook/trust/approve/../../etc')
check('anything that is not a token is not handled', r.handled === false)
r = await hit('GET', `/webhook/trust/pay/${payRow.id}/status`)
check('the pay status route says paid, with the explorer link', JSON.parse(r.body).status === 'paid' && JSON.parse(r.body).txHash === txPay && /explorer\.testnet\.arc\.io/.test(JSON.parse(r.body).explorerUrl || ''), r.body)
const e = person()
await e.say('refund', approvalOnly)
const eRow = P.openAt({ slug: 'shop', from: e.from, nodeId: 'approve' })
eRow.expiresAt = Date.now() - 1
r = await hit('POST', `/webhook/trust/approve/${eRow.id}/deny`)
check('a link past its time is expired on the page even before the sweep', P.getPending(eRow.id).status === 'expired')
r = await hit('POST', `/webhook/trust/human/${humanRow.id}/verify`, JSON.stringify({ forged: true }))
check('a proof posted to an already-used Verify human link is refused', r.code === 409 && P.getPending(humanRow.id).status === 'verified')

/* ── 8. proof on 0G ──────────────────────────────────────────────────────── */
const Z = await imp('server/lib/trust/zg.mjs')
const exec = {
  id: 'run_0123456789ab', at: '2026-11-06T10:00:00.000Z', from: a.from, text: 'order — my number is 9876543210', channel: 'whatsapp', workspaceId: 'ws-test', flowId: 'f1', trigger: 'resume', status: 'completed', ms: 900, errors: 0,
  path: [{ id: 'approve', type: 'world_approval', title: 'Approve', t: 0 }, { id: 'refund', type: 'usdc_send', title: 'Refund', t: 40 }, { id: 'proof', type: 'proof0g', title: 'Proof', t: 90 }],
  steps: [{ type: 'flow', msg: `sent to ${a.from}: hello Asha` }, ...events.filter((x) => x.type === 'trust').slice(0, 4).map((x) => ({ type: 'trust', msg: x.msg, detail: { ...x.detail, phone: a.from } }))],
}
const rec = JSON.stringify(Z.proofRecord(exec))
check('the 0G record carries no phone number, message text or log lines', !rec.includes(a.from) && !rec.includes('9876543210') && !rec.includes('hello Asha') && !rec.includes('my number'), rec.slice(0, 300))
check('it keeps the path and the trust outcomes (tx hashes included)', /"usdc_send"/.test(rec) && rec.includes(txPay))
check('canonical: the same run always gives the same bytes', Z.canonical(Z.proofRecord(exec)) === Z.canonical(Z.proofRecord(structuredClone(exec))))
check('not set up → "skipped", never thrown', (await Z.sealRun(exec)).status === 'skipped')
process.env.ZG_PRIVATE_KEY = Wallet.createRandom().privateKey
const store = new Map()
class MemData { constructor(b) { this.b = b } async merkleTree() { return [{ rootHash: () => `0x${Buffer.from(this.b).length.toString(16).padStart(64, '0')}` }, null] } }
class Indexer { async upload(m) { const root = `0x${'5e'.repeat(32)}`; store.set(root, Buffer.from(m.b)); return [{ rootHash: root, txHash: `0x${'7a'.repeat(32)}` }, null] } async downloadToBlob(root) { return [new Blob([store.get(root) || '']), null] } }
class FakeWallet { constructor() {} }
const fakeEthers = { JsonRpcProvider: class {}, Wallet: FakeWallet }
const proof = await Z.sealRun(exec, { sdk: { Indexer, MemData }, ethers: fakeEthers })
check('sealing returns the root, tx, digest and explorer link', proof.status === 'sealed' && proof.root === `0x${'5e'.repeat(32)}` && /chainscan-galileo\.0g\.ai\/tx\/0x7a/.test(proof.explorer) && /^[0-9a-f]{64}$/.test(proof.digest), JSON.stringify(proof))
exec.proof = proof
let v = await Z.verifyRun(exec, { sdk: { Indexer } })
check('Verify downloads the record and all three hashes match', v.ok && v.checks.downloaded === proof.digest && v.checks.rebuilt === proof.digest, JSON.stringify(v))
store.set(proof.root, Buffer.from(store.get(proof.root).toString().replace('completed', 'failed')))
v = await Z.verifyRun(exec, { sdk: { Indexer } })
check('a changed upload is caught', !v.ok && /differs/.test(v.reason))
store.set(proof.root, Buffer.from(Z.canonical(Z.proofRecord(exec))))
exec.status = 'failed'
v = await Z.verifyRun(exec, { sdk: { Indexer } })
check('a run changed after sealing is caught', !v.ok && /changed since/.test(v.reason))

/* ── 9. the flow checks ──────────────────────────────────────────────────── */
const { lintGraph } = await imp('shared/graph-lint.js')
const lone = { nodes: [CHANNEL, N('trigger', 'trigger', { keywords: 'x' }), N('send', 'usdc_send', { to: PAYER, amount: '1' })], edges: [{ id: 'e0', source: 'channel', sourceHandle: 'out', target: 'trigger', targetHandle: 'src' }, E('trigger', 'out', 'send')] }
check('Send USDC not on an approval\'s "approved" wire is flagged', lintGraph(lone).some((i) => i.nodeId === 'send' && /approved/.test(i.message || i.msg || JSON.stringify(i))), JSON.stringify(lintGraph(lone)))
check('an approval with no "denied" wire is flagged', lintGraph(halfWired).some((i) => i.nodeId === 'approve' && /denied/.test(JSON.stringify(i))), JSON.stringify(lintGraph(halfWired)))
check('the full demo flow has no trust-step errors', !lintGraph(graph).some((i) => i.level === 'error' && ['pay', 'approve', 'refund', 'again', 'human', 'proof'].includes(i.nodeId)), JSON.stringify(lintGraph(graph).filter((i) => i.level === 'error')))

/* ── 10. the AI step on the 0G Router ───────────────────────────────────── */
const { zgChat, zgRouterConfig } = await imp('server/lib/trust/zg-router.mjs')
check('0G Router not set up → a plain error, so the AI step leaves by "failed"', !zgRouterConfig().ready && await zgChat()({ system: 's', text: 't' }).then(() => false, (e) => /ZG_ROUTER_KEY/.test(e.message)))
process.env.ZG_ROUTER_KEY = 'sk-test-router'
let sentReq = null
const zg = zgChat({ fetchImpl: async (u, init) => { sentReq = { u: String(u), body: JSON.parse(init.body), auth: init.headers.Authorization }; return new Response(JSON.stringify({ id: 'chatcmpl-1', model: 'glm-5.2', choices: [{ message: { content: 'refund' } }], x_0g_trace: { request_id: '0g-req-42', provider: '0xabc' } }), { status: 200 }) } })
const { aiStep } = await imp('server/lib/graph-runtime.mjs')
const ai = await aiStep({ task: 'classify', labels: 'order, refund', input: 'message' }, { vars: {} }, { text: 'I want my money back' }, {}, zg)
check('the AI step runs on the Router (OpenAI-compatible) and keeps x_0g_trace.request_id', ai.ai_answer === 'refund' && zg.last?.requestId === '0g-req-42' && sentReq.u === 'https://router-api.0g.ai/v1/chat/completions' && sentReq.body.model === 'glm-5.2' && sentReq.auth === 'Bearer sk-test-router', JSON.stringify({ ai, last: zg.last }))
const recAi = JSON.stringify(Z.proofRecord({ ...exec, steps: [{ type: 'trust', msg: 'x', detail: { step: 'aistep', outcome: 'answered', provider: '0g-router', model: 'glm-5.2', requestId: '0g-req-42' } }] }))
check('…and the request id goes into the run record on 0G', recAi.includes('0g-req-42') && recAi.includes('0g-router'))

/* ── 11. Send USDC refunds the escrowed order (TrustEscrow) ─────────────── */
process.env.ARC_ESCROW_ADDRESS = '0x00000000000000000000000000000000000e5c40'
const ORDER = `0x${'ab'.repeat(32)}`
const escrowFlow = { nodes: [CHANNEL, N('trigger', 'trigger', { keywords: 'escrow' }), N('approve', 'world_approval', { summary: 'Refund the escrowed order', minutes: 30 }), N('refund', 'usdc_send', { action: 'refund' }), N('done', 'msg', { msgType: 'text', body: 'Refunded from escrow: {{usdc_sent_tx}}' }), N('nope', 'msg', { msgType: 'text', body: 'No.' }), N('late', 'msg', { msgType: 'text', body: 'Late.' })],
  edges: [{ id: 'e0', source: 'channel', sourceHandle: 'out', target: 'trigger', targetHandle: 'src' }, E('trigger', 'out', 'approve'), E('approve', 'approved', 'refund'), E('approve', 'denied', 'nope'), E('approve', 'expired', 'late'), E('refund', 'out', 'done')] }
const g = person()
await g.say('escrow', escrowFlow)
await P.resolvePending(P.openAt({ slug: 'shop', from: g.from, nodeId: 'approve' }).id, 'approved', { usdc_order: ORDER, usdc_amount: '12.50 USDC' })
n0 = chain.raw.length
out = await g.resume('approve', escrowFlow)
const etx = chain.raw[n0] ? Transaction.from(chain.raw[n0]) : null
const ecall = etx ? new Interface(['function refund(bytes32 orderId)']).parseTransaction({ data: etx.data }) : null
check('"approved" → Send USDC (refund) signs refund(orderId) to the escrow, not a plain transfer', chain.raw.length === n0 + 1 && etx.to.toLowerCase() === process.env.ARC_ESCROW_ADDRESS && ecall?.name === 'refund' && ecall.args[0] === ORDER, JSON.stringify({ n: chain.raw.length - n0, to: etx?.to, fn: ecall?.name }))
check('…and the customer is told with the tx', out.some((x) => text(x.payload) === `Refunded from escrow: ${etx?.hash}`), JSON.stringify(out.map((x) => text(x.payload))))
check('…and the trust record says "refunded" with the tx', events.some((e) => e.type === 'trust' && e.detail?.step === 'usdc_send' && e.detail.outcome === 'refunded' && e.detail.tx === etx?.hash))
const lintEscrow = lintGraph(escrowFlow)
check('a refund/release Send USDC needs no amount in the flow checks', !lintEscrow.some((i) => i.nodeId === 'refund' && i.level === 'error'), JSON.stringify(lintEscrow.filter((i) => i.nodeId === 'refund')))
delete process.env.ARC_ESCROW_ADDRESS

P.flushPending()
check('nothing outside the fakes was reached', outside.length === 0, outside.join(', '))
console.log(`\n${pass}/${total} passed`)
process.exit(pass === total ? 0 : 1)
