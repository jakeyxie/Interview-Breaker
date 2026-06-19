from typing import Any
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, status
from sqlalchemy import select

from agents.workflow import InterviewMessage, InterviewState, interview_graph
from models.database import (
    EndReason,
    Message,
    MessageRole,
    Session as InterviewSession,
    SessionStatus,
    async_session_maker,
)

router = APIRouter(tags=["chat"])


async def _load_state(session: InterviewSession) -> InterviewState:
    async with async_session_maker() as db:
        result = await db.execute(
            select(Message)
            .where(Message.session_id == session.session_id)
            .order_by(Message.timestamp, Message.id)
        )
        history: list[InterviewMessage] = [
            {"role": message.role.value, "content": message.content}
            for message in result.scalars().all()
        ]
    return {
        "messages": history,
        "job_title": session.job_title,
        "resume": session.resume,
        "jd_requirements": session.jd_requirements_json,
        "interview_mode": session.interview_mode,
        "awaiting_user": True,
        "round": len([message for message in history if message["role"] == "interviewer"]),
    }


async def _persist_message(session_id: str, role: MessageRole, content: str) -> str | None:
    async with async_session_maker() as db:
        try:
            db.add(Message(session_id=session_id, role=role, content=content))
            interview_session = await db.get(InterviewSession, session_id)
            deadline_at: str | None = None
            if interview_session is not None:
                interview_session.updated_at = datetime.now(timezone.utc)
                if role == MessageRole.INTERVIEWER and interview_session.interview_mode == "pressure":
                    interview_session.deadline_at = datetime.now(timezone.utc) + timedelta(
                        seconds=interview_session.question_time_limit_seconds
                    )
                deadline_at = interview_session.deadline_at.isoformat() if interview_session.deadline_at else None
            await db.commit()
            return deadline_at
        except Exception:
            await db.rollback()
            raise


async def _has_unanswered_interviewer_question(session_id: str) -> bool:
    async with async_session_maker() as db:
        latest_interviewer_result = await db.execute(
            select(Message)
            .where(Message.session_id == session_id, Message.role == MessageRole.INTERVIEWER)
            .order_by(Message.id.desc())
            .limit(1)
        )
        latest_interviewer = latest_interviewer_result.scalar_one_or_none()
        if latest_interviewer is None:
            return False

        latest_user_result = await db.execute(
            select(Message)
            .where(Message.session_id == session_id, Message.role == MessageRole.USER)
            .order_by(Message.id.desc())
            .limit(1)
        )
        latest_user = latest_user_result.scalar_one_or_none()
        return latest_user is None or latest_user.id < latest_interviewer.id


async def _message_count(session_id: str) -> int:
    async with async_session_maker() as db:
        result = await db.execute(select(Message.id).where(Message.session_id == session_id).limit(1))
        return 1 if result.scalar_one_or_none() is not None else 0


async def _end_session(session_id: str, reason: str) -> None:
    async with async_session_maker() as db:
        interview_session = await db.get(InterviewSession, session_id)
        if interview_session is None:
            return
        now = datetime.now(timezone.utc)
        interview_session.status = SessionStatus.COMPLETED
        interview_session.ended_at = now
        interview_session.end_reason = reason
        interview_session.updated_at = now
        await db.commit()


def _is_older_than_two_hours(session: InterviewSession) -> bool:
    created_at = session.created_at
    if created_at.tzinfo is None:
        created_at = created_at.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc) - created_at >= timedelta(hours=2)


def _is_pass_message(content: str) -> bool:
    return content.strip().startswith("【通过】")


def _is_question_deadline_expired(session: InterviewSession) -> bool:
    if session.interview_mode != "pressure" or session.deadline_at is None:
        return False
    deadline_at = session.deadline_at
    if deadline_at.tzinfo is None:
        deadline_at = deadline_at.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc) > deadline_at


def _role_from_value(value: str) -> MessageRole | None:
    try:
        return MessageRole(value)
    except ValueError:
        return None


