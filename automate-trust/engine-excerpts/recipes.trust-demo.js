/*
 * EXCERPT from Automate's private engine (shared/recipes.js — the "trust-demo"
 * recipe), ETHGlobal Mumbai, 6 Nov 2026. Shown for review: it runs inside
 * Automate (automateplatform.in) and does not run on its own here.
 * `n(id, type, data)` is a node; an edge is [source, target, port].
 * test-trust-flow.mjs, section 12, walks this recipe through the real engine.
 */
/* ══════════════════════════════════════════════════════════════════════════
   TRUST LAYER DEMO (6 Nov 2026, ETHGlobal Mumbai) — one order, end to end: the
   AI step reads it on the 0G Compute Router, the customer pays USDC into
   TrustEscrow on Arc, taps "Request refund", proves they are one human (World
   ID IDKit), the owner approves (World ID Agent Pass), the escrow refunds, and
   the run is sealed on 0G. Every refusal ends with no money moved, and is
   sealed too. The trigger needs the word "demo", so ordinary chats never start
   it. Offered on the Workflows tab only at ?demo=trust (app.jsx).
   ══════════════════════════════════════════════════════════════════════════ */
RECIPES.push({
  id: 'trust-demo',
  title: 'Trust Layer demo → pay, verify, approve, refund, prove',
  channel: 'whatsapp',
  summary: 'A demo order: AI reads it on 0G, USDC is paid into escrow on Arc, a verified human asks for a refund, the owner approves with World ID, the escrow refunds, and the run is proven on 0G.',
  rationale: 'Money moves only right after a real person approves, and every run leaves a record anyone can check.',
  needs: [],
  nodes: [
    n('channel', 'channel', { title: 'WhatsApp', source: 'whatsapp' }),
    n('trigger', 'trigger', { title: 'Demo order', keywords: 'demo', match: 'contains' }),
    n('read', 'aistep', { title: 'Read the order (0G)', task: 'extract', fields: 'item, quantity', input: 'message', variable: 'ai_answer', provider: '0g' }),
    n('confirm', 'msg', { title: 'Order summary', msgType: 'text', body: '🧾 *Order:* {{quantity}} × {{item}}\nRead by AI on the 0G Compute Router.\nTotal: *1.00 USDC* on Arc testnet.' }),
    n('pay', 'usdc_collect', {
      title: 'Collect USDC', amount: '1.00', label: 'Demo order', minutes: 30, button: 'Pay with USDC',
      message: 'Please pay {{amount}} in USDC to confirm your order. It is held in escrow on Arc until the order is done.',
    }),
    n('paid', 'msg', {
      title: 'Paid', msgType: 'buttons', variable: 'after_pay', buttons: [{ title: 'Request refund' }],
      body: '✅ Paid: {{usdc_amount}} is held in escrow on Arc.\nTx: {{usdc_tx}}\n\nChanged your mind?',
    }),
    n('payexp', 'msg', { title: 'Payment expired', msgType: 'text', body: 'Your payment link expired. Send *demo* to start again.' }),
    n('human', 'world_human', {
      title: 'Verify human', action: 'refund', minutes: 30, button: 'Verify with World ID',
      message: 'To ask for a refund, confirm you are a real person with World ID. One refund per person.',
    }),
    n('already', 'msg', { title: 'Already claimed', msgType: 'text', body: 'This World ID has already claimed a refund: one per person. Your payment stays in escrow.' }),
    n('cancelled', 'msg', { title: 'Not verified', msgType: 'text', body: 'Verification was cancelled or expired, so no refund was requested.' }),
    /* Approver: type the owner's WhatsApp number here before going live (blank
       sends the link to the engine's admins). They must have messaged this
       number in the last 24 hours. */
    n('approve', 'world_approval', { title: 'Owner approves', summary: 'Refund {{usdc_amount}} to {{profilename}} ({{quantity}} × {{item}})', approver: '', minutes: 30 }),
    n('refund', 'usdc_send', { title: 'Refund from escrow', action: 'refund', order: '{{usdc_order}}', variable: 'usdc_sent_tx' }),
    n('done', 'msg', { title: 'Refunded', msgType: 'text', body: '💸 Refunded from escrow on Arc.\nTx: {{usdc_sent_tx}}' }),
    n('failed', 'msg', { title: 'Refund failed', msgType: 'text', body: 'The refund could not be sent, so no money moved. We will look into it.' }),
    n('denied', 'msg', { title: 'Not approved', msgType: 'text', body: 'Your refund was not approved. Your payment stays in escrow.' }),
    n('late', 'msg', { title: 'Approval timed out', msgType: 'text', body: 'The approval timed out, so no money moved.' }),
    n('proof', 'proof0g', { title: 'Proof on 0G' }),
  ],
  edges: [
    ['channel', 'trigger'], ['trigger', 'read', 'out'],
    ['read', 'confirm', 'out'], ['read', 'confirm', 'err'],
    ['confirm', 'pay'], ['pay', 'paid', 'paid'], ['pay', 'payexp', 'expired'],
    ['paid', 'human', 'opt-0'],
    ['human', 'approve', 'verified'], ['human', 'already', 'already'], ['human', 'cancelled', 'cancelled'],
    ['approve', 'refund', 'approved'], ['approve', 'denied', 'denied'], ['approve', 'late', 'expired'],
    ['refund', 'done', 'out'], ['refund', 'failed', 'err'],
    ['done', 'proof'], ['failed', 'proof'], ['denied', 'proof'], ['late', 'proof'], ['already', 'proof'],
  ],
})
