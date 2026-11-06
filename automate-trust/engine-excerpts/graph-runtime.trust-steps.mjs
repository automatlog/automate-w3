/*
 * EXCERPT from Automate's private engine (server/lib/graph-runtime.mjs — the step cases inside the flow walker), ETHGlobal Mumbai, 6 Nov 2026.
 * Shown for review: it runs inside Automate (automateplatform.in) and does not
 * run on its own here.
 */

/* ── the AI step, when it runs on the 0G Compute Router ── */
            /* "Run on: 0G Compute Router" (6 Nov, ETHGlobal) — trust/zg-router.mjs;
               the 0G request id is kept as {{<var>_0g_request}} and in the run's
               record on 0G. */
            const zg = d.provider === '0g' ? (await import('./trust/zg-router.mjs')).zgChat() : null
            const got = await aiStep(d, session, evt, ctx(), zg)
            for (const [k, v] of Object.entries(got)) setVar(session, k, v)
            if (zg?.last) {
              setVar(session, `${varName(d.variable) || 'ai_answer'}_0g_request`, zg.last.requestId || '')
              push('trust', `AI step answered on 0G (${zg.last.model})`, { step: 'aistep', node: node.id, outcome: 'answered', provider: zg.last.provider, model: zg.last.model, requestId: zg.last.requestId, at: new Date().toISOString() })
            }
            push('flow', `AI step (${d.task || 'summarise'})${zg ? ' on 0G' : ''} → ${Object.keys(got).map((k) => `{{${k}}}`).join(' ')}`)