async def _emit_agent_update(
    websocket: WebSocket,
    session_id: str,
    node_name: str,
    update: dict[str, Any],
) -> None:
    for message in update.get("messages", []):
        role = _role_from_value(message.get("role", ""))
        content = str(message.get("content", "")).strip()
        if role is None or not content:
            continue
        deadline_at = await _persist_message(session_id, role, content)
        payload: dict[str, Any] = {
            "type": "agent_message",
            "node": node_name,
            "role": role.value,
            "content": content,
        }
        if deadline_at:
            payload["deadline_at"] = deadline_at
        if role == MessageRole.STRATEGIST:
            payload["strategies"] = update.get("strategies", [])
        if role == MessageRole.ANALYZER:
            payload["intent"] = update.get("current_interviewer_intent", content)
        if role == MessageRole.INTERVIEWER and _is_pass_message(content):
            await _end_session(session_id, EndReason.PASSED.value)
            payload["ended"] = True
            payload["end_reason"] = EndReason.PASSED.value
        await websocket.send_json(payload)


@router.websocket("/ws/chat/{session_id}")
async def chat_websocket(websocket: WebSocket, session_id: str) -> None:
    await websocket.accept()

    async with async_session_maker() as db:
        session = await db.get(InterviewSession, session_id)

    if session is None:
        await websocket.send_json({"type": "error", "message": "Session not found."})
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    await websocket.send_json(
        {
            "type": "connected",
            "session_id": session.session_id,
            "job_title": session.job_title,
            "interview_mode": session.interview_mode,
            "deadline_at": session.deadline_at.isoformat() if session.deadline_at else None,
            "status": session.status.value,
        }
    )

    try:
        while True:
            incoming = await websocket.receive_json()
            event_type = incoming.get("type", "user_message")
            user_text = str(incoming.get("content", "")).strip()

            if event_type == "close":
                await websocket.close()
                return
            if event_type == "end_interview":
                await _end_session(session_id, EndReason.ABANDONED.value)
                await websocket.send_json({"type": "interview_ended", "reason": EndReason.ABANDONED.value})
                continue

            async with async_session_maker() as db:
                session = await db.get(InterviewSession, session_id)
            if session is None or session.status == SessionStatus.COMPLETED:
                await websocket.send_json(
                    {"type": "interview_ended", "reason": session.end_reason if session else "missing"}
                )
                continue
            if _is_older_than_two_hours(session):
                await _end_session(session_id, EndReason.TIME_LIMIT.value)
                await websocket.send_json({"type": "interview_ended", "reason": EndReason.TIME_LIMIT.value})
                continue

            if event_type == "user_message":
                if not user_text:
                    await websocket.send_json({"type": "error", "message": "Message is empty."})
                    continue
                if _is_question_deadline_expired(session):
                    user_text = f"【超时提交】{user_text}"
                    await websocket.send_json(
                        {
                            "type": "time_warning",
                            "message": "本题已超过压力模式限定时间，回答将被标记为超时提交。",
                        }
                    )
                await _persist_message(session_id, MessageRole.USER, user_text)
                await websocket.send_json(
                    {"type": "user_message", "role": "user", "content": user_text}
                )
            elif event_type != "start":
                await websocket.send_json({"type": "error", "message": "Unsupported event type."})
                continue
            elif await _has_unanswered_interviewer_question(session_id):
                await websocket.send_json({"type": "agent_status", "status": "waiting_user_choice"})
                continue
            elif await _message_count(session_id) > 0:
                await websocket.send_json({"type": "agent_status", "status": "waiting_user_choice"})
                continue

            state = await _load_state(session)
            await websocket.send_json({"type": "agent_status", "status": "thinking"})

            async for chunk in interview_graph.astream(state, stream_mode="updates"):
                for node_name, update in chunk.items():
                    await _emit_agent_update(websocket, session_id, node_name, update)

            await websocket.send_json({"type": "agent_status", "status": "waiting_user"})
    except WebSocketDisconnect:
        return
    except Exception as exc:
        await websocket.send_json({"type": "error", "message": "Agent workflow failed."})
        await websocket.close(code=status.WS_1011_INTERNAL_ERROR, reason=str(exc)[:120])
