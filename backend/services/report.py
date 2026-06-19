import json
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

from core.config import get_settings
from models.database import Message, Session


REPORT_PROMPT = """你是资深技术面试复盘教练。
请基于 JD、简历、完整面试记录生成中文 JSON 报告，不能输出 Markdown。

输出格式：
{
  "technical_fit": {
    "score": 0-100,
    "summary": "技术契合度总结",
    "fact_risks": ["哪些专业问题回答可能存在事实性错误或证据不足"]
  },
  "communication_structure": {
    "score": 0-100,
    "summary": "沟通结构性总结",
    "star_observations": ["是否使用 STAR 法则、是否有背景/任务/行动/结果"]
  },
  "emotional_stability": {
    "score": 0-100,
    "summary": "压力下情绪稳定性表现",
    "pressure_moments": ["面对压力追问时的具体表现"]
  },
  "improvement_plan": {
    "priorities": ["最优先补强方向"],
    "study_directions": ["针对暴露问题的充电方向"],
    "next_practice": ["下一次模拟建议"]
  },
  "overall_result": "pass / needs_practice / risky"
}

注意：如果没有权威检索证据，不要武断判定事实错误，应标记为“可能存在风险/证据不足”。"""


def _llm() -> ChatOpenAI:
    settings = get_settings()
    return ChatOpenAI(
        model=settings.openai_model,
        api_key=settings.openai_api_key,
        base_url=settings.openai_base_url,
        temperature=0.3,
    )


def _messages_text(messages: list[Message]) -> str:
    return "\n".join(f"{message.role.value}: {message.content}" for message in messages)


def fallback_report(session: Session, messages: list[Message]) -> dict[str, Any]:
    user_answers = [message.content for message in messages if message.role.value == "user"]
    return {
        "technical_fit": {
            "score": 60,
            "summary": "报告生成模型暂不可用，以下为基础复盘结果。",
            "fact_risks": ["尚未接入权威检索，无法完成严格事实核验。"],
        },
        "communication_structure": {
            "score": 60,
            "summary": "已记录候选人回答，可进一步检查是否包含背景、任务、行动和结果。",
            "star_observations": ["建议每个项目回答都补齐 STAR 四段结构。"],
        },
        "emotional_stability": {
            "score": 65,
            "summary": "当前仅基于文本长度和轮次做保守判断。",
            "pressure_moments": [f"共提交 {len(user_answers)} 次候选人回答。"],
        },
        "improvement_plan": {
            "priorities": ["补充项目证据", "强化技术细节解释", "练习结构化表达"],
            "study_directions": ["围绕 JD 硬技能补齐案例", "准备高压追问下的边界表达"],
            "next_practice": ["使用压力模式完成一轮限时回答。"],
        },
        "overall_result": "needs_practice",
    }


async def generate_report(session: Session, messages: list[Message]) -> dict[str, Any]:
    try:
        prompt = f"""岗位：{session.job_title}

面试模式：{session.interview_mode}

JD 拆解：
{session.jd_requirements_json or "未提供"}

JD 原文：
{session.jd_text[:8000] if session.jd_text else "未提供"}

简历：
{session.resume[:8000] if session.resume else "未提供"}

面试记录：
{_messages_text(messages)[-20000:]}
"""
        response = await _llm().ainvoke(
            [SystemMessage(content=REPORT_PROMPT), HumanMessage(content=prompt)]
        )
        return json.loads(str(response.content).strip())
    except Exception:
        return fallback_report(session, messages)
