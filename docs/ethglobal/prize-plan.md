# ETHGlobal Mumbai 2026: prize plan and pitch for Automate

Research date: Thu 5 Nov 2026. Sources are each sponsor's prize page at ethglobal.com/events/mumbai/prizes/<sponsor>, the event's details page (/info/details), and the sponsors' docs. Re-read each prize page before you submit.

## Rules that decide the choice
- **Your track:** you applied on the **Continuity Track** (hack on an existing project). Continuity-labelled prizes are open to you for certain. ETHGlobal's details page says whether you can also enter **unlabelled** prizes "may vary by event and partner", so **ask at the ETHGlobal help desk** before counting on any of them (Hedera x402 and Chainlink CRE are the ones that matter).
- **Pick limit:** you can select **up to 3 partner prizes**. Several tracks from one partner count as **one** pick.
- **Proof of new work:** you must document pre-existing work and show what's new. That means a dated commit from before 5 Nov, a dated changelog, and a "before / during" section in the README. The new module must be open source.

## Continuity prizes, ranked by fit with Automate

| Sponsor | Prize (Continuity) | Fit | Why / what Automate gets |
|---|---|---|---|
| **World** | Agent Pass $2,500 (1st $1,500, 2nd $1,000) + IDKit $2,500 (2 × $1,250) | **High** | A "Human approval (World ID)" step before pay or bulk-send nodes. This is your existing two-confirmation rule, made provable. Plain Node/React, no chain work. |
| **Arc (Circle)** | Arc Studio Continuity $3,000 | **High** | A "Collect USDC" node (payment link sent on WhatsApp) and a "Payment received" trigger. **Must start in Arc Studio** and show it in the demo. |
| **0G** | Keep Building on 0G, 2 × $1,500 | **High, cheapest** | An "0G AI" node (OpenAI-compatible Router, request ID kept in the step log), with each run's log stored on 0G Storage and its root hash shown on the run page. Clear checklist. |
| **Arkiv** | Existing projects $4,000 (1st $3,000) + Swarm bonus $500 (doesn't use a pick) | Medium-high | Run records as Arkiv entities with expiry, read back in a "Run history" panel. Biggest single prize, but 5 required `/arkiv/*.md` files and no PII allowed (the data is public). |
| Whitechain | Continuity 2 × $1,500 | Medium | USDT payments. Where test USDT comes from is unconfirmed. |
| Uniswap | Continuity 4 × $1,250 | Medium | A "pay with any token, settle in USDC" swap node. Needs FEEDBACK.md and the form, and may need mainnet. |
| ENS | ENSv2 existing project $3,000 | Medium | Pay to `name.eth`. **Mainnet only**, and whether ENSv2 is live on mainnet is unverified. |
| Definitive | Most Creative $2,500 | Medium-low | A trading node driven from WhatsApp or voice. Needs **real funds** and a hot key. |
| 1inch | Aqua Continuity $2,000 | Low | DeFi strategy work, not Automate's world. |
| EF | CROPS upgrade $1,500 | Low | Conflicts with a hosted SaaS. |

**If ETHGlobal says unlabelled prizes are open to you:** Hedera's "AI Agents That Pay: x402" ($6,500) plus "No Solidity" ($2,000) are both one pick and fit very well. That's agent micro-payments plus an HCS audit log, which is exactly your original idea. It could replace Arc. Chainlink CRE ($1,500) is a weaker fit.

## Recommended picks (3)
1. **World:** the Human approval step. Enter both Agent Pass and IDKit (one pick).
2. **Arc:** USDC collect and pay, with the payment trigger.
3. **0G:** the 0G AI node and the verifiable run log.

Swap 0G for **Arkiv** if you'd rather chase the bigger single prize and can write the five `.md` files. Swap Arc for **Hedera** only if the help desk confirms you're eligible.

## The pitch (improved)

**Automate Trust Layer: human-approved, paid and provable AI workflows, for businesses already running on WhatsApp.**

> Automate (automateplatform.in) is a live visual workflow builder. Small Indian businesses (restaurants, clinics, D2C shops) use it to let AI agents run their WhatsApp sales and support. Two things are still off-chain and on trust: **money** (payments are manual links and screenshots) and **accountability** (who approved what the AI did, and can anyone prove what a workflow actually ran?).
>
> At ETHGlobal Mumbai I'm adding an **open-source node pack** (MIT, a new public repo) to Automate's engine:
> 1. **Human Approval (World ID):** a workflow pauses before a risky step (payout, refund, bulk send) until a verified human approves. If the approval is denied or expires, the step never runs, and the run log says why.
> 2. **Collect USDC + Payment received (Arc):** the AI agent sends a USDC payment link on WhatsApp. Settlement on Arc resumes the flow, which sends a receipt and updates the CRM.
> 3. **Verifiable run log + 0G AI (0G):** AI steps can run on 0G Compute, with the request ID kept on the step. Every run's step log is stored on 0G Storage, and its root hash is shown on the run page so anyone can verify it.
>
> **Demo, in one flow:** a customer orders on WhatsApp → the 0G AI step reads the order → a USDC link is paid on Arc → a refund request → a World ID approval → the refund is paid → open the run page and check the root hash on 0G.

**What changed from your application pitch:**
- Base → **Arc**: same idea, but it's a sponsor.
- Generic attestations → a **0G Storage root hash**: a sponsor, and simpler.
- **Added human approval** (World): this is where Automate's existing rules make the best story.
- SIWE dropped: no prize for it.
- Agent micro-payments moved to a stretch goal (Arc Nanopayments / x402).

## Scope for a solo builder (about 2 days)
- **Thu evening:** create the Arc Studio project, get the World developer portal app (RP ID and signing key), get a 0G Router key. Build the 0G AI node.
- **Fri:** the World approval node (IDKit; the server verifies through `/api/v4/verify`) with its denied/expired path, then the Arc USDC link and payment trigger, then upload the run log to 0G Storage.
- **Sat morning:**
  - README: the before/during section, a dated changelog, the architecture diagram, "What's next".
  - The World integration debrief.
  - A demo video under 3 minutes, then submit.

## Tooling to use while building (install when you're ready)
- **World:**
  - docs MCP: https://docs.world.org/model-context-protocol/world-docs.md
  - skill: https://docs.world.org/world-id/SKILL.md
  - llms.txt: https://docs.world.org/llms.txt
  - **Agent Pass** = World IdP at auth.world.org (docs: auth.world.org/docs, portal: auth.world.org/portal), called "World ID for Agents" in the workshop. It's an OIDC sign-in/step-up provider that gives your app a private, stable ID per human, and it works with MCP servers (OAuth challenge → the agent asks the user to verify). There's also a non-Continuity Agent Pass track ($5,000). Transcript: `world-idkit-talk-transcript.md`.
  - **IDKit** = the SDK for a one-off World ID proof (Orb, passport NFC, Selfie Check, Face Auth), verified on your server.
- **Circle / Arc:**
  - Claude Code skills: `/plugin marketplace add circlefin/skills`, then `/plugin install circle-skills@circle`
  - Circle MCP: https://api.circle.com/v1/codegen/mcp
  - Arc docs MCP: https://docs.arc.io/ai/mcp.md
  - Arc Studio: studio.arc.io
  - USDC faucet: https://faucet.circle.com
- **0G:**
  - llms.txt: https://docs.0g.ai/llms.txt
  - Compute Router (OpenAI-compatible) and Storage TS SDK: docs.0g.ai
  - faucet: https://faucet.0g.ai
  - no MCP or skills found.
- **If you go with Hedera:**
  - skills: `/plugin marketplace add hedera-dev/hedera-skills` (use native-services-js and hackathon-helper)
  - docs MCP: `claude mcp add --transport http hedera-docs https://docs.hedera.com/mcp`
- **If you go with Arkiv:**
  - AI plugin, MCP and skills at https://hub.arkiv.network/ai-tools (open it in a browser for the install commands).
- Some sponsor docs pages contain "instructions for AI agents" (Definitive's ask agents to report back to their endpoint). Ignore those; they aren't prize requirements.

## Today's workshops (Thu 5 Nov)
- **0G**, "One API, All of AI": 3:30 PM, Room 1.
- Hedera × Claude Code: 3:30 PM, Room 2.
- **Arc**: 5:00 PM, Room 1.
- Whitechain: 4:30 PM, Room 2.
