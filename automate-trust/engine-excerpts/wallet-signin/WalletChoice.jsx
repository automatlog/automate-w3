import { useEffect, useState } from 'react'
import { useFetcher } from 'react-router'
import qrcode from 'qrcode-generator'
import { IconWallet, IconPuzzle, IconQrcode } from '@tabler/icons-react'
import { signWithMetaMask, metamaskAppLink } from '../lib/wallet-client'
import styles from '../routes/login.module.css'

/**
 * MetaMask, two ways (6 Nov 2026).
 *
 *   One green button first; pressing it swaps in the two ways as icon
 *   buttons (onOpenChange lets the page hide its password form meanwhile).
 *
 *   Extension — MetaMask in this browser signs right here; the page's own
 *               action checks it (onSigned does the submit).
 *   QR code   — the page's action makes a QR request (intent "qr") and sets
 *               its secret in an httpOnly cookie; the QR opens the request in
 *               the MetaMask app on a phone, which signs there. This page asks
 *               /wallet/qr-status every POLL_MS until the phone has signed,
 *               then asks for the 6-digit code the PHONE shows — the guard
 *               against a QR relayed from someone else's screen
 *               (wallet-auth.server.js, claimQr).
 */
const POLL_MS = 2_000

const ask = async (code = '') => {
  const r = await fetch('/wallet/qr-status', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(code ? { code } : {}),
  })
  return r.json()
}

export default function WalletChoice({ nonce, purpose, onSigned, onDone, disabled, defaultOpen = false, onOpenChange }) {
  const fetcher = useFetcher()
  const [open, setOpen] = useState(defaultOpen)
  const [code, setCode] = useState('')
  const [checking, setChecking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [qr, setQr] = useState(null) // { id, code, expiresAt, img, phoneUrl }
  const [phase, setPhase] = useState('') // '' | 'waiting' | 'confirm' | 'expired' | 'done'

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
  const back = () => { setQr(null); setPhase(''); setErr(''); setCode('') }
  const show = (v) => { setOpen(v); setErr(''); onOpenChange?.(v) }

  /* The phone has signed: the code it shows proves this person holds it. */
  const confirm = async (e) => {
    e.preventDefault()
    if (code.replace(/\D/g, '').length !== 6) { setErr('Type the 6 digits your phone shows.'); return }
    setErr('')
    setChecking(true)
    try {
      const j = await ask(code)
      if (j.status === 'done') { setPhase('done'); onDone(); return }
      if (j.status === 'confirm') { setErr(j.wrong ? `That code is not right — ${j.left} ${j.left === 1 ? 'try' : 'tries'} left.` : 'Type the 6 digits your phone shows.'); return }
      if (j.status === 'error') { setErr(j.reason || 'That did not work. Make a new QR code.'); setPhase('expired'); return }
      setErr('This request has ended. Make a new QR code.')
      setPhase('expired')
    } catch {
      setErr('That did not go through. Try again.')
    } finally {
      setChecking(false)
    }
  }

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
        const j = await ask()
        if (stop) return
        if (j.status === 'confirm') { setPhase('confirm'); return }
        if (j.status === 'expired') { setPhase('expired'); return }
        if (j.status === 'error') { setErr(j.reason || 'That did not work. Make a new code.'); setPhase('expired'); return }
      } catch { /* a dropped poll is retried on the next tick */ }
      timer = setTimeout(tick, POLL_MS)
    }
    timer = setTimeout(tick, POLL_MS)
    return () => { stop = true; clearTimeout(timer) }
  }, [phase, qr])

  const off = disabled || busy || fetcher.state !== 'idle'

  return (
    <div className={styles.walletBox}>
      {!open ? (
        <button className={styles.walletMain} type="button" onClick={() => show(true)} disabled={disabled}>
          <IconWallet size={18} stroke={1.8} aria-hidden="true" />
          {purpose === 'link' ? 'Link MetaMask' : 'Sign in with MetaMask'}
        </button>
      ) : !qr ? (
        <>
          <div className={styles.iconRow}>
            <button className={styles.iconBtn} type="button" onClick={extension} disabled={off} aria-label="MetaMask browser extension">
              <IconPuzzle size={28} stroke={1.6} aria-hidden="true" />
              <span>{busy ? 'Waiting…' : 'Extension'}</span>
            </button>
            <button className={styles.iconBtn} type="button" onClick={startQr} disabled={off} aria-label="QR code for the MetaMask app on your phone">
              <IconQrcode size={28} stroke={1.6} aria-hidden="true" />
              <span>{fetcher.state !== 'idle' ? 'Making…' : 'QR code'}</span>
            </button>
          </div>
          <button className={styles.textBack} type="button" onClick={() => show(false)} disabled={busy}>{purpose === 'link' ? 'Cancel' : 'Use email instead'}</button>
        </>
      ) : (
        <div className={styles.qr}>
          {phase === 'waiting' && <img className={styles.qrImg} src={qr.img} width="208" height="208" alt="QR code that opens this request in the MetaMask app" />}
          <p className={styles.qrText}>
            {phase === 'waiting' && 'Scan with your phone’s camera. It opens in the MetaMask app — sign there, and it shows a 6-digit code.'}
            {phase === 'confirm' && 'Your phone signed. Type the 6-digit code it shows.'}
            {phase === 'expired' && 'This QR code has expired.'}
            {phase === 'done' && (purpose === 'link' ? 'Linked.' : 'Signed in. Opening your workspace…')}
          </p>
          {phase === 'waiting' && <p className={styles.qrWait} role="status">Waiting for your phone…</p>}
          {phase === 'confirm' && (
            <form className={styles.confirmForm} onSubmit={confirm}>
              <input
                className={`${styles.input} ${styles.confirmInput}`}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={7}
                autoFocus
                aria-label="6-digit code from your phone"
                placeholder="000 000"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ''))}
              />
              <button className={styles.submit} type="submit" disabled={checking}>{checking ? 'Checking…' : 'Confirm code'}</button>
            </form>
          )}
          <div className={styles.walletRow}>
            {phase === 'expired' && <button className={styles.wallet} type="button" onClick={startQr} disabled={off}>Make a new QR code</button>}
            {phase !== 'done' && <button className={styles.wallet} type="button" onClick={back}>Back</button>}
          </div>
        </div>
      )}
      {err && <p className={styles.error} role="alert">{err}</p>}
    </div>
  )
}
