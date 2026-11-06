/*
 * EXCERPT from Automate's private engine (app/routes/login.jsx — the MetaMask branches of the sign-in action), ETHGlobal Mumbai, 6 Nov 2026.
 * Shown for review: it runs inside Automate (automateplatform.in) and does not
 * run on its own here. The page shows two choices under the password form —
 * "Browser extension" and "QR code (phone)" — from WalletChoice.jsx.
 */

  /* MetaMask on a phone (6 Nov 2026): a QR request whose secret stays in this
     browser's cookie; WalletChoice shows the QR and waits (wallet-qr-status). */
  if (form.get('intent') === 'qr') {
    const q = startQr({ purpose: 'signin' })
    return data({ qr: { id: q.id, code: q.code, expiresAt: q.expiresAt } }, { headers: { 'Set-Cookie': qrCookie(q, request) } })
  }

  /* Sign in with MetaMask (6 Nov 2026): only a wallet LINKED to an existing
     account opens a session — for that account. Invite-only stays true. */
  if (form.get('intent') === 'wallet') {
    const to = String(form.get('next') ?? '')
    const v = verifyWalletMessage({ message: String(form.get('message') ?? ''), signature: String(form.get('signature') ?? ''), request, purpose: 'signin', cookieNonce: readNonceCookie(request) })
    if (!v.ok) return { error: v.reason, wallet: true }
    const acct = accountOf(v.address)
    if (!acct) return { error: 'This wallet is not linked to an account yet. Sign in with your email, then link it under Settings → Sign in with MetaMask.', wallet: true }
    const { supabase, headers } = createClient(request)
    const s = await sessionForAccount(supabase, acct.userId)
    if (!s.ok) return { error: s.reason, wallet: true }
    return redirect(to && to.startsWith('/') && !to.startsWith('//') ? to : '/app', { headers })
  }
