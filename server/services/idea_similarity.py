"""Duplicate and related-work search for ideas: a plain local similarity search, no model, works offline.

Texts are cut into lowercase words, common words are dropped, and each candidate is scored against the
query with TF-IDF cosine similarity over all candidates, so words that appear everywhere count for little.
"""

import json
import math
import re
from collections import Counter
from typing import Any

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from models import DocsPage, DocsVersion, IdeaTicket, Ticket

_WORD = re.compile(r"[^\W_]{3,}", re.UNICODE)
_STOP = frozenset(
    "the and for are but not you all can her was one our out has have had this that with from they will "
    "would there their what about which when your how why who its into than then them been were being "
    "should could may might must also just like more most some such only over very".split()
)
MIN_SCORE = 0.2


def words(text: str) -> list[str]:
    """The words of a text that carry meaning: lowercase, at least 3 letters, no common words."""
    return [w for w in _WORD.findall(text.lower()) if w not in _STOP]


def _vector(tokens: list[str], idf: dict[str, float]) -> dict[str, float]:
    counts = Counter(tokens)
    return {w: (1 + math.log(c)) * idf.get(w, 1.0) for w, c in counts.items()}


def _cosine(a: dict[str, float], b: dict[str, float]) -> float:
    if not a or not b:
        return 0.0
    dot = sum(v * b.get(w, 0.0) for w, v in a.items())
    na = math.sqrt(sum(v * v for v in a.values()))
    nb = math.sqrt(sum(v * v for v in b.values()))
    return dot / (na * nb) if na and nb else 0.0


def rank(
    query: str, candidates: list[dict[str, Any]], min_score: float = MIN_SCORE
) -> list[dict[str, Any]]:
    """Score `candidates` ({"text": ..., ...}) against `query`; best first, without those below `min_score`.

    Each result is the candidate plus `score` (0 to 1, rounded to 2 places) and without `text`.
    """
    q_tokens = words(query)
    docs = [words(c["text"]) for c in candidates]
    n = len(docs) + 1
    df: Counter[str] = Counter()
    for tokens in [q_tokens, *docs]:
        df.update(set(tokens))
    idf = {w: math.log(1 + n / c) for w, c in df.items()}
    qv = _vector(q_tokens, idf)
    out = []
    for cand, tokens in zip(candidates, docs):
        score = _cosine(qv, _vector(tokens, idf))
        if score >= min_score:
            item = {k: v for k, v in cand.items() if k != "text"}
            item["score"] = round(score, 2)
            out.append(item)
    return sorted(out, key=lambda i: -i["score"])


async def find_similar(
    session: AsyncSession,
    text: str,
    exclude_idea_id: str | None = None,
    project_id: str | None = None,
    kinds: tuple[str, ...] = ("idea", "ticket", "doc"),
    limit: int = 5,
    min_score: float = MIN_SCORE,
) -> list[dict[str, Any]]:
    """Ideas, tickets and Docs that look like `text`.

    Args:
        text: The title and text of the new or open idea.
        exclude_idea_id: An idea to leave out (the one being looked at).
        project_id: Look at this project's tickets and Docs (ideas are searched in every project).
        kinds: Which of "idea", "ticket" and "doc" to search.
        limit: How many results to return.
        min_score: Lowest score (0 to 1) worth showing.

    Returns:
        [{kind, id, title, score, stage? (ideas), status? (tickets), project_id}] best first.
    """
    if not words(text):
        return []
    candidates: list[dict[str, Any]] = []
    if "idea" in kinds:
        for idea in (await session.exec(select(IdeaTicket))).all():
            if idea.id == exclude_idea_id or idea.merged_into_id:
                continue
            candidates.append(
                {
                    "kind": "idea",
                    "id": idea.id,
                    "title": idea.title,
                    "stage": idea.stage,
                    "project_id": idea.project_id,
                    "votes": len(idea.vote_records),
                    "text": f"{idea.title} {idea.title} {idea.body or idea.description} "
                    + " ".join(a.text for a in idea.assumption_records),
                }
            )
    if "ticket" in kinds:
        stmt = select(Ticket)
        if project_id:
            stmt = stmt.where(Ticket.project_id == project_id)
        for t in (await session.exec(stmt)).all():
            candidates.append(
                {
                    "kind": "ticket",
                    "id": t.id,
                    "title": t.title,
                    "status": t.status,
                    "project_id": t.project_id,
                    "text": f"{t.title} {t.title} {t.description}",
                }
            )
    if "doc" in kinds:
        pstmt = select(DocsPage).where(DocsPage.deleted_at.is_(None))
        if project_id:
            pstmt = pstmt.where(DocsPage.project_id == project_id)
        for page in (await session.exec(pstmt)).all():
            version = (
                await session.exec(
                    select(DocsVersion).where(
                        DocsVersion.page_id == page.id,
                        DocsVersion.version == page.version,
                    )
                )
            ).first()
            candidates.append(
                {
                    "kind": "doc",
                    "id": page.id,
                    "title": page.title,
                    "project_id": page.project_id,
                    "text": f"{page.title} {page.title} {version.markdown if version else ''}",
                }
            )
    return rank(text, candidates, min_score)[:limit]


async def suggest_tags(
    session: AsyncSession, text: str, exclude_idea_id: str | None = None
) -> list[str]:
    """Tags worth suggesting: the ones most used by the ideas and tickets that look like `text`."""
    similar = await find_similar(
        session,
        text,
        exclude_idea_id,
        kinds=("idea", "ticket"),
        limit=8,
        min_score=0.15,
    )
    counts: Counter[str] = Counter()
    for item in similar:
        model = IdeaTicket if item["kind"] == "idea" else Ticket
        row = await session.get(model, item["id"])
        try:
            tags = json.loads(row.tags) if row and row.tags else []
        except ValueError:
            tags = []
        counts.update(str(t) for t in tags if str(t) != "idea-test")
    return [t for t, _ in counts.most_common(5)]
