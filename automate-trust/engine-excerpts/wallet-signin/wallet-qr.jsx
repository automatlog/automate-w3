import { useEffect, useState } from 'react'
import { data, useActionData, useLoaderData, useNavigation, useParams, useSubmit } from 'react-router'
import { issueNonce, nonceCookie, readNonceCookie, qrRequest, approveQr } from '../lib/wallet-auth.server'
import { signWithMetaMask, metamaskAppLink } from '../lib/wallet-client'
import styles from './login.module.css'

/**
 * The phone side of "QR code" in Sign in with MetaMask (6 Nov 2026).
 *
 * Opened by the QR the computer shows, inside the MetaMask app's browser. It
 * signs a message naming this request (wallet-auth.server.js, approveQr) and
 * then shows a 6-digit code to type on the computer — only then does the
 * computer finish the sign-in or the link, so a QR relayed from someone
 * else's screen gets them nothing. Nothing here signs the PHONE in. Opened in an ordinary browser, it offers to reopen
 * itself in the MetaMask app.
 */
export function meta() {
  return [
    { title: 'Sign with MetaMask' },
    { name: 'robots', content: 'noindex' },
    /* The request id is in this URL. */
    { name: 'referrer', content: 'no-referrer' },
  ]
}

export async function loader({ request, params }) {
  const req = qrRequest(params.id)
  if (!req) return data({ gone: true }, { headers: { 'Cache-Control': 'no-store' } })
  const nonce = issueNonce()
  const headers = new Headers({ 'Cache-Control': 'no-store' })
  headers.append('Set-Cookie', nonceCookie(nonce, request))
  return data({ nonce, purpose: req.purpose, account: req.account }, { headers })
}

export async function action({ request, params }) {
  const form = await request.formData()
  const r = approveQr({ id: params.id, message: String(form.get('message') ?? ''), signature: String(form.get('signature') ?? ''), request, cookieNonce: readNonceCookie(request) })
  return data(r.ok ? { ok: true, purpose: r.purpose, confirmCode: r.confirmCode } : { error: r.reason }, { headers: { 'Cache-Control': 'no-store' } })
}

export default function WalletQr() {
  const d = useLoaderData()
  const actionData = useActionData()
  const { id } = useParams()
  const submit = useSubmit()
  const navigation = useNavigation()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [hasWallet, setHasWallet] = useState(null)
  useEffect(() => { setHasWallet(typeof window !== 'undefined' && !!window.ethereum) }, [])
  const working = busy || navigation.state !== 'idle'

  const sign = async () => {
    setErr('')
    setBusy(true)
    try {
      const { message, signature } = await signWithMetaMask({ nonce: d.nonce, purpose: d.purpose === 'link' ? 'qrlink' : 'qrsignin', requestId: id })
      submit({ message, signature }, { method: 'post' })
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  const done = actionData?.ok
  const title = d.gone ? 'This QR code has expired' : done ? 'Type this code on your computer' : d.purpose === 'link' ? 'Link this wallet' : 'Sign in on your computer'

  return (
    <div className={styles.page}>
      <div className={styles.shell}>
        <div className={styles.card}>
          <div className={styles.head}>
            <h1 className={styles.title}>{title}</h1>
            <p className={styles.lead}>
              {d.gone && 'It was used already or is more than three minutes old. Make a new one on your computer.'}
              {!d.gone && done && (actionData.purpose === 'link' ? 'Your computer asks for it to finish linking this wallet.' : 'Your computer asks for it to finish signing you in.')}
              {!d.gone && !done && (d.purpose === 'link'
                ? `This links the wallet you sign with to ${d.account || 'the account open on your computer'}.`
                : 'Signing here signs you in on the computer that showed the QR code.')}
            </p>
          </div>

          {!d.gone && done && (
            <>
              <p className={styles.confirmCode} aria-label={`Code ${actionData.confirmCode.split('').join(' ')}`}>{actionData.confirmCode.slice(0, 3)} {actionData.confirmCode.slice(3)}</p>
              <p className={styles.qrCode}>Type it only on a computer in front of you, where you scanned the QR yourself. Never read it out or send it to anyone — whoever types it is signed in as you.</p>
            </>
          )}

          {!d.gone && !done && (
            <>
              {hasWallet === false ? (
                <a className={styles.submit} href={metamaskAppLink(`${window.location.host}${window.location.pathname}`)}>Open in the MetaMask app</a>
              ) : (
                <button className={styles.submit} type="button" onClick={sign} disabled={working || hasWallet === null}>
                  {working ? 'Waiting for MetaMask…' : 'Sign with MetaMask'}
                </button>
              )}
            </>
          )}

          {(err || actionData?.error) && <p className={styles.error} role="alert">{err || actionData.error}</p>}
          <p className={styles.note}>Signing proves the wallet is yours; nothing is sent on chain and it costs nothing.</p>
        </div>
      </div>
    </div>
  )
}
