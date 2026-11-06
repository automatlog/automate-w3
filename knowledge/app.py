"""FastAPI app: the public knowledge service. New work (ETHGlobal Mumbai)."""
import hmac
from typing import Dict, List, Optional

from fastapi import Depends, FastAPI, File, Form, Header, Request, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from . import config
from .chunking import split_text
from .errors import BadRequest, KnowledgeError, Unauthorized
from .loader import extract_text
from .retrieval import hybrid_search
from .store import validate_kb_id

MAX_UPLOAD_BYTES = 10 * 1024 * 1024


class DocumentIn(BaseModel):
    text: str
    source: str = "text"


class AnswerIn(BaseModel):
    kb_id: str
    question: str
    history: Optional[List[Dict]] = None


def create_app(store=None, llm=None) -> FastAPI:
    """store / llm can be injected (tests do); otherwise built lazily from env."""
    app = FastAPI(title="Automate knowledge service")
    state = {"store": store, "llm": llm}

    def get_store():
        if state["store"] is None:
            from .embeddings import ApiEmbeddings
            from .store import PgStore

            state["store"] = PgStore(ApiEmbeddings())
        return state["store"]

    def get_llm():
        if state["llm"] is None:
            from .llm import RouterLLM

            state["llm"] = RouterLLM()
        return state["llm"]

    def require_token(authorization: Optional[str] = Header(default=None)):
        expected = config.api_token()
        if not expected:
            return
        given = ""
        if authorization and authorization.lower().startswith("bearer "):
            given = authorization[7:].strip()
        if not hmac.compare_digest(given.encode(), expected.encode()):
            raise Unauthorized()

    @app.exception_handler(KnowledgeError)
    async def on_error(_: Request, exc: KnowledgeError):
        return JSONResponse({"error": str(exc)}, status_code=exc.status)

    @app.get("/health")
    def health():
        return {"ok": True}

    @app.post("/kb/{kb_id}/documents", dependencies=[Depends(require_token)])
    async def add_document(
        kb_id: str,
        request: Request,
        file: Optional[UploadFile] = File(default=None),
        text: Optional[str] = Form(default=None),
        source: Optional[str] = Form(default=None),
    ):
        validate_kb_id(kb_id)
        if file is not None:
            data = await file.read()
            if len(data) > MAX_UPLOAD_BYTES:
                raise BadRequest("file is larger than 10 MB")
            body = extract_text(file.filename or "", data)
            src = source or file.filename or "upload"
        else:
            if text is None:  # JSON body
                try:
                    payload = DocumentIn(**(await request.json()))
                except Exception:
                    raise BadRequest("send JSON {text, source} or a pdf/txt/csv file")
                text, source = payload.text, payload.source
            if not text.strip():
                raise BadRequest("text is empty")
            body, src = text, source or "text"
        chunks = split_text(body)
        if not chunks:
            raise BadRequest("no text to store")
        added = get_store().add_texts(kb_id, chunks, src)
        return {"kb_id": kb_id, "source": src, "chunks": added}

    @app.get("/kb/{kb_id}/search", dependencies=[Depends(require_token)])
    def search(kb_id: str, q: str, k: Optional[int] = None):
        validate_kb_id(kb_id)
        if not q.strip():
            raise BadRequest("q is empty")
        k = max(1, min(k or config.top_k(), 20))
        hits = hybrid_search(get_store(), kb_id, q, k)
        return {"results": [{"content": h["content"], "source": h.get("source", "")} for h in hits]}

    @app.post("/ai/answer", dependencies=[Depends(require_token)])
    def answer(body: AnswerIn):
        validate_kb_id(body.kb_id)
        if not body.question.strip():
            raise BadRequest("question is empty")
        hits = hybrid_search(get_store(), body.kb_id, body.question, config.top_k())
        result = get_llm().answer(body.question, [h["content"] for h in hits], body.history)
        result["sources"] = [{"content": h["content"], "source": h.get("source", "")} for h in hits]
        return result

    return app


app = create_app()
