"""Answer client for the 0G Compute Router (OpenAI-compatible chat completions).

New work (ETHGlobal Mumbai). The Router adds an `x_0g_trace` object to every
response with `request_id`, `provider` (on-chain provider address) and billing;
see https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/features/chat-completions.md
The docs name no 0G-specific response headers, so request_id is taken from
x_0g_trace.request_id, falling back to the standard response `id`.
"""
from typing import Dict, List, Optional

from . import config
from .errors import NotConfigured, UpstreamError
from .pii import mask_pii

SYSTEM_PROMPT = (
    "You answer questions using only the context provided. "
    "If the context does not contain the answer, say you do not know. "
    "Be brief and plain."
)


def build_messages(question: str, contexts: List[str], history: Optional[List[Dict]] = None):
    context_block = "\n\n---\n\n".join(mask_pii(c) for c in contexts) or "(no context found)"
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    for turn in (history or [])[-10:]:
        role = turn.get("role")
        if role in ("user", "assistant") and turn.get("content"):
            messages.append({"role": role, "content": mask_pii(str(turn["content"]))})
    messages.append(
        {"role": "user", "content": f"Context:\n{context_block}\n\nQuestion: {mask_pii(question)}"}
    )
    return messages


def extract_request_id(resp) -> str:
    extra = getattr(resp, "model_extra", None) or {}
    trace = extra.get("x_0g_trace") or getattr(resp, "x_0g_trace", None)
    if isinstance(trace, dict) and trace.get("request_id"):
        return str(trace["request_id"])
    return str(getattr(resp, "id", "") or "")


def is_configured() -> bool:
    return bool(config.llm_api_key())


class RouterLLM:
    def __init__(self, client=None, model=None):
        self._client = client
        self.model = model or config.llm_model()

    def _get_client(self):
        if self._client is None:
            if not config.llm_api_key():
                raise NotConfigured("answer model not configured: set LLM_API_KEY")
            from openai import OpenAI

            self._client = OpenAI(base_url=config.llm_base_url(), api_key=config.llm_api_key())
        return self._client

    def answer(self, question: str, contexts: List[str], history: Optional[List[Dict]] = None) -> dict:
        client = self._get_client()
        try:
            resp = client.chat.completions.create(
                model=self.model, messages=build_messages(question, contexts, history)
            )
        except Exception as exc:
            raise UpstreamError(f"answer model request failed: {type(exc).__name__}") from exc
        text = (resp.choices[0].message.content or "").strip() if resp.choices else ""
        return {
            "answer": text,
            "model": getattr(resp, "model", None) or self.model,
            "provider": "0g-router",
            "request_id": extract_request_id(resp),
        }
