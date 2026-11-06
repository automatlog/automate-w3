# Provenance of these files

These seven files are the author's own pre-existing work, written before
ETHGlobal Mumbai. They come from the author's private project **MetaCortex**
(a Python / LangChain / pgvector RAG service), source path:

    C:\Users\AMAN\Downloads\MetaCortex\OmniCortex_Elevenlab_Ollama\core\rag\
    C:\Users\AMAN\Downloads\MetaCortex\OmniCortex_Elevenlab_Ollama\core\processing\

They are copied **unchanged** (byte-for-byte, original file timestamps kept)
in the first commit of this repository. They are not imported or run; they are
kept here as the reference the new `knowledge/` package was ported from. They
will not import on their own (they reference MetaCortex modules that are not
included).

| File | Original location | Last modified | SHA-256 (first 12) |
|---|---|---|---|
| embeddings.py | core/rag/ | 2026-04-02 | 1e416e21e44e |
| vector_store.py | core/rag/ | 2026-02-17 | ab014a0d55f3 |
| retrieval.py | core/rag/ | 2026-04-02 | 50fc31287219 |
| ingestion_fixed.py | core/rag/ | 2026-01-28 | 4ac780fe34a9 |
| chunking.py | core/processing/ | 2026-02-19 | fcfb6cdb35a7 |
| pii.py | core/processing/ | 2026-02-02 | 280876feaf69 |
| document_loader.py | core/processing/ | 2026-02-06 | f5024fa807c4 |

Not copied: `.env`, logs, `storage/`, lock files, client-specific flows,
WhatsApp / voice / ElevenLabs code, and any key.

Everything outside this folder is new work written during the event.
