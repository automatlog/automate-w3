/**
 * MetaMask in the browser (6 Nov 2026): build a Sign-In with Ethereum
 * (EIP-4361) message around the nonce the server issued, and have the wallet
 * sign it. The server (wallet-auth.server.js) re-checks every field.
 *
 * The statements are shared with the server so a "link" signature can never be
 * used to sign in, or the other way round.
 */
export const STATEMENTS = {
  signin: 'Sign in to Automate with this wallet.',
  link: 'Link this wallet to my Automate account.',
}

/** The EIP-4361 message, as the browser builds it and the server parses it. */
export function siweMessage({ host, origin, address, chainId, nonce, purpose, now = new Date() }) {
  return [
    `${host} wants you to sign in with your Ethereum account:`,
    address,
    '',
    STATEMENTS[purpose],
    '',
    `URI: ${origin}`,
    'Version: 1',
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${now.toISOString()}`,
    `Expiration Time: ${new Date(now.getTime() + 10 * 60_000).toISOString()}`,
  ].join('\n')
}

const toHex = (s) => `0x${Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('')}`

/** Returns { message, signature }, or throws a plain-words Error. */
export async function signWithMetaMask({ nonce, purpose }) {
  const eth = typeof window !== 'undefined' ? window.ethereum : null
  if (!eth) throw new Error('MetaMask is not installed in this browser.')
  if (!nonce) throw new Error('Reload the page and try again.')
  let address, chainId
  try {
    ;[address] = await eth.request({ method: 'eth_requestAccounts' })
    chainId = parseInt(await eth.request({ method: 'eth_chainId' }), 16) || 1
  } catch (e) {
    throw new Error(e?.code === 4001 ? 'You cancelled in MetaMask.' : 'MetaMask did not respond.')
  }
  if (!address) throw new Error('No account was chosen in MetaMask.')
  const message = siweMessage({ host: window.location.host, origin: window.location.origin, address, chainId, nonce, purpose })
  try {
    const signature = await eth.request({ method: 'personal_sign', params: [toHex(message), address] })
    return { message, signature }
  } catch (e) {
    throw new Error(e?.code === 4001 ? 'You cancelled in MetaMask.' : 'MetaMask could not sign the message.')
  }
}