/* ── the trust steps ── */
          case 'proof0g': {
            /* ── PROOF ON 0G (6 Nov, ETHGlobal) — a marker: webhook-core's
               finishRun seals every run whose path passed this step, once the
               run has ended (trust/zg.mjs). Nothing to do here but say so. */
            push('flow', isTestRun(evt) ? 'TEST — a real run with this step is sealed on 0G when it ends (a test is not)' : 'this run will be sealed on 0G when it ends')
            node = nextNode(node.id, 'out')
            continue
          }
          case 'world_approval':
          case 'world_human':
          case 'usdc_collect': {
            /* ── TRUST STEPS THAT PAUSE (6 Nov, ETHGlobal) — trust/pending.mjs.
               First pass: open a row, send the link, stop. The link's page
               resolves the row and the run comes back HERE (flow-waits), finds
               the outcome, sets its variables and takes that wire — strictly:
               a missing "denied" wire stops the run rather than falling
               through to "approved". */
            const kind = node.type === 'world_approval' ? 'approval' : node.type === 'world_human' ? 'human' : 'pay'
            const label = d.title || ({ approval: 'Human approval', human: 'Verify human', pay: 'Collect USDC' })[kind]
            if (isTestRun(evt) || !evt.channelSlug) {
              push('flow', `${isTestRun(evt) ? 'TEST — ' : ''}"${label}" sends a link and waits for it — only a WhatsApp number connected to an account can wait; stopping here`)
              return
            }
            const P = await import('./trust/pending.mjs')
            const where = { slug: evt.channelSlug, from: evt.from, nodeId: node.id }
            const open = P.openAt(where)
            if (open && open.status !== 'pending') {
              P.consumePending(open.id)
              for (const [k, v] of Object.entries(open.vars || {})) setVar(session, k, v)
              const outcome = kind === 'human' && open.status === 'expired' ? 'cancelled' : open.status
              if (kind === 'approval' && outcome === 'approved') {
                /* One approval opens the way for ONE protected step (Send
                   USDC), soon after — see usdc_send. */
                setVar(session, 'trust_approval_at', String(Date.now()))
                setVar(session, 'trust_approval_node', node.id)
              }
              push('trust', `"${label}" → ${outcome}`, {
                step: node.type, node: node.id, outcome, at: new Date().toISOString(),
                ...(kind === 'pay' ? { amount: open.data?.amountText, tx: open.vars?.usdc_tx, payer: open.vars?.usdc_payer, chain: 'arc-testnet' } : {}),
                ...(kind === 'approval' ? { approver: open.vars?.approval_by, acr: open.vars?.approval_acr } : {}),
                ...(kind === 'human' ? { action: open.data?.action, nullifier: open.vars?.human_id } : {}),
              })
              const wire = edgeFrom(node.id, outcome)
              if (!wire) { push('flow', `"${label}" ended "${outcome}" but that wire is not connected — stopping here`); return }
              node = nodeById(wire.target)
              continue
            }
            const base = String(process.env.TRUST_BASE_URL || process.env.PUBLIC_URL || 'https://automateplatform.in').replace(/\/+$/, '')
            const minutes = Math.max(1, Math.min(10_080, Number(d.minutes) || (kind === 'approval' ? 30 : kind === 'pay' ? 30 : 60)))
            let row = open
            if (!row) {
              const data = { title: label, summary: substitute(String(d.summary || ''), ctx(), 'curly').trim().slice(0, 400) }
              if (kind === 'human') data.action = substitute(String(d.action || 'refund'), ctx(), 'curly').trim().replace(/[^\w.-]+/g, '-').slice(0, 60) || 'refund'
              if (kind === 'pay') {
                const { newPayment } = await import('./trust/arc.mjs')
                const amount = substitute(String(d.amount || ''), ctx(), 'curly').trim()
                Object.assign(data, await newPayment({ amount, label: substitute(String(d.label || label), ctx(), 'curly').trim().slice(0, 80) }), { amount })
              }
              row = P.createPending({ kind, ttlMs: minutes * 60_000, data, ...where, workspaceId: graphWorkspace(), phoneId: evt.phoneId, wabaId: evt.wabaId, profileName: evt.profileName || '', flowKey: currentFlowKey(evt) })
            }
            const link = `${base}/webhook/trust/${kind === 'approval' ? 'approve' : kind}/${row.id}`
            const vars = { ...ctx(), trust_link: link, amount: row.data?.amountText || '' }
            if (kind === 'approval') {
              const say = substitute(String(d.message || '🔐 Approval needed: {{summary}}\nApprove or deny with World ID (link expires in {{minutes}} min):\n{{trust_link}}'), { ...vars, summary: row.data.summary || label, minutes: String(minutes) }, 'curly').trim()
              const to = String(substitute(String(d.approver || ''), ctx(), 'curly')).replace(/\D/g, '')
              if (to.length >= 10) await send(evt.phoneId, to.length === 10 ? `91${to}` : to, textMsg(say))
              else await notifyAdmins(evt.phoneId, say)
              push('flow', `"${label}" — approval link sent to ${to.length >= 10 ? 'the approver' : "the account's admins"}; waiting up to ${minutes} min`)
            } else {
              const body = substitute(String(d.message || (kind === 'pay' ? 'Please pay {{amount}} in USDC to confirm your order.' : 'Please confirm you are a real person with World ID to continue.')), vars, 'curly').trim()
              const button = String(d.button || (kind === 'pay' ? 'Pay with USDC' : 'Verify with World ID')).slice(0, 20)
              await send(evt.phoneId, evt.from, await localize(ctaUrl(body, button, link), session.lang))
              noteFlowTurn(session, 'Bot', body)
              push('flow', `"${label}" — link sent; waiting up to ${minutes} min`)
            }
            setVar(session, 'trust_link', link)
            return
          }
          case 'usdc_send': {
            /* ── SEND USDC (6 Nov, ETHGlobal) — a refund or payout from the
               account's Arc wallet. It runs ONLY right after a Human approval
               that came back "approved" in this conversation (within
               APPROVAL_FRESH_MS), and that approval is spent by it: one
               approval, one payment. Enforced here, not left to how the flow
               happens to be wired. */
            const APPROVAL_FRESH_MS = 15 * 60_000
            const to = substitute(String(d.to || '{{usdc_payer}}'), ctx(), 'curly').trim()
            const amount = substitute(String(d.amount || ''), ctx(), 'curly').trim()
            const leave = (port, why) => {
              if (why) push('flow', `Send USDC: ${why}`)
              const wire = edgeFrom(node.id, port)
              return wire ? nodeById(wire.target) : null
            }
            if (isTestRun(evt)) { push('flow', `TEST — would send ${amount} USDC to ${to} on Arc (not sent in a test)`); node = leave('out'); continue }
            const approvedAt = Number(session.vars?.trust_approval_at || 0)
            if (!approvedAt || Date.now() - approvedAt > APPROVAL_FRESH_MS) {
              push('trust', 'Send USDC refused — no fresh Human approval', { step: 'usdc_send', node: node.id, outcome: 'refused', amount, at: new Date().toISOString() })
              node = leave('err', `refused — it needs a "Human approval" that came back approved in the last ${APPROVAL_FRESH_MS / 60_000} min, and there is none`)
              continue
            }
            setVar(session, 'trust_approval_at', '')
            try {
              const { sendUsdc } = await import('./trust/arc.mjs')
              const r = await sendUsdc({ to, amount })
              setVar(session, varOr(d.variable, 'usdc_sent_tx'), r.txHash)
              setVar(session, 'usdc_sent_link', r.explorerUrl || '')
              push('trust', `sent ${amount} USDC on Arc`, { step: 'usdc_send', node: node.id, outcome: 'sent', amount, tx: r.txHash, chain: 'arc-testnet', at: new Date().toISOString() })
              node = leave('out')
            } catch (e) {
              node = leave('err', `not sent — ${e.message}`)
            }
            continue
          }
