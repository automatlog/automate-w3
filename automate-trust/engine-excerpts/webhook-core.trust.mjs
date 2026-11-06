/*
 * EXCERPT from Automate's private engine (server/webhook-core.mjs — run sealing, link pages, timers), ETHGlobal Mumbai, 6 Nov 2026.
 * Shown for review: it runs inside Automate (automateplatform.in) and does not
 * run on its own here. Everything else in this file's original is pre-existing.
 */

/* ── finishRun — a trust pause is "waiting" ── */
    /* A trust step (6 Nov, ETHGlobal) that sent its link and stopped is a
       pause, like a Wait; one that took an outcome logged a 'trust' step. */
    const trustPause = ['world_approval', 'world_human', 'usdc_collect'].includes(last?.type) && !exec.steps.some((x) => x.type === 'trust' && x.node === last.id)
    exec.status = exec.errors ? 'failed'
      : last?.type === 'wait' || trustPause ? 'waiting'
      : !exec.path.length && !exec.actions && !exec.steps.some((x) => x.type === 'ai') ? 'skipped'
      : 'completed'


/* ── finishRun — seal on 0G, chained per contact ── */
    /* Proof on 0G (6 Nov, ETHGlobal): a run that passed the step is sealed
       once it has ended — trust/zg.mjs. `prev` is this contact's last sealed
       root, so a conversation's runs (order, payment, refund) form a chain
       anyone can walk on 0G. Builder tests are never sealed. */
    if (exec.channel !== 'test' && exec.path.some((n) => n.type === 'proof0g')) {
      const prev = [...executions].reverse().find((x) => x !== exec && x.from === exec.from && x.workspaceId === exec.workspaceId && x.proof?.status === 'sealed')
      exec.proofPrev = prev?.proof?.root || null
      exec.proof = { status: 'sealing' }
      import('./lib/trust/zg.mjs').then((Z) => Z.sealRun(exec)).then((p) => {
        exec.proof = p
        saveExecs()
        push(p.status === 'sealed' ? 'flow' : 'error', p.status === 'sealed' ? `run ${exec.id} sealed on 0G — root ${p.root}` : `run ${exec.id}: ${p.reason}`, undefined, exec.workspaceId || null)
      }).catch((e) => { exec.proof = { status: 'failed', reason: e.message }; saveExecs() })
    }


/* ── the public link pages, above the operator-auth gate ── */
    /* Trust steps' link pages (6 Nov, ETHGlobal) — public on purpose: the
       approver and the customer have no account. trust/routes.mjs. */
    if (url.pathname.startsWith('/webhook/trust/')) {
      const { handleTrustRoute } = await import('./lib/trust/routes.mjs')
      if (await handleTrustRoute({ req, res, url, readBody, push })) return true
    }


/* ── Verify a run against 0G ── */
    /* Verify a run's proof on 0G (6 Nov, ETHGlobal): download the record by
       its root hash and compare — trust/zg.mjs verifyRun. */
    const verM = url.pathname.match(/^\/webhook\/executions\/(run_[0-9a-f]{12})\/verify$/)
    if (verM && req.method === 'GET') {
      const run = executions.find((x) => x.id === verM[1] && mine(x))
      if (!run) return done(404, 'application/json', JSON.stringify({ error: 'no such run' }))
      const { verifyRun } = await import('./lib/trust/zg.mjs')
      return done(200, 'application/json', JSON.stringify(await verifyRun(run)))
    }


/* ── timers: resume at once, expire links, watch Arc ── */
  /* Trust steps (6 Nov, ETHGlobal) — trust/pending.mjs. An outcome resumes its
     run at once rather than on the next 30-s tick; every 10 s, links past
     their time expire and Arc is asked for the USDC transfers that open
     payment links are waiting for (only while there are any). */
  import('./lib/trust/pending.mjs').then((P) => P.onResolved(() => setTimeout(runDueWaits, 50))).catch(() => {})
  let trustRunning = false
  const trustTick = setInterval(async () => {
    if (trustRunning) return
    trustRunning = true
    try {
      const P = await import('./lib/trust/pending.mjs')
      for (const r of await P.sweepExpired()) push('flow', `trust link (${r.kind}) for ${r.from} expired`, undefined, r.workspaceId || null)
      const pays = P.listPending('pay')
      if (pays.length) {
        const { findPayments } = await import('./lib/trust/arc.mjs')
        for (const hit of await findPayments(pays)) {
          const row = P.getPending(hit.id)
          const r = await P.resolvePending(hit.id, 'paid', { usdc_tx: hit.txHash, usdc_payer: hit.payer, usdc_amount: row?.data?.amountText || '' })
          if (r) push('flow', `USDC received on Arc for ${r.from} — ${hit.txHash}`, undefined, r.workspaceId || null)
        }
      }
    } catch (e) {
      push('error', `trust watcher: ${e.message}`)
    } finally { trustRunning = false }
  }, 10_000)
  trustTick.unref?.()
