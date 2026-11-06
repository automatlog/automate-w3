"""Sanitize and split text.

Adapted from MetaCortex chunking.py (metacortex_original/chunking.py): kept
sanitize_text and the recursive character split; dropped semantic chunking and
parent/child splitting. Sizes come from config at call time. New work.
"""
import unicodedata
from typing import List

from langchain_text_splitters import RecursiveCharacterTextSplitter

from . import config

_REPLACEMENTS = {
    "●": "*", "•": "*", "–": "-", "—": "--",
    "‘": "'", "’": "'", "“": '"', "”": '"',
    "…": "...", " ": " ", "​": "", "﻿": "",
}


def sanitize_text(text: str) -> str:
    for old, new in _REPLACEMENTS.items():
        text = text.replace(old, new)
    return "".join(
        ch for ch in text
        if (not unicodedata.category(ch).startswith("C")) or ch in "\n\r\t"
    )


def split_text(text: str, size: int = None, overlap: int = None) -> List[str]:
    size = size or config.chunk_size()
    overlap = config.chunk_overlap() if overlap is None else overlap
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=size,
        chunk_overlap=min(overlap, size - 1),
        separators=["\n\n", "\n", ". ", " ", ""],
    )
    return [c for c in splitter.split_text(sanitize_text(text)) if c.strip()]
