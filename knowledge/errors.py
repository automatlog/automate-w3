"""Plain-word errors the API turns into HTTP statuses. New work."""


class KnowledgeError(Exception):
    status = 500


class NotConfigured(KnowledgeError):
    status = 503


class BadRequest(KnowledgeError):
    status = 400


class UpstreamError(KnowledgeError):
    status = 502


class Unauthorized(KnowledgeError):
    status = 401

    def __init__(self):
        super().__init__('missing or wrong bearer token')
