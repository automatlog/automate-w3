# TrustEscrow Pay

A USDC escrow on Arc Testnet and a mobile pay page for Automate's WhatsApp workflows. A customer pays into escrow from a link; the operator later releases the funds to the merchant or refunds the customer, and the customer can reclaim after 14 days if nothing happens.

Built with [Arc Studio](https://studio.arc.io)

## Tech stack

- Solidity 0.8, OpenZeppelin, Foundry
- React, Vite, TypeScript, Tailwind CSS
- wagmi, viem, ConnectKit

## Pay page link

The page reads its details from the URL:

`/?order=<bytes32 or text>&amount=<USDC, e.g. 12.50>&deadline=<unix seconds>&sig=<operator signature>&label=<text>`

Text order ids are hashed with keccak256 and the resulting id is shown on screen.

## Development

Prerequisites: Bun and Foundry.

Install: `bun install`

Environment variables:

- `VITE_TRUST_ESCROW_ADDRESS`: address of the deployed TrustEscrow contract on Arc Testnet.
- `RPC_PROXY_BASE_URL`, `RPC_PROXY_TOKEN`, `RPC_PROXY_CHAINS`: optional, provided by Arc Studio for backend scripts.

Run the app: `bun run dev`

Check lint and types: `bun run check`

Build: `bun run build`

Test the contract: `forge test`
