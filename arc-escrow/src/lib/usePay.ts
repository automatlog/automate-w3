import { useCallback, useState } from 'react'
import { erc20Abi, type Hex } from 'viem'
import { useAccount, usePublicClient, useSwitchChain, useWriteContract } from 'wagmi'
import { CHAIN_ID, ESCROW_ADDRESS, USDC_ADDRESS, escrowAbi, type PayRequest } from './escrow'

export type PayStep =
  | 'idle'
  | 'switching'
  | 'approve-wallet'
  | 'approve-confirming'
  | 'pay-wallet'
  | 'pay-confirming'
  | 'done'

export const STEP_TEXT: Record<PayStep, string> = {
  idle: '',
  switching: 'Switching your wallet to Arc Testnet...',
  'approve-wallet': 'Approve USDC in your wallet...',
  'approve-confirming': 'Waiting for the approval to confirm...',
  'pay-wallet': 'Confirm the payment in your wallet...',
  'pay-confirming': 'Waiting for the payment to confirm...',
  done: '',
}

function friendlyError(e: unknown): string | null {
  const err = e as { code?: number; message?: string; shortMessage?: string }
  const msg = `${err?.shortMessage ?? ''} ${err?.message ?? ''}`.toLowerCase()
  if (err?.code === 4001 || msg.includes('user rejected') || msg.includes('user denied')) return null
  if (msg.includes('badsignature')) return 'This payment link is not valid. Ask for a new one on WhatsApp.'
  if (msg.includes('expired')) return 'This payment link has expired. Ask for a new one on WhatsApp.'
  if (msg.includes('orderexists')) return 'This order has already been paid.'
  if (msg.includes('insufficient') || msg.includes('exceeds balance')) {
    return 'Your wallet does not have enough USDC for this payment.'
  }
  if (msg.includes('network') || msg.includes('timeout')) return 'Network issue. Check your connection and try again.'
  return 'The payment could not be completed. Please try again.'
}

export function usePay(request: PayRequest) {
  const { address, chainId } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()
  const client = usePublicClient({ chainId: CHAIN_ID })
  const [step, setStep] = useState<PayStep>('idle')
  const [txHash, setTxHash] = useState<Hex | null>(null)
  const [error, setError] = useState<string | null>(null)

  const pay = useCallback(async () => {
    if (!address || !client || !ESCROW_ADDRESS) return
    setError(null)
    try {
      if (chainId !== CHAIN_ID) {
        setStep('switching')
        await switchChainAsync({ chainId: CHAIN_ID })
      }

      const allowance = await client.readContract({
        address: USDC_ADDRESS,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [address, ESCROW_ADDRESS],
      })
      if (allowance < request.amount) {
        setStep('approve-wallet')
        const approveHash = await writeContractAsync({
          address: USDC_ADDRESS,
          abi: erc20Abi,
          functionName: 'approve',
          args: [ESCROW_ADDRESS, request.amount],
          chainId: CHAIN_ID,
        })
        setStep('approve-confirming')
        const approval = await client.waitForTransactionReceipt({ hash: approveHash })
        if (approval.status !== 'success') throw new Error('approval reverted')
      }

      setStep('pay-wallet')
      const hash = await writeContractAsync({
        address: ESCROW_ADDRESS,
        abi: escrowAbi,
        functionName: 'pay',
        args: [request.orderId, request.amount, request.deadline, request.signature],
        chainId: CHAIN_ID,
      })
      setTxHash(hash)
      setStep('pay-confirming')
      const receipt = await client.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error('payment reverted')
      setStep('done')
    } catch (e) {
      setStep('idle')
      setError(friendlyError(e))
    }
  }, [address, chainId, client, request, switchChainAsync, writeContractAsync])

  return { pay, step, txHash, error, busy: step !== 'idle' && step !== 'done' }
}
