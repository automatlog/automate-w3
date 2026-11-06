"""PII masking before text goes to the LLM.

Adapted from MetaCortex pii.py (metacortex_original/pii.py): same regex idea,
reordered so the longer card/SSN patterns run before the phone pattern. New work.
"""
import re

PATTERNS = {
    "EMAIL": r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b",
    "CREDIT_CARD": r"\b(?:\d{4}[- ]?){3}\d{4}\b",
    "SSN": r"\b\d{3}-\d{2}-\d{4}\b",
    "IP_ADDRESS": r"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b",
    "PHONE": r"(?<!\w)(?:\+\d{1,3}[\s.-]?)?\(?\d{3,5}\)?[\s.-]?\d{3}[\s.-]?\d{3,4}(?!\w)",
}


def mask_pii(text: str) -> str:
    for label, pattern in PATTERNS.items():
        text = re.sub(pattern, f"<{label}>", text)
    return text
