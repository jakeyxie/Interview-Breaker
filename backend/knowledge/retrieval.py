from typing import Any


class KnowledgeRetriever:
    """Second-phase extension point for authority search or local RAG."""

    async def search_authoritative_sources(self, query: str, *, domains: list[str] | None = None) -> list[dict[str, Any]]:
        return []

    async def search_local_knowledge(self, query: str) -> list[dict[str, Any]]:
        return []


knowledge_retriever = KnowledgeRetriever()
