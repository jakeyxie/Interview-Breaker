from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class SessionCreateRequest(BaseModel):
    job_title: str = Field(..., min_length=1, max_length=160)
    resume: str = Field(default="", max_length=20000)


class SessionCreateResponse(BaseModel):
    session_id: str
    job_title: str
    status: str


class SessionListItem(BaseModel):
    session_id: str
    job_title: str
    status: str
    created_at: datetime
    updated_at: datetime
    last_message: str | None = None
    message_count: int = 0


class MessageResponse(BaseModel):
    id: int
    session_id: str
    role: Literal["interviewer", "user", "analyzer", "strategist"]
    content: str
    timestamp: datetime

    model_config = {"from_attributes": True}


class StrategyCard(BaseModel):
    title: str
    stance: str
    content: str
