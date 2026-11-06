/*
 * EXCERPT from Automate's private engine (app/flow/nodes.jsx — the canvas cards and their wires), ETHGlobal Mumbai, 6 Nov 2026.
 * Shown for review: it runs inside Automate (automateplatform.in) and does not
 * run on its own here.
 */

  /* Trust steps (6 Nov 2026, ETHGlobal Mumbai) — shared/nodeSpecs.js. */
  world_approval: {
    label: 'Human approval', glyph: 'check', tone: 'plain',
    subtitle: (d) => `World ID · ${Number(d.minutes) || 30} min`,
    body: (d) => clip(d.summary || ''),
    targets: [{ id: 'in', pos: L }],
    sources: [{ id: 'approved', pos: R, label: 'approved' }, { id: 'denied', pos: R, label: 'denied' }, { id: 'expired', pos: R, label: 'expired' }],
  },
  world_human: {
    label: 'Verify human', glyph: 'check', tone: 'plain',
    subtitle: (d) => `World ID · one per person · ${d.action || 'refund'}`,
    targets: [{ id: 'in', pos: L }],
    sources: [{ id: 'verified', pos: R, label: 'verified' }, { id: 'already', pos: R, label: 'already' }, { id: 'cancelled', pos: R, label: 'cancelled' }],
  },
  usdc_collect: {
    label: 'Collect USDC', glyph: 'check', tone: 'plain',
    subtitle: (d) => `Arc · ${d.amount || '?'} USDC · ${Number(d.minutes) || 30} min`,
    targets: [{ id: 'in', pos: L }],
    sources: [{ id: 'paid', pos: R, label: 'paid' }, { id: 'expired', pos: R, label: 'expired' }],
  },
  usdc_send: {
    label: 'Send USDC', glyph: 'check', tone: 'plain',
    subtitle: (d) => (d.action === 'refund' ? 'Arc escrow · refund to the payer' : d.action === 'release' ? 'Arc escrow · release to the business' : `Arc · ${d.amount || '?'} USDC → ${clip(d.to || '{{usdc_payer}}', 18)}`),
    targets: [{ id: 'in', pos: L }],
    sources: [{ id: 'out', pos: R, label: 'sent' }, { id: 'err', pos: R, label: 'failed' }],
  },
  proof0g: {
    label: 'Proof on 0G', glyph: 'check', tone: 'plain',
    subtitle: () => 'seal this run on 0G Storage',
    targets: [{ id: 'in', pos: L }],
    sources: [{ id: 'out', pos: R }],
  },

