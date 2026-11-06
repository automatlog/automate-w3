"""OpenAI-compatible embeddings client.

New work (ETHGlobal Mumbai). Replaces MetaCortex's local HuggingFace embeddings
(metacortex_original/embeddings.py) with an API call. Implements the LangChain
Embeddings interface so PGVector can use it.
"""
from typing import List

from langchain_core.embeddings import Embeddings

from . import config
from .errors import NotConfigured, UpstreamError

BATCH_SIZE = 64


class ApiEmbeddings(Embeddings):
    def __init__(self, base_url=None, api_key=None, model=None, dim=None, client=None):
        self.base_url = base_url or config.embedding_base_url()
        self.api_key = api_key if api_key is not None else config.embedding_api_key()
        self.model = model or config.embedding_model()
        self.dim = dim or config.embedding_dim()
        self._client = client

    def _get_client(self):
        if self._client is None:
            if not self.api_key:
                raise NotConfigured("embeddings not configured: set EMBEDDING_API_KEY")
            from openai import OpenAI

            self._client = OpenAI(base_url=self.base_url, api_key=self.api_key)
        return self._client

    def embed_documents(self, texts: List[str]) -> List[List[float]]:
        client = self._get_client()
        out: List[List[float]] = []
        for i in range(0, len(texts), BATCH_SIZE):
            batch = texts[i : i + BATCH_SIZE]
            try:
                resp = client.embeddings.create(
                    model=self.model, input=batch, dimensions=self.dim
                )
            except NotConfigured:
                raise
            except Exception as exc:  # network / provider error, no key in message
                raise UpstreamError(f"embeddings request failed: {type(exc).__name__}") from exc
            out.extend([d.embedding for d in sorted(resp.data, key=lambda d: d.index)])
        return out

    def embed_query(self, text: str) -> List[float]:
        return self.embed_documents([text])[0]


def is_configured() -> bool:
    return bool(config.embedding_api_key())
