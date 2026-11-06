"""Plain-word errors the API turns into HTTP statuses. New work."""


class KnowledgeError(Exception):
    status = 500


class NotConfigured(KnowledgeError):
    status = 503


class BadRequest(KnowledgeError):
    status = 400


class UpstreamError(KnowledgeError):
    status = 502
