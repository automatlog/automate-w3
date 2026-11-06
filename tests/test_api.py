import pytest
from fastapi.testclient import TestClient

from knowledge.app import create_app
from knowledge.errors import NotConfigured


class FakeStore:
    def __init__(self):
        self.added = []
        self.fail_embed = False

    def add_texts(self, kb, texts, source):
        if self.fail_embed:
            raise NotConfigured("embeddings not configured: set EMBEDDING_API_KEY")
        self.added.append((kb, texts, source))
        return len(texts)

    def vector_search(self, kb, q, k):
        if self.fail_embed:
            raise NotConfigured("embeddings not configured: set EMBEDDING_API_KEY")
        return [{"content": "Refunds take 5 days.", "source": "faq"}]

    def keyword_search(self, kb, q, k):
        if self.fail_embed:
            return []
        return [{"content": "Shipping is free.", "source": "faq"}]


class FakeLLM:
    def answer(self, question, contexts, history=None):
        return {"answer": "5 days", "model": "glm-5.2", "provider": "0g-router", "request_id": "r1"}


@pytest.fixture
def store():
    return FakeStore()


@pytest.fixture
def client(store, monkeypatch):
    monkeypatch.delenv("KNOWLEDGE_API_TOKEN", raising=False)
    return TestClient(create_app(store=store, llm=FakeLLM()))


def test_health(client):
    assert client.get("/health").json() == {"ok": True}


def test_add_json_document(client, store):
    r = client.post("/kb/shop1/documents", json={"text": "Refunds take 5 days. " * 100, "source": "faq"})
    assert r.status_code == 200 and r.json()["chunks"] > 1
    assert store.added[0][0] == "shop1" and store.added[0][2] == "faq"


def test_add_txt_file(client, store):
    r = client.post("/kb/shop1/documents", files={"file": ("notes.txt", b"hello world " * 50, "text/plain")})
    assert r.status_code == 200 and r.json()["source"] == "notes.txt"


def test_bad_file_type_and_empty(client):
    assert client.post("/kb/k/documents", files={"file": ("a.exe", b"x")}).status_code == 400
    assert client.post("/kb/k/documents", json={"text": "  "}).status_code == 400
    assert client.post("/kb/k/documents", content=b"nope").status_code == 400


def test_bad_kb_id(client):
    assert client.get("/kb/bad id/search", params={"q": "x"}).status_code == 400
    assert client.post("/kb/a.b/documents", json={"text": "x"}).status_code == 400
    assert client.post("/ai/answer", json={"kb_id": "a b", "question": "x"}).status_code == 400


def test_search(client):
    r = client.get("/kb/shop1/search", params={"q": "refund", "k": 2})
    assert r.status_code == 200
    assert {x["content"] for x in r.json()["results"]} == {"Refunds take 5 days.", "Shipping is free."}


def test_answer(client):
    r = client.post("/ai/answer", json={"kb_id": "shop1", "question": "refund time?", "history": []})
    body = r.json()
    assert r.status_code == 200
    assert body["answer"] == "5 days" and body["provider"] == "0g-router" and body["request_id"] == "r1"
    assert body["sources"][0]["source"] == "faq"


def test_embeddings_not_configured_is_503(client, store):
    store.fail_embed = True
    r = client.post("/kb/k/documents", json={"text": "hello"})
    assert r.status_code == 503 and "embeddings not configured" in r.json()["error"]
    assert client.post("/ai/answer", json={"kb_id": "k", "question": "q"}).status_code == 503


def test_auth_token(store, monkeypatch):
    monkeypatch.setenv("KNOWLEDGE_API_TOKEN", "s3cret")
    c = TestClient(create_app(store=store, llm=FakeLLM()))
    assert c.get("/health").status_code == 200
    q = {"q": "x"}
    assert c.get("/kb/k/search", params=q).status_code == 401
    assert c.get("/kb/k/search", params=q, headers={"Authorization": "Bearer nope"}).status_code == 401
    assert c.get("/kb/k/search", params=q, headers={"Authorization": "Basic s3cret"}).status_code == 401
    assert c.get("/kb/k/search", params=q, headers={"Authorization": "Bearer s3cret"}).status_code == 200
    assert c.post("/ai/answer", json={"kb_id": "k", "question": "q"}).status_code == 401
