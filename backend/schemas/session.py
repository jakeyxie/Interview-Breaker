from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


class SessionCreateRequest(BaseModel):
    job_title: str = Field(..., min_length=1, max_length=160)
    resume: str = Field(default="", max_length=20000)
    jd_text: str = Field(default="", max_length=30000)
    jd_url: str = Field(default="", max_length=1024)
    interview_mode: Literal["easy", "pressure"] = "easy"
    question_time_limit_seconds: int = Field(default=300, ge=60, le=1800)


class SessionCreateResponse(BaseModel):
    session_id: str
    job_title: str
    status: str
    interview_mode: str
    jd_requirements: dict[str, Any] | None = None


class SessionListItem(BaseModel):
    session_id: str
    job_title: str
    status: str
    created_at: datetime
    updated_at: datetime
    last_message: str | None = None
    message_count: int = 0
    interview_mode: str = "easy"
    ended_at: datetime | None = None
    end_reason: str | None = None


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


class ResumeTextResponse(BaseModel):
    filename: str
    text: str


class SessionEndRequest(BaseModel):
    reason: Literal["abandoned", "manual"] = "manual"


class SessionEndResponse(BaseModel):
    session_id: str
    status: str
    end_reason: str
    ended_at: datetime


class ReportResponse(BaseModel):
    session_id: str
    report: dict[str, Any]
