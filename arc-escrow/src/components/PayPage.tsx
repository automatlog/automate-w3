import { useMemo, useState } from 'react'
import { ConnectKitButton } from 'connectkit'
import { useAccount, useReadContract } from 'wagmi'
import { Check, ExternalLink } from 'lucide-react'
import { buildTxExplorerUrl } from '@/onchain-facts'
import { formatUsdc } from '@/onchain-money'
import { CHAIN_ID, ESCROW_ADDRESS, escrowAbi, parsePayRequest, type PayRequest } from '@/lib/escrow'
import { STEP_TEXT, usePay } from '@/lib/usePay'

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-[#0B0D0C] text-[#D1D1D1]">
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 py-10">{children}</main>
    </div>
  )
}

function Notice({ title, text }: { title: string; text: string }) {
  return (
    <Shell>
      <h1 className="text-xl font-semibold text-balance">{title}</h1>
      <p className="mt-2 text-pretty text-[#D1D1D1]/70">{text}</p>
    </Shell>
  )
}

const primaryButton =
  'flex min-h-12 w-full items-center justify-center rounded-xl bg-[#3DDC84] px-4 text-base font-semibold text-[#0B0D0C] transition active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50'

function PayCard({ request }: { request: PayRequest }) {
  const { isConnected } = useAccount()
  const { pay, step, txHash, error, busy } = usePay(request)
  const amountText = formatUsdc(request.amount)
  const [nowSec] = useState(() => BigInt(Math.floor(Date.now() / 1000)))
  const expired = nowSec > request.deadline

  const order = useReadContract({
    address: ESCROW_ADDRESS,
    abi: escrowAbi,
    functionName: 'held',
    args: [request.orderId],
    chainId: CHAIN_ID,
    query: { enabled: step !== 'done' },
  })
  const alreadyPaid = order.data !== undefined && order.data[2] !== 0

  if (step === 'done' && txHash) {
    return (
      <Shell>
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#3DDC84] text-[#0B0D0C]">
          <Check size={22} strokeWidth={3} />
        </div>
        <h1 className="mt-5 text-xl font-semibold text-balance">Paid</h1>
        <p className="mt-2 text-pretty">Paid — your order is confirmed on WhatsApp.</p>
        <div className="mt-6 rounded-xl border border-white/10 bg-white/[0.03] p-4">
          <p className="text-xs uppercase tracking-[0.08em] text-[#D1D1D1]/60">Transaction</p>
          <p className="mt-1 break-all font-mono text-xs">{txHash}</p>
          <a
            href={buildTxExplorerUrl(CHAIN_ID, txHash)}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex min-h-11 items-center gap-1.5 text-sm underline underline-offset-4"
          >
            View on explorer <ExternalLink size={14} />
          </a>
        </div>
      </Shell>
    )
  }

  const blocked = expired
    ? 'This payment link has expired. Ask for a new one on WhatsApp.'
    : alreadyPaid
      ? 'This order has already been paid.'
      : null

  return (
    <Shell>
      <p className="text-xs uppercase tracking-[0.08em] text-[#D1D1D1]/60">Pay with USDC on Arc Testnet</p>
      <h1 className="mt-3 text-2xl font-semibold text-balance break-words">{request.label || 'Payment'}</h1>
      <p className="mt-4 text-5xl font-bold tabular-nums tracking-tight">
        {amountText} <span className="text-2xl font-semibold text-[#D1D1D1]/70">USDC</span>
      </p>

      <div className="mt-6 rounded-xl border border-white/10 bg-white/[0.03] p-4">
        <p className="text-xs uppercase tracking-[0.08em] text-[#D1D1D1]/60">Order id</p>
        <p className="mt-1 break-all font-mono text-xs">{request.orderId}</p>
        {request.hashedFromText && (
          <p className="mt-2 text-xs text-[#D1D1D1]/60 break-words">
            Hash of &ldquo;{request.orderInput}&rdquo;
          </p>
        )}
      </div>

      <div className="mt-8">
        {blocked ? (
          <p role="alert" className="rounded-xl border border-white/10 p-4 text-pretty">
            {blocked}
          </p>
        ) : !ESCROW_ADDRESS ? (
          <p role="alert" className="rounded-xl border border-white/10 p-4">
            Payments are not set up for this page yet.
          </p>
        ) : !isConnected ? (
          <ConnectKitButton.Custom>
            {({ show }) => (
              <button type="button" onClick={show} className={primaryButton}>
                Connect wallet
              </button>
            )}
          </ConnectKitButton.Custom>
        ) : (
          <button type="button" onClick={() => void pay()} disabled={busy} className={primaryButton}>
            {busy ? 'Working...' : `Pay ${amountText} USDC`}
          </button>
        )}

        {busy && (
          <p role="status" className="mt-3 text-sm text-[#D1D1D1]/80">
            {STEP_TEXT[step]}
          </p>
        )}
        {error && (
          <p role="alert" className="mt-3 text-sm text-pretty">
            {error}
          </p>
        )}
      </div>
    </Shell>
  )
}

export default function PayPage() {
  const parsed = useMemo(() => parsePayRequest(window.location.search), [])
  if (!parsed.ok) {
    return <Notice title="Payment link problem" text={parsed.error} />
  }
  return <PayCard request={parsed.request} />
}
