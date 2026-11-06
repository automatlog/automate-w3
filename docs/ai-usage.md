# AI usage

This whole repository was built with an AI coding assistant (Claude Code) working under the author's direction. The author set the product, the architecture, the sponsors and the security rules: one approval → one payment, strict wires, every outcome verified on the server, and no personal data in the public 0G record. The author reviews and owns the result. The planning files used during the event are in `docs/ethglobal/`.

## automate-trust/

- **Written with the assistant:** the trust modules (`pending`, `world`, `arc`, `zg`, `zg-router`, `routes`), their wiring into Automate's engine (the excerpts), and the offline tests.
- **Checked against the official docs during the build:**
  - World: the OIDC discovery document, IDKit's `request`, `proofOfHuman` and `signRequest`, and `/api/v4/verify`;
  - Arc: the chain id, the RPC, and USDC's address and decimals;
  - 0G: the Storage TS SDK upload and download, and the Router's `x_0g_trace`.
- **The architecture diagram** (`docs/architecture.svg`) was drawn by the assistant in Automate's design language.

## knowledge/

The `knowledge/` service in this repository was ported from the author's
pre-existing MetaCortex RAG code with an AI coding assistant (Claude Code)
working under the author's direction. The author chose the architecture
(API embeddings, Postgres + pgvector, the 0G Compute Router as the answer
model) and the scope; the author reviews and owns the result.

## What was AI-assisted

- Porting and adapting the pre-existing files (kept unchanged in
  `knowledge/metacortex_original/`) into the new `knowledge/` package:
  chunking, PII masking, hybrid retrieval with reciprocal rank fusion,
  and the file loader.
- Writing new modules: `config.py`, `embeddings.py`, `store.py`, `llm.py`,
  `app.py`, `errors.py`.
- Writing the offline pytest suite in `tests/` and `docker-compose.yml`.
- Reading the Gemini and 0G Router docs to confirm model names, the default
  embedding dimension and the Router's response fields.
- Drafting `knowledge/README.md` and this file.

## Not AI-generated

- The pre-existing MetaCortex files in `knowledge/metacortex_original/`
  (see `PROVENANCE.md` there).
- Product decisions: what the service does, which providers it uses.

The git history is deliberately split into small commits so the pre-existing
import and each piece of new work can be told apart.
