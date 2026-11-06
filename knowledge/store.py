"""pgvector store, one collection per knowledge base, plus a keyword table.

New work (ETHGlobal Mumbai), adapted from MetaCortex vector_store.py
(collection-per-agent via langchain_postgres PGVector) and the keyword_search in
retrieval.py (which queried MetaCortex tables that are not copied). Here the
keyword side is a small kb_chunks table with a generated tsvector column.
"""
import re
from typing import Dict, List

from . import config
from .errors import BadRequest

_KB_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def validate_kb_id(kb_id: str) -> str:
    if not isinstance(kb_id, str) or not _KB_ID.match(kb_id):
        raise BadRequest("kb id must be 1-64 letters, digits, '_' or '-'")
    return kb_id


def collection_name(kb_id: str) -> str:
    return f"kb_{validate_kb_id(kb_id)}"


SCHEMA_SQL = [
    "CREATE EXTENSION IF NOT EXISTS vector",
    """CREATE TABLE IF NOT EXISTS kb_chunks (
        id BIGSERIAL PRIMARY KEY,
        kb_id TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
    )""",
    "CREATE INDEX IF NOT EXISTS kb_chunks_tsv_idx ON kb_chunks USING GIN (tsv)",
    "CREATE INDEX IF NOT EXISTS kb_chunks_kb_idx ON kb_chunks (kb_id)",
]

KEYWORD_SQL = """
SELECT content, source, ts_rank(tsv, plainto_tsquery('english', :q)) AS rank
FROM kb_chunks
WHERE kb_id = :kb AND tsv @@ plainto_tsquery('english', :q)
ORDER BY rank DESC
LIMIT :k
"""


class PgStore:
    """Store interface used by retrieval: add_texts, vector_search, keyword_search."""

    def __init__(self, embeddings, engine=None):
        self.embeddings = embeddings
        self._engine = engine
        self._ready = False

    @property
    def engine(self):
        if self._engine is None:
            from sqlalchemy import create_engine

            self._engine = create_engine(config.database_url(), pool_pre_ping=True)
        return self._engine

    def ensure_schema(self) -> None:
        if self._ready:
            return
        from sqlalchemy import text

        with self.engine.begin() as conn:
            for stmt in SCHEMA_SQL:
                conn.execute(text(stmt))
        self._ready = True

    def _vector(self, kb_id: str):
        from langchain_postgres import PGVector

        return PGVector(
            embeddings=self.embeddings,
            collection_name=collection_name(kb_id),
            connection=self.engine,
            embedding_length=config.embedding_dim(),
            use_jsonb=True,
        )

    def add_texts(self, kb_id: str, texts: List[str], source: str) -> int:
        validate_kb_id(kb_id)
        if not texts:
            return 0
        self.ensure_schema()
        # embed first: if embeddings are not configured nothing is half-written
        self._vector(kb_id).add_texts(texts, metadatas=[{"source": source} for _ in texts])
        from sqlalchemy import text

        with self.engine.begin() as conn:
            conn.execute(
                text("INSERT INTO kb_chunks (kb_id, source, content) VALUES (:kb, :src, :c)"),
                [{"kb": kb_id, "src": source, "c": t} for t in texts],
            )
        return len(texts)

    def vector_search(self, kb_id: str, query: str, k: int) -> List[Dict]:
        validate_kb_id(kb_id)
        self.ensure_schema()
        docs = self._vector(kb_id).similarity_search(query, k=k)
        return [
            {"content": d.page_content, "source": (d.metadata or {}).get("source", "")}
            for d in docs
        ]

    def keyword_search(self, kb_id: str, query: str, k: int) -> List[Dict]:
        validate_kb_id(kb_id)
        self.ensure_schema()
        from sqlalchemy import text

        with self.engine.connect() as conn:
            rows = conn.execute(text(KEYWORD_SQL), {"kb": kb_id, "q": query, "k": k}).fetchall()
        return [{"content": r.content, "source": r.source} for r in rows]
