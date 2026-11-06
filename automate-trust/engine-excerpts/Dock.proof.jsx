/*
 * EXCERPT from Automate's private engine (app/flow/Dock.jsx — the run page: Proof on 0G and Verify), ETHGlobal Mumbai, 6 Nov 2026.
 * Shown for review: it runs inside Automate (automateplatform.in) and does not
 * run on its own here.
 */

/* Proof on 0G (6 Nov 2026, ETHGlobal) — a run that passed the step is sealed
   when it ends (server/lib/trust/zg.mjs). Verify asks the engine to download
   the record from 0G by its root hash and compare it with this run. */
const PROOF_STATUS = { sealed: 'Sealed on 0G', sealing: 'Sealing…', skipped: 'Not sealed', failed: 'Not sealed' }
function ProofOn0G({ run }) {
  const p = run.proof
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState(null)
  const verify = async () => {
    setBusy(true); setRes(null)
    try {
      const r = await engineFetch(`/webhook/executions/${run.id}/verify`)
      const j = await r.json().catch(() => null)
      if (!r.ok || !j) throw new Error(j?.error || `HTTP ${r.status}`)
      setRes(j)
    } catch (e) { setRes({ ok: false, reason: e.message }) } finally { setBusy(false) }
  }
  return (
    <>
      <p className={styles.h}>Proof on 0G</p>
      <dl className={styles.facts}>
        <div><dt>Status</dt><dd>{PROOF_STATUS[p.status] ?? p.status}{p.reason ? ` — ${p.reason}` : ''}</dd></div>
        {p.root && <div><dt>Root hash</dt><dd style={{ wordBreak: 'break-all' }}>{p.root}</dd></div>}
        {p.tx && <div><dt>Transaction</dt><dd style={{ wordBreak: 'break-all' }}>{p.explorer ? <a href={p.explorer} target="_blank" rel="noreferrer">{p.tx}</a> : p.tx}</dd></div>}
      </dl>
      {p.status === 'sealed' && (
        <div className={styles.detailFoot}>
          <button type="button" className={styles.rerun} onClick={verify} disabled={busy}>{busy ? 'Checking 0G…' : 'Verify on 0G'}</button>
          <span className={styles.mute}>Downloads the record by its root hash and compares it with this run.</span>
          {res && <span className={styles.note} role="status">{res.ok ? '✓ ' : '✗ '}{res.reason}</span>}
        </div>
      )}
    </>
  )
}

