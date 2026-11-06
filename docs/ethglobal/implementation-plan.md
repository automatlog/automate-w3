# Automate Trust Layer: implementation plan (ETHGlobal Mumbai, Continuity)

**Goal:** an AI workflow that is **paid** (USDC on Arc), **approved by a real human** (World), and **provable** (run log on 0G). It ships as new steps in Automate's flow builder, plus an open-source (MIT) package.

**Prize picks (3):**
1. World: Agent Pass [Cont] + IDKit [Cont]. Both count as one pick.
2. Arc Studio Continuity.
3. 0G Keep Building.

## Event rules that shape the plan (from /info/details)
- **Deadline: Sat 7 Nov, 9:00 AM IST.** Late submissions aren't accepted. Aim to submit by 8:00 AM.
- **Submission:** project title, description, and a repo link that proves the work was done during the hackathon. Pick up to 3 partner prizes; several tracks from one partner count as one.
- **Continuity:** document the pre-existing work clearly, and show the new features built at the event.
- **Git history:**
  - "Large single commits or missing histories may be disqualified." Commit small and often during the build.
  - Mark the pre-event commit clearly as pre-existing work.
- **AI disclosure:**
  - Say in the README where and how AI tools were used.
  - Put the spec, prompt and plan files in the repo (`docs/ethglobal/`).
  - A fully AI-generated project may lose partner prize and finalist eligibility. You drive the design, the demo and the narration.
- **Open source:** list the libraries and kits that were reused, separately from the new work.
- **Demo video:**
  - 2 to 4 minutes. Under 2 or over 4 is rejected on upload.
  - 720p or higher, recorded on a computer, not a phone.
  - **Your own voice, no text-to-speech or AI voiceover**, and no music-only video with text.
  - No sped-up footage, and at most 4 bullets per slide.
- **Judging:**
  - Judges score technicality, originality, practicality, usability (UI/UX/DX) and wow factor.
  - Finalists get 4 minutes of demo plus 3 minutes of Q&A. Expect "what inspired it, which tools and why, what was hard".
- **Not on that page** (team size, joining teams across tracks, conduct): check Rules & Conduct or ask on ETHGlobal Discord before teammates join.

## Cut line (if time runs short)
- **Must ship:**
  - the 0G run log with Verify;
  - `human_approval` (Agent Pass) with the denied and expired paths;
  - `collect_usdc` on Arc;
  - the demo flow, README and video.
- **Then:** the IDKit "one refund per human" check, then `send_usdc`.
- **Stretch:** the MCP step-up.

## 0. Setup: now (Fri morning), before any code
- [ ] **Git (needs your OK):** commit the current uncommitted work as "pre-ETHGlobal state". It is the work from 26 Oct to 4 Nov, live since the 4 Nov deploy. Then start the branch `ethglobal/trust-layer` and add `CHANGELOG-ETHGLOBAL.md` with dated entries.
- [ ] **New public repo `automate-trust-nodes` (MIT):** plain ESM modules `world.mjs`, `arc.mjs` and `zg.mjs`, with tests. Automate imports them.
- [ ] **World:**
  - an app in the Developer Portal (IDKit `app_id`, action);
  - an OIDC client at auth.world.org/portal for Agent Pass (redirect `/approve/callback`);
  - the iOS Sandbox app or the Simulator.
- [ ] **Arc:**
  - create the project **in Arc Studio first** (the prize needs it);
  - a testnet wallet and USDC from faucet.circle.com.
- [ ] **0G:** a Router key, a testnet wallet, and faucet.0g.ai.
- [ ] Keys go in `.env` only, never committed or logged.

## 1. 0G: Fri morning
- [ ] **AI step on 0G:** the existing AI step gets the provider option "0G Router". The Router is OpenAI-compatible, and the request ID is kept in the step log.
- [ ] **Verifiable run log:** when a run ends, the step log is redacted (no phone numbers or message text) and uploaded to 0G Storage, then the root hash and tx are saved on the run. 0G Storage is public, so no customer data goes in.
- [ ] **Run page:** a "Proof on 0G" row with the root hash and an explorer link. A **Verify** button downloads the log, re-hashes it and shows a match or a mismatch.

## 2. World: Fri midday
- [ ] **New step `human_approval`** (Agent Pass). It covers all six places in the flow-step checklist: spec, card, runtime, AI builder, lint and tests.
  - The run pauses, with a row in flow-waits that has an expiry.
  - The approver (the business owner) gets a link to `/approve/:token`.
  - The approval page does an Agent Pass step-up (OIDC). The server checks the issuer, the audience, the nonce, a fresh `auth_time`, and that the `sub` is the approver bound at setup.
  - Wires: **approved** resumes the flow. **denied** and **expired** both mean the protected step never runs, and the log says why.
- [ ] **IDKit check, "one refund per human":** the customer's refund page asks for a Proof of Human. It is verified on the server, and the nullifier is stored, so a second claim from the same person is refused.
  - Wires: **verified**, **already claimed**, **cancelled**.
  - This explains the credential choice: Proof of Human is the minimum that stops someone claiming twice from many numbers.
- [ ] **Stretch:** Automate's MCP server returns a step-up challenge on a payout tool, so an AI agent has to get the human's World ID first.

## 3. Arc: Fri afternoon to evening
- [ ] **New step `collect_usdc`:**
  - It makes a payment request (amount, order ID) and sends the pay link on WhatsApp through the existing CTA-URL message.
  - A watcher sees the USDC transfer on Arc testnet.
  - Wires: **paid** (with the tx hash stored) or **expired**.
- [ ] **New step `send_usdc`** (refund or payout) from the server wallet on Arc testnet. The demo always puts it after `human_approval`.

## 4. Demo flow and submission: Fri night, submit by 8:00 AM Sat (deadline 9:00 AM IST)
- [ ] **One flow:**
  1. A WhatsApp order arrives, and the 0G AI step reads it.
  2. `collect_usdc` returns **paid**, and a receipt is sent.
  3. A refund request comes in. IDKit gives one claim per human, then `human_approval` (Agent Pass) runs, then `send_usdc`.
  4. The run page shows the root hash on 0G, and **Verify** checks it.
- [ ] **Failure paths on camera:** approval denied or expired, so no refund; the IDKit check cancelled; a second claim refused.
- [ ] **README:**
  - "before / during" (with the pre-event commit and the live site);
  - the changelog;
  - an architecture diagram;
  - the 0G checklist;
  - **"Reused vs new"** (the libraries and kits, separate from the event's work);
  - **"How AI was used"**, with the plan files in `docs/ethglobal/`;
  - "what's next".
- [ ] **World integration debrief:** both World tracks need one. It covers time to first success, friction, missing docs, and the top improvement.
- [ ] **Demo video, 2 to 4 minutes (aim for 3:00):**
  - a screen recording at 720p or higher, narrated in your own voice;
  - no TTS, no sped-up footage, at most 4 bullets per slide.
- [ ] **Submit on the Hacker Dashboard by 8:00 AM Sat:**
  - the title, the description and the repo link;
  - the 3 prizes: World (both tracks), Arc, 0G.
- [ ] **Finalist prep:** a 4-minute live demo and answers to "inspiration, tools and why, challenges".

## Rules while building
- Testnet and sandbox only, with no real money.
- WhatsApp sends only to your own number, after your two confirmations.
- Deploy to automateplatform.in only when you say "update server". Otherwise the demo runs locally.
- Every new step gets offline tests in `scripts/test-flow-nodes.mjs`, with all outside calls faked. Run `node scripts/run-tests.mjs` before any deploy.
- Commit small, one change at a time, with clear messages, so the history shows the work.
