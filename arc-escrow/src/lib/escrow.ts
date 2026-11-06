import { getAddress, isHex, keccak256, stringToHex, type Address, type Hex } from 'viem'
import { arcTestnet } from 'viem/chains'
import { getUsdc } from '@/onchain-facts'
import { parseUsdc } from '@/onchain-money'

export const CHAIN_ID = arcTestnet.id

const rawEscrow = import.meta.env.VITE_TRUST_ESCROW_ADDRESS as string | undefined
export const ESCROW_ADDRESS: Address | undefined = rawEscrow ? getAddress(rawEscrow) : undefined

const usdcFact = getUsdc(CHAIN_ID)
if (!usdcFact) throw new Error('USDC is not registered for Arc Testnet')
export const USDC_ADDRESS = usdcFact.address as Address

export const escrowAbi = [
  {
    type: 'function',
    name: 'pay',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'orderId', type: 'bytes32' },
      { name: 'amount', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'held',
    stateMutability: 'view',
    inputs: [{ name: 'orderId', type: 'bytes32' }],
    outputs: [
      { name: 'payer', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'state', type: 'uint8' },
    ],
  },
] as const

export interface PayRequest {
  orderId: Hex
  orderInput: string
  hashedFromText: boolean
  amount: bigint
  deadline: bigint
  signature: Hex
  label: string
}

export type ParseResult = { ok: true; request: PayRequest } | { ok: false; error: string }

const BYTES32 = /^0x[0-9a-fA-F]{64}$/

/** Reads ?order=&amount=&deadline=&sig=&label= from a query string. */
export function parsePayRequest(search: string): ParseResult {
  const q = new URLSearchParams(search)
  const orderInput = (q.get('order') ?? '').trim()
  const amountText = (q.get('amount') ?? '').trim()
  const deadlineText = (q.get('deadline') ?? '').trim()
  const sig = (q.get('sig') ?? '').trim()
  const label = (q.get('label') ?? '').trim().slice(0, 120)

  if (!orderInput) return { ok: false, error: 'This link has no order id.' }
  if (!amountText) return { ok: false, error: 'This link has no amount.' }

  let amount: bigint
  try {
    amount = parseUsdc(amountText)
  } catch {
    return { ok: false, error: 'The amount in this link is not valid.' }
  }
  if (amount <= 0n) return { ok: false, error: 'The amount in this link must be more than 0.' }

  if (!/^\d+$/.test(deadlineText)) return { ok: false, error: 'This link has no valid deadline.' }
  if (!isHex(sig) || sig.length !== 132) return { ok: false, error: 'This link has no valid payment signature.' }

  const hashedFromText = !BYTES32.test(orderInput)
  const orderId: Hex = hashedFromText ? keccak256(stringToHex(orderInput)) : (orderInput.toLowerCase() as Hex)

  return {
    ok: true,
    request: { orderId, orderInput, hashedFromText, amount, deadline: BigInt(deadlineText), signature: sig, label },
  }
}
