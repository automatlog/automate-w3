from types import SimpleNamespace

import pytest

from knowledge.embeddings import ApiEmbeddings
from knowledge.errors import NotConfigured
from knowledge.llm import RouterLLM, build_messages, extract_request_id


class FakeEmb:
    def __init__(self):
        self.calls = []
        self.embeddings = self

    def create(self, model, input, dimensions):
        self.calls.append((model, len(input), dimensions))
        data = [SimpleNamespace(index=i, embedding=[float(i)] * 3) for i in reversed(range(len(input)))]
        return SimpleNamespace(data=data)


def test_embeddings_batch_and_order():
    c = FakeEmb()
    e = ApiEmbeddings(model="m", dim=3, client=c)
    out = e.embed_documents([str(i) for i in range(130)])
    assert len(out) == 130 and [x[0] for x in out[:3]] == [0.0, 1.0, 2.0]
    assert [n for _, n, _ in c.calls] == [64, 64, 2]
    assert c.calls[0][2] == 3


def test_embeddings_not_configured(monkeypatch):
    monkeypatch.delenv("EMBEDDING_API_KEY", raising=False)
    with pytest.raises(NotConfigured):
        ApiEmbeddings().embed_query("x")


class Resp:
    def __init__(self, extra=None):
        self.id = "chatcmpl-1"
        self.model = "glm-5.2"
        self.model_extra = extra or {}
        self.choices = [SimpleNamespace(message=SimpleNamespace(content=" hi "))]


class FakeChat:
    def __init__(self, resp):
        self.resp, self.kwargs = resp, None
        self.chat = SimpleNamespace(completions=self)

    def create(self, **kw):
        self.kwargs = kw
        return self.resp


def test_request_id_prefers_trace():
    assert extract_request_id(Resp({"x_0g_trace": {"request_id": "r-9"}})) == "r-9"
    assert extract_request_id(Resp()) == "chatcmpl-1"


def test_answer_shape_and_pii_masked():
    client = FakeChat(Resp({"x_0g_trace": {"request_id": "r-9"}}))
    out = RouterLLM(client=client).answer(
        "who is a@b.com?", ["call 10.0.0.1"], [{"role": "user", "content": "hello"}]
    )
    assert out == {"answer": "hi", "model": "glm-5.2", "provider": "0g-router", "request_id": "r-9"}
    sent = " ".join(m["content"] for m in client.kwargs["messages"])
    assert "a@b.com" not in sent and "10.0.0.1" not in sent


def test_history_roles_filtered():
    msgs = build_messages("q", [], [{"role": "system", "content": "evil"}, {"role": "user", "content": "ok"}])
    assert [m["role"] for m in msgs] == ["system", "user", "user"]


def test_llm_not_configured(monkeypatch):
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    with pytest.raises(NotConfigured):
        RouterLLM().answer("q", [])
