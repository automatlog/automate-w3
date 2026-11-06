import { createClient } from '../lib/supabase.server.js'
import { claimQr, clearQrCookie, sessionForAccount } from '../lib/wallet-auth.server.js'

/**
 * The computer's side of "QR code" in Sign in with MetaMask (6 Nov 2026): a
 * resource route the waiting page POSTs to every couple of seconds. It answers
 * only the browser holding the request's secret cookie (claimQr); when the
 * phone has signed, a sign-in request gets its session cookies here, once.
 *
 *   { status: 'pending' | 'expired' | 'done' } or { status: 'error', reason }
 */
const reply = (body, headers = new Headers()) => {
  headers.set('Content-Type', 'application/json')
  headers.set('Cache-Control', 'no-store')
  return new Response(JSON.stringify(body), { status: 200, headers })
}

export async function action({ request }) {
  if (request.method !== 'POST') return new Response(null, { status: 405 })
  const c = claimQr(request)
  if (c.status !== 'approved') return reply({ status: c.status })
  const headers = new Headers()
  headers.append('Set-Cookie', clearQrCookie(request))
  if (c.purpose === 'link') return reply({ status: 'done' }, headers)
  const { supabase, headers: session } = createClient(request)
  const s = await sessionForAccount(supabase, c.userId)
  if (!s.ok) return reply({ status: 'error', reason: s.reason }, headers)
  for (const v of session.getSetCookie()) headers.append('Set-Cookie', v)
  return reply({ status: 'done' }, headers)
}

export function loader() {
  return new Response(null, { status: 404 })
}
