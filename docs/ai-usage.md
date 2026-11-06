# AI usage

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
