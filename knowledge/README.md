# Knowledge service (Python RAG)

A small FastAPI service that stands in for the private Automate server's
knowledge feature: upload documents, search them (vector + keyword), and get
an answer from the 0G Compute Router with the sources it used.

## Run it

```bash
docker compose up -d                      # pgvector/pgvector:pg17 on host port 5433
python -m venv .venv && .venv/Scripts/pip install -r requirements.txt   # Linux/macOS: .venv/bin/pip
cp .env.example .env                      # fill in the keys, then export them
uvicorn knowledge.app:app --port 8000
pytest                                    # offline, no network, no database
```

The app reads environment variables (it does not load `.env` by itself; use
`set -a; . ./.env; set +a` or your shell/IDE).

## Environment

| Name | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | `postgresql+psycopg://knowledge:knowledge@localhost:5433/knowledge` | matches docker-compose |
| `EMBEDDING_BASE_URL` | Gemini OpenAI-compatible endpoint | any OpenAI-compatible `/embeddings` |
| `EMBEDDING_API_KEY` | none | required for ingest and search |
| `EMBEDDING_MODEL` | `gemini-embedding-001` | |
| `EMBEDDING_DIM` | `3072` | must match the model output; sent as `dimensions` |
| `LLM_BASE_URL` | `https://router-api.0g.ai/v1` | 0G Compute Router |
| `LLM_API_KEY` | none | Router key (`sk-...`), required for `/ai/answer` |
| `LLM_MODEL` | `glm-5.2` | list models with `GET /v1/models` |
| `CHUNK_SIZE` / `CHUNK_OVERLAP` / `TOP_K` | 700 / 120 / 4 | |
| `KNOWLEDGE_API_TOKEN` | none | if set, every route except `/health` needs `Authorization: Bearer <token>` |

Changing `EMBEDDING_DIM` after data exists needs a fresh database or new KB ids.

## Endpoints

- `GET /health` -> `{ "ok": true }`
- `POST /kb/{kb_id}/documents` with JSON `{ "text", "source" }` or multipart `file` (pdf, txt, csv; 10 MB max) -> `{ kb_id, source, chunks }`
- `GET /kb/{kb_id}/search?q=&k=` -> `{ results: [{ content, source }] }`
- `POST /ai/answer` with `{ kb_id, question, history? }` -> `{ answer, sources: [{content, source}], model, provider: "0g-router", request_id }`

`kb_id` is 1-64 letters, digits, `_` or `-`. Errors are plain: 400 bad input,
401 bad token, 502 provider failed, 503 "embeddings not configured" or
"answer model not configured".

`request_id` is the 0G Router's `x_0g_trace.request_id` (present on every
Router response); if it is missing the standard completion `id` is used.
Text is PII-masked (email, phone, card, SSN, IP) before it reaches the LLM.

## Reused from MetaCortex vs new

The unchanged originals are in `metacortex_original/` (see `PROVENANCE.md`).

| Piece | Origin |
|---|---|
| Reciprocal rank fusion, parallel hybrid flow (`retrieval.py`) | Reused from MetaCortex `retrieval.py`, adapted (KB-scoped, reranker is a disabled hook) |
| Sanitize + recursive split (`chunking.py`) | Reused from MetaCortex `chunking.py`, trimmed |
| PII masking (`pii.py`) | Reused from MetaCortex `pii.py`, pattern order fixed |
| File text extraction (`loader.py`) | Reused from MetaCortex `document_loader.py`, trimmed to bytes in |
| Collection-per-KB pgvector idea (`store.py`) | Adapted from MetaCortex `vector_store.py` |
| Keyword search over a tsvector (`store.py`) | Adapted from MetaCortex `keyword_search`, new `kb_chunks` table |
| API embeddings (`embeddings.py`) | New (replaces local HuggingFace model) |
| 0G Router answer client (`llm.py`) | New |
| FastAPI app, auth, errors, config (`app.py`, `errors.py`, `config.py`) | New |
| Tests, docker-compose | New |

## Not verified against live services

Written and tested offline. Not yet run against a live Postgres, the Gemini
endpoint, or the 0G Router: whether Gemini's OpenAI-compatible endpoint honours
`dimensions` (its docs show no such parameter), and whether the Router serves
`/v1/embeddings`.
