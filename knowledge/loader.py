"""Turn an uploaded pdf / txt / csv into text.

Adapted from MetaCortex document_loader.py (metacortex_original/document_loader.py),
trimmed to bytes in, text out. New work.
"""
import io

from .errors import BadRequest


def extract_text(filename: str, data: bytes) -> str:
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext in ("txt", "csv"):
        text = data.decode("utf-8", errors="ignore")
    elif ext == "pdf":
        from pypdf import PdfReader

        try:
            reader = PdfReader(io.BytesIO(data))
            text = "\n".join((p.extract_text() or "") for p in reader.pages)
        except Exception:
            raise BadRequest("could not read that PDF")
    else:
        raise BadRequest("only pdf, txt and csv files are supported")
    if not text.strip():
        raise BadRequest("no text found in that file")
    return text
