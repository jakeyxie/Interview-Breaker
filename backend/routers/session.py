import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from models.database import EndReason, Message, Session as InterviewSession, SessionStatus, get_async_session
from schemas.session import (
    MessageResponse,
    ReportResponse,
    ResumeTextResponse,
    SessionCreateRequest,
    SessionCreateResponse,
    SessionEndRequest,
    SessionEndResponse,
    SessionListItem,
)
from services.jd import analyze_jd, fetch_jd_url
from services.pdf import extract_pdf_text
from services.report import generate_report

router = APIRouter(prefix="/api/session", tags=["session"])


@router.post("/create", response_model=SessionCreateResponse, status_code=status.HTTP_201_CREATED)
async def create_session(
    payload: SessionCreateRequest,
    db: AsyncSession = Depends(get_async_session),
) -> SessionCreateResponse:
    try:
        jd_parts = [payload.jd_text.strip()]
        if payload.jd_url.strip():
            try:
                jd_parts.append(await fetch_jd_url(payload.jd_url.strip()))
            except Exception:
                jd_parts.append("")
        full_jd_text = "\n\n".join(part for part in jd_parts if part).strip()
        jd_requirements = await analyze_jd(full_jd_text) if full_jd_text else {}
        interview_session = InterviewSession(
            job_title=payload.job_title,
            resume=payload.resume,
            jd_text=full_jd_text,
            jd_url=payload.jd_url,
            jd_requirements_json=json.dumps(jd_requirements, ensure_ascii=False) if jd_requirements else "",
            interview_mode=payload.interview_mode,
            question_time_limit_seconds=payload.question_time_limit_seconds,
        )
        db.add(interview_session)
        await db.commit()
        await db.refresh(interview_session)
        return SessionCreateResponse(
            session_id=interview_session.session_id,
            job_title=interview_session.job_title,
            status=interview_session.status.value,
            interview_mode=interview_session.interview_mode,
            jd_requirements=jd_requirements or None,
        )
    except Exception as exc:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create interview session.",
        ) from exc


@router.post("/resume/upload", response_model=ResumeTextResponse)
async def upload_resume_pdf(file: UploadFile = File(...)) -> ResumeTextResponse:
    if file.content_type not in {"application/pdf", "application/octet-stream"}:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only PDF files are supported.")
    data = await file.read()
    if not data:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Uploaded file is empty.")
    try:
        text = extract_pdf_text(data)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Failed to extract text from PDF.",
        ) from exc
    return ResumeTextResponse(filename=file.filename or "resume.pdf", text=text)


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
                interview_mode=interview_session.interview_mode,
                ended_at=interview_session.ended_at,
                end_reason=interview_session.end_reason,
            )
        )

    return items


@router.post("/{session_id}/end", response_model=SessionEndResponse)
async def end_session(
    session_id: str,
    payload: SessionEndRequest,
    db: AsyncSession = Depends(get_async_session),
) -> SessionEndResponse:
    interview_session = await db.get(InterviewSession, session_id)
    if interview_session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found.")
    ended_at = datetime.now(timezone.utc)
    interview_session.status = SessionStatus.COMPLETED
    interview_session.ended_at = ended_at
    interview_session.end_reason = payload.reason
    interview_session.updated_at = ended_at
    await db.commit()
    await db.refresh(interview_session)
    return SessionEndResponse(
        session_id=interview_session.session_id,
        status=interview_session.status.value,
        end_reason=interview_session.end_reason or EndReason.MANUAL.value,
        ended_at=interview_session.ended_at or ended_at,
    )


@router.get("/{session_id}/report", response_model=ReportResponse)
async def get_report(
    session_id: str,
    db: AsyncSession = Depends(get_async_session),
) -> ReportResponse:
    interview_session = await db.get(InterviewSession, session_id)
    if interview_session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found.")
    if interview_session.final_report_json:
        return ReportResponse(
            session_id=session_id,
            report=json.loads(interview_session.final_report_json),
        )

    result = await db.execute(
        select(Message).where(Message.session_id == session_id).order_by(Message.timestamp, Message.id)
    )
    messages = list(result.scalars().all())
    report = await generate_report(interview_session, messages)
    interview_session.final_report_json = json.dumps(report, ensure_ascii=False)
    interview_session.updated_at = datetime.now(timezone.utc)
    if interview_session.status != SessionStatus.COMPLETED:
        interview_session.status = SessionStatus.COMPLETED
        interview_session.ended_at = datetime.now(timezone.utc)
        interview_session.end_reason = interview_session.end_reason or EndReason.MANUAL.value
    await db.commit()
    return ReportResponse(session_id=session_id, report=report)


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
