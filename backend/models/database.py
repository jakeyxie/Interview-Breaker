from collections.abc import AsyncGenerator
from datetime import datetime
from enum import StrEnum
from uuid import uuid4

from sqlalchemy import DateTime, Enum, ForeignKey, Integer, String, Text, func, text
from sqlalchemy.ext.asyncio import AsyncAttrs, AsyncSession as AsyncDbSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

from core.config import get_settings


class Base(AsyncAttrs, DeclarativeBase):
    pass


class SessionStatus(StrEnum):
    ACTIVE = "active"
    COMPLETED = "completed"
    ARCHIVED = "archived"


class InterviewMode(StrEnum):
    EASY = "easy"
    PRESSURE = "pressure"


class EndReason(StrEnum):
    PASSED = "passed"
    TIME_LIMIT = "time_limit"
    ABANDONED = "abandoned"
    MANUAL = "manual"


class MessageRole(StrEnum):
    INTERVIEWER = "interviewer"
    USER = "user"
    ANALYZER = "analyzer"
    STRATEGIST = "strategist"


class Session(Base):
    __tablename__ = "sessions"

    session_id: Mapped[str] = mapped_column(
        String(36),
        primary_key=True,
        default=lambda: str(uuid4()),
    )
    job_title: Mapped[str] = mapped_column(String(160), nullable=False, index=True)
    resume: Mapped[str] = mapped_column(Text, default="", nullable=False)
    resume_filename: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    jd_text: Mapped[str] = mapped_column(Text, default="", nullable=False)
    jd_url: Mapped[str] = mapped_column(String(1024), default="", nullable=False)
    jd_requirements_json: Mapped[str] = mapped_column(Text, default="", nullable=False)
    interview_mode: Mapped[str] = mapped_column(
        String(16),
        default=InterviewMode.EASY.value,
        nullable=False,
        index=True,
    )
    question_time_limit_seconds: Mapped[int] = mapped_column(Integer, default=300, nullable=False)
    deadline_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    end_reason: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    final_report_json: Mapped[str] = mapped_column(Text, default="", nullable=False)
    status: Mapped[SessionStatus] = mapped_column(
        Enum(SessionStatus),
        default=SessionStatus.ACTIVE,
        nullable=False,
        index=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    messages: Mapped[list["Message"]] = relationship(
        back_populates="session",
        cascade="all, delete-orphan",
        lazy="selectin",
    )


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    session_id: Mapped[str] = mapped_column(
        ForeignKey("sessions.session_id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    role: Mapped[MessageRole] = mapped_column(Enum(MessageRole), nullable=False, index=True)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    timestamp: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
        index=True,
    )

    session: Mapped[Session] = relationship(back_populates="messages")


settings = get_settings()
engine = create_async_engine(settings.database_url, echo=settings.app_env == "development")
async_session_maker = async_sessionmaker(engine, expire_on_commit=False)


async def init_db() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        result = await conn.execute(text("PRAGMA table_info(sessions)"))
        existing_columns = {row[1] for row in result.fetchall()}
        column_defs = {
            "resume_filename": "TEXT NOT NULL DEFAULT ''",
            "jd_text": "TEXT NOT NULL DEFAULT ''",
            "jd_url": "TEXT NOT NULL DEFAULT ''",
            "jd_requirements_json": "TEXT NOT NULL DEFAULT ''",
            "interview_mode": "VARCHAR(8) NOT NULL DEFAULT 'easy'",
            "question_time_limit_seconds": "INTEGER NOT NULL DEFAULT 300",
            "deadline_at": "DATETIME",
            "ended_at": "DATETIME",
            "end_reason": "VARCHAR(16)",
            "final_report_json": "TEXT NOT NULL DEFAULT ''",
        }
        for column_name, column_def in column_defs.items():
            if column_name not in existing_columns:
                await conn.execute(text(f"ALTER TABLE sessions ADD COLUMN {column_name} {column_def}"))


async def get_async_session() -> AsyncGenerator[AsyncDbSession, None]:
    async with async_session_maker() as session:
        try:
            yield session
        finally:
            await session.close()
