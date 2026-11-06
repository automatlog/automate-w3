"""Settings, read from the environment each time they are asked for.

New work (ETHGlobal Mumbai). Replaces MetaCortex's config module, which is not
copied. Keys are never printed or logged.
"""
import os

DEFAULT_EMBEDDING_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"
DEFAULT_EMBEDDING_MODEL = "gemini-embedding-001"
DEFAULT_EMBEDDING_DIM = 3072  # gemini-embedding-001 default; lower it only if the endpoint honours `dimensions`
DEFAULT_LLM_BASE_URL = "https://router-api.0g.ai/v1"
DEFAULT_LLM_MODEL = "glm-5.2"
DEFAULT_DATABASE_URL = "postgresql+psycopg://knowledge:knowledge@localhost:5433/knowledge"


def _get(name: str, default: str = "") -> str:
    value = os.getenv(name)
    return value.strip() if value and value.strip() else default


def _int(name: str, default: int) -> int:
    try:
        return int(_get(name, str(default)))
    except ValueError:
        return default


def database_url() -> str:
    return _get("DATABASE_URL", DEFAULT_DATABASE_URL)


def embedding_base_url() -> str:
    return _get("EMBEDDING_BASE_URL", DEFAULT_EMBEDDING_BASE_URL)


def embedding_api_key() -> str:
    return _get("EMBEDDING_API_KEY")


def embedding_model() -> str:
    return _get("EMBEDDING_MODEL", DEFAULT_EMBEDDING_MODEL)


def embedding_dim() -> int:
    return _int("EMBEDDING_DIM", DEFAULT_EMBEDDING_DIM)


def llm_base_url() -> str:
    return _get("LLM_BASE_URL", DEFAULT_LLM_BASE_URL)


def llm_api_key() -> str:
    return _get("LLM_API_KEY")


def llm_model() -> str:
    return _get("LLM_MODEL", DEFAULT_LLM_MODEL)


def chunk_size() -> int:
    return _int("CHUNK_SIZE", 700)


def chunk_overlap() -> int:
    return _int("CHUNK_OVERLAP", 120)


def top_k() -> int:
    return _int("TOP_K", 4)


def api_token() -> str:
    return _get("KNOWLEDGE_API_TOKEN")
