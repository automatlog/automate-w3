/*
 * EXCERPT from Automate's private engine (shared/nodeSpecs.js — the builder panel fields of the trust steps), ETHGlobal Mumbai, 6 Nov 2026.
 * Shown for review: it runs inside Automate (automateplatform.in) and does not
 * run on its own here.
 */

  /* ── Trust steps (6 Nov 2026, ETHGlobal Mumbai) — World ID, USDC on Arc,
     proof on 0G. Runtime: graph-runtime.mjs; pause/resume: trust/pending.mjs. */
  world_approval: {
    title: 'Human approval (World ID)',
    fields: [
      { key: 'summary', label: 'What is being approved', type: 'textarea', rows: 2, expr: true, required: true, default: 'Refund {{amount}} USDC to {{profilename}}', description: 'Shown to the approver on WhatsApp and on the approval page.' },
      { key: 'approver', label: 'Approver\'s WhatsApp number', type: 'text', expr: true, placeholder: 'blank = this account\'s admins', description: 'They need to have messaged this number in the last 24 hours, or WhatsApp will not deliver a plain message.' },
      { key: 'minutes', label: 'Link expires after (minutes)', type: 'number', min: 1, max: 1440, step: 1, numeric: true, default: 30 },
      { key: 'message', label: 'Message to the approver', type: 'textarea', rows: 3, expr: true, default: '🔐 Approval needed: {{summary}}\nApprove or deny with World ID (link expires in {{minutes}} min):\n{{trust_link}}' },
    ],
    hint: 'Pauses the run until a real, verified person approves with World ID (Agent Pass). **approved** continues; **denied** and **expired** do not — wire them to tell the customer. The first approver to sign in is remembered for this account, and later approvals must come from the same World ID. A **Send USDC** step runs only right after an approval.',
  },
  world_human: {
    title: 'Verify human (World ID)',
    fields: [
      { key: 'action', label: 'One per person, for', type: 'text', expr: true, default: 'refund', description: 'World ID gives each person one proof per action: the same person cannot pass twice for "refund", even from another number.' },
      { key: 'message', label: 'Message', type: 'textarea', rows: 2, expr: true, default: 'Please confirm you are a real person with World ID to continue.' },
      { key: 'button', label: 'Button text', type: 'text', default: 'Verify with World ID', maxLength: 20 },
      { key: 'minutes', label: 'Link expires after (minutes)', type: 'number', min: 1, max: 1440, step: 1, numeric: true, default: 60 },
    ],
    hint: 'Sends the customer a link to prove they are a unique human with World ID (IDKit, Proof of Human), checked on the server. **verified** continues; **already** means this person already passed for this action; **cancelled** means they cancelled or the link expired.',
  },
  usdc_collect: {
    title: 'Collect USDC (Arc)',
    fields: [
      { key: 'amount', label: 'Amount (USDC)', type: 'text', expr: true, required: true, placeholder: '12.50 or {{total}}' },
      { key: 'label', label: 'What it is for', type: 'text', expr: true, default: 'Order {{order_id}}' },
      { key: 'message', label: 'Message', type: 'textarea', rows: 2, expr: true, default: 'Please pay {{amount}} in USDC to confirm your order.' },
      { key: 'button', label: 'Button text', type: 'text', default: 'Pay with USDC', maxLength: 20 },
      { key: 'minutes', label: 'Link expires after (minutes)', type: 'number', min: 5, max: 1440, step: 1, numeric: true, default: 30 },
    ],
    hint: 'Sends a USDC payment link (Arc testnet) and waits. **paid** continues with {{usdc_tx}} (the transaction) and {{usdc_payer}} (the wallet that paid); **expired** if nothing arrives in time.',
  },
  usdc_send: {
    title: 'Send USDC (Arc)',
    fields: [
      { key: 'action', label: 'What to do', type: 'select', default: 'send', options: [['send', 'Send from this account\'s wallet'], ['refund', 'Refund the escrowed order to the payer'], ['release', 'Release the escrowed order to the business']], description: 'Refund and release settle the order Collect USDC paid into escrow (TrustEscrow on Arc), {{usdc_order}}.' },
      { key: 'order', label: 'Escrowed order', type: 'text', expr: true, default: '{{usdc_order}}', show: (d) => ['refund', 'release'].includes(d.action) },
      { key: 'to', label: 'To wallet', type: 'text', expr: true, required: true, default: '{{usdc_payer}}', show: (d) => !['refund', 'release'].includes(d.action) },
      { key: 'amount', label: 'Amount (USDC)', type: 'text', expr: true, required: true, placeholder: '12.50 or {{amount}}', show: (d) => !['refund', 'release'].includes(d.action) },
      { key: 'variable', label: 'Save the transaction as', type: 'text', default: 'usdc_sent_tx' },
    ],
    hint: 'Moves USDC on Arc: a transfer from this account\'s wallet, or (when Collect USDC used the escrow) a **refund** of the escrowed order to the payer or its **release** to the business. It runs **only right after a Human approval that came back approved** (one approval, one payment); otherwise it leaves by **failed** and nothing moves.',
  },
  proof0g: {
    title: 'Proof on 0G',
    fields: [],
    hint: 'When a run that passes this step ends, its record — which steps ran, in what order, and every approval, payment and proof, with no message text or phone numbers — is stored on 0G Storage. The run page shows the root hash, and Verify checks it against 0G.',
  },

