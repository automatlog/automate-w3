# Changelog

Dates are IST. "Pre-existing" marks work from before ETHGlobal Mumbai (5–7 Nov 2026); everything else was built at the event.

## 6 Nov 2026 — ETHGlobal Mumbai, day 2

### Trust layer (`automate-trust/`)
- **Pending store**: a step pauses a run, the link's page resolves it, and the run comes back to the same step to take the outcome's wire. The first outcome wins, expired links are swept, and a row is consumed when its wire is taken.
- **World ID**:
  - Agent Pass approval: OIDC with PKCE, a nonce, a fresh `auth_time`, a JWKS-checked id_token and approver binding.
  - IDKit Proof of Human, with a server-signed RP request, `/api/v4/verify`, and one nullifier per action.
  - The approval and verify pages.
- **Arc USDC**:
  - Pay links with a unique amount per order.
  - A watcher that reads Transfer logs.
  - Refunds signed from the server wallet, with a per-send limit.
  - The pay page, with a wallet button and an EIP-681 QR code.
- **0G**:
  - The run record as canonical JSON, sealed on 0G Storage and chained to the contact's previous run.
  - Verify compares the downloaded, stored and rebuilt digests.
  - The AI step can run on the 0G Compute Router, and its request id is kept in the record.
- **Link pages**: `/webhook/trust/approve|human|pay`. They are public, token-only, `no-store` and send no Referer.

### Automate's engine (private; excerpts in `automate-trust/engine-excerpts/`)
- Six steps on the canvas: Human approval, Verify human, Collect USDC, Send USDC, Proof on 0G, and the AI step's "Run on: 0G Compute Router".
- Send USDC runs only right after an approved Human approval, and one approval allows one payment.
- Wires are strict, so a missing `denied` wire stops the run.
- The flow checks warn about a Send USDC that isn't on an approval's `approved` wire, and about an approval with no `denied` or `expired` wire.
- The run page shows Proof on 0G, with a Verify button.
- The AI flow builder knows the new steps.

### Knowledge service (`knowledge/`)
- Ported from MetaCortex:
  - API embeddings;
  - pgvector, with one collection per knowledge base plus a tsvector keyword table;
  - hybrid retrieval with RRF;
  - answers from the 0G Router, with the request id;
  - a FastAPI app with bearer auth.
- 31 offline tests.

### Docs
- Architecture diagram, README, AI-usage notes, and the event's planning files in `docs/ethglobal/`.

## Pre-existing
- **Automate**, live at automateplatform.in before the event: the visual WhatsApp workflow builder, AI agents, the Wait step and its resume tick, Recent runs, the flow checks and the AI builder (private repository).
- **MetaCortex**, a Python RAG project (January–June 2026). Seven files are kept unchanged in `knowledge/metacortex_original/`.
