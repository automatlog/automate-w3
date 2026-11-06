import { useEffect, useState } from 'react'
import { useFetcher } from 'react-router'
import qrcode from 'qrcode-generator'
import { signWithMetaMask, metamaskAppLink } from '../lib/wallet-client'
import styles from '../routes/login.module.css'

/**
 * MetaMask, two ways (6 Nov 2026).
 *
 *   Extension — MetaMask in this browser signs right here; the page's own
 *               action checks it (onSigned does the submit).
 *   QR code   — the page's action makes a QR request (intent "qr") and sets
 *               its secret in an httpOnly cookie; the QR opens the request in
 *               the MetaMask app on a phone, which signs there. This page asks
 *               /wallet/qr-status every POLL_MS until the phone is done, the
 *               code expires, or the person goes back.
 *
 * Both screens show the same two-digit code (wallet-auth.server.js, startQr).
 */
const POLL_MS = 2_000

export default function WalletChoice({ nonce, purpose, onSigned, onDone, disabled }) {
  const fetcher = useFetcher()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [qr, setQr] = useState(null) // { id, code, expiresAt, img, phoneUrl }
  const [phase, setPhase] = useState('') // '' | 'waiting' | 'expired' | 'done'

  const extension = async () => {
    setErr('')
    setBusy(true)
    try {
      onSigned(await signWithMetaMask({ nonce, purpose }))
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  const startQr = () => {
    setErr('')
    fetcher.submit({ intent: 'qr' }, { method: 'post' })
  }
  const back = () => { setQr(null); setPhase(''); setErr('') }

  /* The action answered with a new request: draw its QR. */
  useEffect(() => {
    const q = fetcher.data?.qr
    if (!q) { if (fetcher.data?.error) setErr(fetcher.data.error); return }
    const phoneUrl = metamaskAppLink(`${window.location.host}/wallet/qr/${q.id}`)
    const c = qrcode(0, 'M')
    c.addData(phoneUrl)
    c.make()
    const svg = c.createSvgTag({ cellSize: 4, margin: 3, scalable: true })
    setQr({ ...q, phoneUrl, img: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` })
    setPhase('waiting')
  }, [fetcher.data])

  /* Wait for the phone. */
  useEffect(() => {
    if (phase !== 'waiting' || !qr) return undefined
    let stop = false
    let timer
    const tick = async () => {
      if (stop) return
      if (Date.now() > qr.expiresAt) { setPhase('expired'); return }
      try {
        const r = await fetch('/wallet/qr-status', { method: 'POST', credentials: 'same-origin' })
        const j = await r.json()
        if (stop) return
        if (j.status === 'done') { setPhase('done'); onDone(); return }
        if (j.status === 'expired') { setPhase('expired'); return }
        if (j.status === 'error') { setErr(j.reason || 'That did not work. Make a new code.'); setPhase('expired'); return }
      } catch { /* a dropped poll is retried on the next tick */ }
      timer = setTimeout(tick, POLL_MS)
    }
    timer = setTimeout(tick, POLL_MS)
    return () => { stop = true; clearTimeout(timer) }
  }, [phase, qr, onDone])

  const off = disabled || busy || fetcher.state !== 'idle'

  return (
    <div className={styles.walletBox}>
      {!qr ? (
        <div className={styles.walletRow}>
          <button className={styles.wallet} type="button" onClick={extension} disabled={off}>
            {busy ? 'Waiting for MetaMask…' : 'Browser extension'}
          </button>
          <button className={styles.wallet} type="button" onClick={startQr} disabled={off}>
            {fetcher.state !== 'idle' ? 'Making a code…' : 'QR code (phone)'}
          </button>
        </div>
      ) : (
        <div className={styles.qr}>
          {phase === 'waiting' && <img className={styles.qrImg} src={qr.img} width="208" height="208" alt="QR code that opens this request in the MetaMask app" />}
          <p className={styles.qrText}>
            {phase === 'waiting' && <>Scan with your phone’s camera. It opens in the MetaMask app, which shows code <b>{qr.code}</b> — sign there.</>}
            {phase === 'expired' && 'This code expired.'}
            {phase === 'done' && (purpose === 'link' ? 'Linked on your phone.' : 'Signed on your phone. Opening your workspace…')}
          </p>
          {phase === 'waiting' && <p className={styles.qrWait} role="status">Waiting for your phone…</p>}
          <div className={styles.walletRow}>
            {phase === 'expired' && <button className={styles.wallet} type="button" onClick={startQr} disabled={off}>Make a new code</button>}
            {phase !== 'done' && <button className={styles.wallet} type="button" onClick={back}>Back</button>}
          </div>
        </div>
      )}
      {err && <p className={styles.error} role="alert">{err}</p>}
    </div>
  )
}
