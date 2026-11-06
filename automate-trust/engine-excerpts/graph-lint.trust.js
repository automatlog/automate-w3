/*
 * EXCERPT from Automate's private engine (shared/graph-lint.js — the flow checks), ETHGlobal Mumbai, 6 Nov 2026.
 * Shown for review: it runs inside Automate (automateplatform.in) and does not
 * run on its own here.
 */

    /* ── trust steps (6 Nov 2026, ETHGlobal) ─────────────────────────────── */
    if (n.type === 'world_approval' && mine.length && (!handles.has('denied') || !handles.has('expired'))) {
      add('warn', n.id, `"${labelOf(n)}" has no ${!handles.has('denied') ? '"denied"' : '"expired"'} wire — the customer is never told it did not go through.`, 'Wire "denied" and "expired" to a message such as "Your request was not approved — our team will contact you."')
    }
    if (n.type === 'world_approval' && !String(n.data?.summary || '').trim()) add('error', n.id, `"${labelOf(n)}" does not say what is being approved.`, 'Open it and write what the approver is approving, e.g. Refund {{amount}} USDC.')
    if (n.type === 'usdc_collect' && !String(n.data?.amount || '').trim()) add('error', n.id, `"${labelOf(n)}" has no amount.`, 'Open it and set the amount, e.g. 12.50 or {{total}}.')
    if (n.type === 'usdc_send' && !['refund', 'release'].includes(n.data?.action) && !String(n.data?.amount || '').trim()) add('error', n.id, `"${labelOf(n)}" has no amount.`, 'Open it and set the amount to send.')
    if (n.type === 'usdc_send' && !edges.some((e) => e.target === n.id && e.sourceHandle === 'approved' && nodes.find((x) => x.id === e.source)?.type === 'world_approval')) {
      add('warn', n.id, `"${labelOf(n)}" is not on a Human approval's "approved" wire, so it will always refuse to send.`, 'Put a Human approval (World ID) step before it and wire its "approved" handle here.')
    }
