import { useState } from 'react'
import { Form, Link, data, useActionData, useLoaderData, useNavigation, useSubmit } from 'react-router'
import { requireUser } from '../lib/supabase.server'
import { issueNonce, verifyWalletMessage, linkWallet, unlinkWallet, walletOf } from '../lib/wallet-auth.server'
import { signWithMetaMask } from '../lib/wallet-client'
import styles from './login.module.css'

/**
 * Settings → Sign in with MetaMask (6 Nov 2026).
 *
 * Linking happens HERE, signed in, because a wallet may only ever open the
 * account it was linked to (wallet-auth.server.js): signing the link message
 * proves the wallet is yours, and being signed in proves the account is. One
 * wallet per account; a wallet already linked elsewhere is refused.
 */
export function meta() {
  return [{ title: 'Sign in with MetaMask — Automate' }, { name: 'robots', content: 'noindex' }]
}

export async function loader({ request }) {
  const { user, headers } = await requireUser(request)
  return data({ nonce: issueNonce(), wallet: walletOf(user.id) }, { headers })
}

export async function action({ request }) {
  const { user, headers } = await requireUser(request)
  const form = await request.formData()
  const intent = String(form.get('intent') ?? '')
  if (intent === 'unlink') {
    unlinkWallet(user.id)
    return data({ ok: 'MetaMask is no longer linked. Sign in with your email.' }, { headers })
  }
  if (intent === 'link') {
    const v = verifyWalletMessage({ message: String(form.get('message') ?? ''), signature: String(form.get('signature') ?? ''), request, purpose: 'link' })
    if (!v.ok) return data({ error: v.reason }, { headers })
    const r = linkWallet({ userId: user.id, email: user.email, address: v.address })
    return data(r.ok ? { ok: 'Linked. You can now sign in with MetaMask.' } : { error: r.reason }, { headers })
  }
  return data({ error: 'Unknown request.' }, { status: 400, headers })
}

const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '')

export default function WalletLink() {
  const { nonce, wallet } = useLoaderData()
  const actionData = useActionData()
  const submit = useSubmit()
  const navigation = useNavigation()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const working = busy || navigation.state !== 'idle'

  const link = async () => {
    setErr('')
    setBusy(true)
    try {
      const { message, signature } = await signWithMetaMask({ nonce, purpose: 'link' })
      submit({ intent: 'link', message, signature }, { method: 'post' })
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.shell}>
        <div className={styles.card}>
          <div className={styles.head}>
            <h1 className={styles.title}>Sign in with MetaMask</h1>
            <p className={styles.lead}>
              {wallet
                ? `Linked to ${short(wallet)}. You can sign in with this wallet instead of your password.`
                : 'Link your MetaMask wallet to this account, then use “Sign in with MetaMask” on the login page.'}
            </p>
          </div>

          {wallet ? (
            <Form method="post">
              <input type="hidden" name="intent" value="unlink" />
              <button className={styles.wallet} type="submit" disabled={working}>Unlink this wallet</button>
            </Form>
          ) : (
            <button className={styles.submit} type="button" onClick={link} disabled={working}>
              {busy ? 'Waiting for MetaMask…' : 'Link MetaMask'}
            </button>
          )}

          {(err || actionData?.error) && <p className={styles.error} role="alert">{err || actionData.error}</p>}
          {actionData?.ok && <p className={styles.note} role="status">{actionData.ok}</p>}

          <p className={styles.note}>Signing proves the wallet is yours; nothing is sent on chain and it costs nothing.</p>
        </div>
        <Link className={styles.back} to="/settings">← Settings</Link>
      </div>
    </div>
  )
}
