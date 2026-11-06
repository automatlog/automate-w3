import pytest

from knowledge import chunking, config
from knowledge.errors import BadRequest
from knowledge.pii import mask_pii
from knowledge.retrieval import hybrid_search, reciprocal_rank_fusion
from knowledge.store import collection_name, validate_kb_id


def test_sanitize_and_split():
    assert chunking.sanitize_text("a’b​\x00c") == "a'bc"
    text = "Sentence number one. " * 200
    chunks = chunking.split_text(text, size=200, overlap=40)
    assert len(chunks) > 5
    assert all(len(c) <= 200 for c in chunks)


def test_split_defaults_from_env(monkeypatch):
    monkeypatch.setenv("CHUNK_SIZE", "100")
    monkeypatch.setenv("CHUNK_OVERLAP", "10")
    assert config.chunk_size() == 100
    assert all(len(c) <= 100 for c in chunking.split_text("word " * 200))


def test_pii_masking():
    out = mask_pii(
        "mail a.b@example.com or +1 415-555-2671, card 4111 1111 1111 1111, ip 10.0.0.1, ssn 123-45-6789"
    )
    assert "example.com" not in out and "415-555" not in out
    for label in ("<EMAIL>", "<CREDIT_CARD>", "<IP_ADDRESS>", "<SSN>", "<PHONE>"):
        assert label in out
    assert mask_pii("plain sentence") == "plain sentence"


def test_rrf_prefers_docs_in_both_lists():
    a, b, c = ({"content": x} for x in "abc")
    fused = reciprocal_rank_fusion({"vector": [a, b], "keyword": [c, b]})
    assert fused[0]["content"] == "b"
    assert {d["content"] for d in fused} == {"a", "b", "c"}


def test_rrf_skips_empty():
    assert reciprocal_rank_fusion({"v": [{"content": ""}, {}]}) == []


class FakeStore:
    def __init__(self, vec=(), kw=(), vec_exc=None):
        self.vec, self.kw, self.vec_exc = list(vec), list(kw), vec_exc

    def vector_search(self, kb, q, k):
        if self.vec_exc:
            raise self.vec_exc
        return self.vec[:k]

    def keyword_search(self, kb, q, k):
        return self.kw[:k]


def d(x):
    return {"content": x, "source": "s"}


def test_hybrid_fuses_and_limits():
    store = FakeStore([d("a"), d("b"), d("c")], [d("b"), d("z")])
    out = hybrid_search(store, "kb", "q", top_k=2)
    assert [x["content"] for x in out] == ["b", "a"]


def test_hybrid_keyword_survives_vector_failure():
    store = FakeStore(kw=[d("k")], vec_exc=RuntimeError("boom"))
    assert hybrid_search(store, "kb", "q", 3) == [d("k")]


def test_hybrid_raises_when_both_empty_and_vector_failed():
    with pytest.raises(RuntimeError):
        hybrid_search(FakeStore(vec_exc=RuntimeError("boom")), "kb", "q", 3)


def test_reranker_hook_used_only_when_given():
    store = FakeStore([d("a"), d("b")])
    out = hybrid_search(store, "kb", "q", 2, reranker=lambda q, docs, n: list(reversed(docs))[:n])
    assert out[0]["content"] == "b"


@pytest.mark.parametrize("bad", ["", "a b", "../x", "x" * 65, "a;drop", "kb/1"])
def test_kb_id_rejects(bad):
    with pytest.raises(BadRequest):
        validate_kb_id(bad)


def test_kb_id_ok():
    assert collection_name("shop_1-A") == "kb_shop_1-A"
