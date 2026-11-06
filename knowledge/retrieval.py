"""Hybrid retrieval: vector + keyword in parallel, fused with reciprocal rank fusion.

Adapted from MetaCortex retrieval.py (metacortex_original/retrieval.py): the RRF
function and the parallel hybrid flow are kept; the keyword search now lives on
the store, results are scoped to a knowledge base, and the cross-encoder
reranker is a disabled hook (no local model download). New work.
"""
from concurrent.futures import ThreadPoolExecutor
from typing import Callable, Dict, List, Optional

from . import config


def reciprocal_rank_fusion(results: Dict[str, List[dict]], k: int = 60) -> List[dict]:
    scores: Dict[str, dict] = {}
    for docs in results.values():
        for rank, doc in enumerate(docs):
            content = doc.get("content")
            if not content:
                continue
            entry = scores.setdefault(content, {"doc": doc, "score": 0.0})
            entry["score"] += 1.0 / (k + rank + 1)
    ordered = sorted(scores.values(), key=lambda e: e["score"], reverse=True)
    return [e["doc"] for e in ordered]


def hybrid_search(
    store,
    kb_id: str,
    query: str,
    top_k: Optional[int] = None,
    reranker: Optional[Callable[[str, List[dict], int], List[dict]]] = None,
) -> List[dict]:
    """reranker is a hook: pass a callable to enable one. Off by default."""
    top_k = top_k or config.top_k()
    with ThreadPoolExecutor(max_workers=2) as pool:
        fv = pool.submit(store.vector_search, kb_id, query, top_k * 2)
        fk = pool.submit(store.keyword_search, kb_id, query, top_k * 2)
        vector_err = None
        try:
            vector_docs = fv.result(timeout=30)
        except Exception as exc:
            vector_docs, vector_err = [], exc
        try:
            keyword_docs = fk.result(timeout=30)
        except Exception:
            keyword_docs = []
    if vector_err is not None and not keyword_docs:
        raise vector_err  # nothing from either side: surface the real reason
    fused = reciprocal_rank_fusion({"vector": vector_docs, "keyword": keyword_docs})
    if reranker is not None:
        return reranker(query, fused, top_k)
    return fused[:top_k]
