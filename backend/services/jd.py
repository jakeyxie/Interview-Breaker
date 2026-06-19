import json
import re
from typing import Any

import httpx
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

from core.config import get_settings


JD_ANALYZER_PROMPT = """你是招聘 JD 分析器。
请把岗位描述拆解成结构化 JSON，不能输出 Markdown。

输出格式：
{
  "hard_skills": ["硬技能要求"],
  "soft_skills": ["软素质要求"],
  "business_context": ["业务场景或行业关键词"],
  "must_probe": ["面试官必须追问的核心点"],
  "risk_signals": ["候选人回答中需要警惕的信号"]
}

要求：只基于 JD 原文，不要编造。"""


def _llm() -> ChatOpenAI:
    settings = get_settings()
    return ChatOpenAI(
        model=settings.openai_model,
        api_key=settings.openai_api_key,
        base_url=settings.openai_base_url,
        temperature=0.2,
    )


def strip_html(html: str, max_chars: int = 30000) -> str:
    text = re.sub(r"(?is)<(script|style).*?>.*?</\1>", " ", html)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()[:max_chars]


async def fetch_jd_url(url: str) -> str:
    if not url:
        return ""
    async with httpx.AsyncClient(timeout=12.0, follow_redirects=True) as client:
        response = await client.get(url)
        response.raise_for_status()
        return strip_html(response.text)


def fallback_requirements(jd_text: str) -> dict[str, Any]:
    keywords = re.findall(r"[A-Za-z][A-Za-z0-9+#.\-]{1,30}|[\u4e00-\u9fff]{2,12}", jd_text)
    seen: list[str] = []
    for keyword in keywords:
        if keyword not in seen:
            seen.append(keyword)
        if len(seen) >= 12:
            break
    return {
        "hard_skills": seen[:6],
        "soft_skills": [],
        "business_context": seen[6:9],
        "must_probe": seen[:5],
        "risk_signals": ["回答空泛", "缺少项目证据", "无法解释技术取舍"],
    }


async def analyze_jd(jd_text: str) -> dict[str, Any]:
    text = jd_text.strip()
    if not text:
        return {}
    try:
        response = await _llm().ainvoke(
            [
                SystemMessage(content=JD_ANALYZER_PROMPT),
                HumanMessage(content=f"JD 原文：\n{text[:30000]}"),
            ]
        )
        raw = str(response.content).strip()
        return json.loads(raw)
    except Exception:
        return fallback_requirements(text)
