from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from models.database import Message, Session as InterviewSession, get_async_session
from schemas.session import MessageResponse, SessionCreateRequest, SessionCreateResponse, SessionListItem

router = APIRouter(prefix="/api/session", tags=["session"])


@router.post("/create", response_model=SessionCreateResponse, status_code=status.HTTP_201_CREATED)
async def create_session(
    payload: SessionCreateRequest,
    db: AsyncSession = Depends(get_async_session),
) -> SessionCreateResponse:
    try:
        interview_session = InterviewSession(job_title=payload.job_title, resume=payload.resume)
        db.add(interview_session)
        await db.commit()
        await db.refresh(interview_session)
        return SessionCreateResponse(
            session_id=interview_session.session_id,
            job_title=interview_session.job_title,
            status=interview_session.status.value,
        )
    except Exception as exc:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create interview session.",
        ) from exc


@router.get("/list", response_model=list[SessionListItem])
async def list_sessions(
    db: AsyncSession = Depends(get_async_session),
) -> list[SessionListItem]:
    result = await db.execute(
        select(InterviewSession).order_by(InterviewSession.updated_at.desc(), InterviewSession.created_at.desc())
    )
    sessions = list(result.scalars().all())
    items: list[SessionListItem] = []

    for interview_session in sessions:
        latest_result = await db.execute(
            select(Message)
            .where(Message.session_id == interview_session.session_id)
            .order_by(Message.timestamp.desc(), Message.id.desc())
            .limit(1)
        )
        latest_message = latest_result.scalar_one_or_none()
        count_result = await db.execute(
            select(func.count(Message.id)).where(Message.session_id == interview_session.session_id)
        )
        message_count = int(count_result.scalar_one())
        items.append(
            SessionListItem(
                session_id=interview_session.session_id,
                job_title=interview_session.job_title,
                status=interview_session.status.value,
                created_at=interview_session.created_at,
                updated_at=interview_session.updated_at,
                last_message=latest_message.content[:120] if latest_message else None,
                message_count=message_count,
            )
        )

    return items


@router.get("/{session_id}/messages", response_model=list[MessageResponse])
async def list_messages(
    session_id: str,
    db: AsyncSession = Depends(get_async_session),
) -> list[Message]:
    interview_session = await db.get(InterviewSession, session_id)
    if interview_session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found.")

    result = await db.execute(
        select(Message).where(Message.session_id == session_id).order_by(Message.timestamp, Message.id)
    )
    return list(result.scalars().all())
