from typing import Any
from datetime import datetime, timezone

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, status
from sqlalchemy import select

from agents.workflow import InterviewMessage, InterviewState, interview_graph
from models.database import Message, MessageRole, Session as InterviewSession, async_session_maker

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
        "awaiting_user": True,
        "round": len([message for message in history if message["role"] == "interviewer"]),
    }


async def _persist_message(session_id: str, role: MessageRole, content: str) -> None:
    async with async_session_maker() as db:
        try:
            db.add(Message(session_id=session_id, role=role, content=content))
            interview_session = await db.get(InterviewSession, session_id)
            if interview_session is not None:
                interview_session.updated_at = datetime.now(timezone.utc)
            await db.commit()
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
        await _persist_message(session_id, role, content)
        payload: dict[str, Any] = {
            "type": "agent_message",
            "node": node_name,
            "role": role.value,
            "content": content,
        }
        if role == MessageRole.STRATEGIST:
            payload["strategies"] = update.get("strategies", [])
        if role == MessageRole.ANALYZER:
            payload["intent"] = update.get("current_interviewer_intent", content)
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

            if event_type == "user_message":
                if not user_text:
                    await websocket.send_json({"type": "error", "message": "Message is empty."})
                    continue
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
