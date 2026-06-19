import json
import operator
from typing import Annotated, Any, Literal, TypedDict

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI
from langgraph.graph import END, START, StateGraph

from core.config import get_settings


AgentRole = Literal["interviewer", "user", "analyzer", "strategist"]


class InterviewMessage(TypedDict):
    role: AgentRole
    content: str


class Strategy(TypedDict):
    title: str
    stance: str
    content: str


class InterviewState(TypedDict, total=False):
    messages: Annotated[list[InterviewMessage], operator.add]
    job_title: str
    resume: str
    current_interviewer_intent: str
    strategies: list[Strategy]
    awaiting_user: bool
    round: int
    jd_requirements: str
    interview_mode: str


INTERVIEWER_SYSTEM_PROMPT = """你是 Agent C，代号 Interviewer。
你扮演一名经验丰富但压迫感很强的 HR 或技术主管，正在进行真实的压力面试。

行为准则：
1. 阅读候选人的岗位目标和简历，根据候选者的学习年限或者工作年限围绕经历真实性、能力边界、薪资动机、稳定性和抗压性提问。
2. 如果提供了 JD 拆解，你必须围绕 JD 的硬技能、软素质和核心诉求提问，不要泛泛而谈。
3. 语气专业、锐利、克制，不侮辱、不歧视、不输出违法或人身攻击内容。
4. 如果用户刚回答过问题，先用一句话指出其回答中的风险点，再提出下一问。
5. 不要给建议，不要暴露你是 AI，不要解释你的评分标准。
6. 每轮只输出一个主要问题，可以附带一句追问或压力提示。
7. 如果你判断候选人已经充分达到岗位要求，请以“【通过】”开头，并用一句话结束面试。

输出格式：直接输出面试官会说的话。"""


ANALYZER_SYSTEM_PROMPT = """你是 Agent A，代号 Analyzer，旁观者视角的“潜台词雷达”。
你的任务是拆解面试官刚刚的问题，帮助候选人看见真实考察意图和潜在陷阱。

请用中文输出，结构固定：
【真实意图】一句话说明面试官真正想验证什么。
【潜在陷阱】列出 2-3 个候选人容易踩坑的点。
【风险等级】低 / 中 / 高，并给出一句理由。
【应对原则】给出 2 条高情商作答原则。

要求：精准、冷静、短句，不替候选人正式作答。"""


STRATEGIST_SYSTEM_PROMPT = """你是 Agent B，代号 Strategist，候选人的面试军师。
你要基于最新的面试官问题，以及可用的潜台词分析，为候选人生成 3 个不同维度的回复建议。

请严格输出 JSON，不能添加 Markdown，格式如下：
{
  "strategies": [
    {"title": "保守安全", "stance": "稳健解释，降低风险", "content": "可直接参考的中文回复"},
    {"title": "高情商婉拒", "stance": "守住边界，避免硬碰硬", "content": "可直接参考的中文回复"},
    {"title": "专业反杀", "stance": "展示判断力，并反向澄清标准", "content": "可直接参考的中文回复"}
  ]
}

要求：
1. 每条 content 控制在 80-160 字。
2. 回复要像真实候选人说的话，不要像培训讲义。
3. 可以承认不足，但必须给出补救动作、证据或边界。
4. 不要编造简历里没有的事实。"""


def _llm() -> ChatOpenAI:
    settings = get_settings()
    return ChatOpenAI(
        model=settings.openai_model,
        api_key=settings.openai_api_key,
        base_url=settings.openai_base_url,
        temperature=0.7,
    )


def _conversation_text(state: InterviewState) -> str:
    lines: list[str] = []
    for message in state.get("messages", [])[-16:]:
        lines.append(f"{message['role']}: {message['content']}")
    return "\n".join(lines) if lines else "尚未开始对话。"


def _last_interviewer_question(state: InterviewState) -> str:
    for message in reversed(state.get("messages", [])):
        if message["role"] == "interviewer":
            return message["content"]
    return ""


async def interviewer_node(state: InterviewState) -> dict[str, Any]:
    prompt = f"""岗位目标：{state.get("job_title", "未指定")}

面试模式：{state.get("interview_mode", "easy")}

JD 拆解：
{state.get("jd_requirements") or "未提供，请主要基于岗位目标和简历提问。"}

候选人简历：
{state.get("resume") or "候选人暂未提供简历。"}

最近对话：
{_conversation_text(state)}

请生成本轮压力面试问题。"""
    response = await _llm().ainvoke(
        [SystemMessage(content=INTERVIEWER_SYSTEM_PROMPT), HumanMessage(content=prompt)]
    )
    content = str(response.content).strip()
    return {
        "messages": [{"role": "interviewer", "content": content}],
        "awaiting_user": False,
        "round": int(state.get("round", 0)) + 1,
    }


async def analyzer_node(state: InterviewState) -> dict[str, Any]:
    question = _last_interviewer_question(state)
    prompt = f"""最新面试官问题：
{question}

上下文：
{_conversation_text(state)}

请输出潜台词分析。"""
    response = await _llm().ainvoke(
        [SystemMessage(content=ANALYZER_SYSTEM_PROMPT), HumanMessage(content=prompt)]
    )
    content = str(response.content).strip()
    return {
        "messages": [{"role": "analyzer", "content": content}],
        "current_interviewer_intent": content,
    }


def _parse_strategies(raw: str) -> list[Strategy]:
    try:
        payload = json.loads(raw)
        strategies = payload.get("strategies", [])
        if isinstance(strategies, list):
            parsed: list[Strategy] = []
            for item in strategies[:3]:
                if not isinstance(item, dict):
                    continue
                parsed.append(
                    {
                        "title": str(item.get("title", "策略")).strip(),
                        "stance": str(item.get("stance", "")).strip(),
                        "content": str(item.get("content", "")).strip(),
                    }
                )
            if parsed:
                return parsed
    except json.JSONDecodeError:
        pass

    return [
        {
            "title": "保守安全",
            "stance": "先稳住风险",
            "content": raw.strip()[:300],
        }
    ]


async def strategist_node(state: InterviewState) -> dict[str, Any]:
    question = _last_interviewer_question(state)
    prompt = f"""最新面试官问题：
{question}

潜台词分析：
{state.get("current_interviewer_intent") or "本轮为并行分析，请你基于问题和上下文自行推断。"}

候选人简历：
{state.get("resume") or "候选人暂未提供简历。"}

最近对话：
{_conversation_text(state)}

请生成 3 张策略提示卡。"""
    response = await _llm().ainvoke(
        [SystemMessage(content=STRATEGIST_SYSTEM_PROMPT), HumanMessage(content=prompt)]
    )
    raw = str(response.content).strip()
    strategies = _parse_strategies(raw)
    readable = "\n\n".join(
        f"{item['title']}｜{item['stance']}\n{item['content']}" for item in strategies
    )
    return {
        "messages": [{"role": "strategist", "content": readable}],
        "strategies": strategies,
        "awaiting_user": True,
    }


def build_interview_graph():
    graph = StateGraph(InterviewState)
    graph.add_node("interviewer", interviewer_node)
    graph.add_node("analyzer", analyzer_node)
    graph.add_node("strategist", strategist_node)

    graph.add_edge(START, "interviewer")
    graph.add_edge("interviewer", "analyzer")
    graph.add_edge("interviewer", "strategist")
    graph.add_edge("analyzer", END)
    graph.add_edge("strategist", END)
    return graph.compile()


interview_graph = build_interview_graph()
