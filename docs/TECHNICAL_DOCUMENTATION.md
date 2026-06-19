# AI 面试破局者 Interview Breaker 技术文档

版本：0.1.0  
最后更新：2026-06-19  
项目类型：前后端分离的多智能体面试模拟系统

## 1. 项目概述

AI 面试破局者是一个面向求职者的多智能体面试训练系统。它通过 WebSocket 将用户回答、面试官追问、潜台词分析和回复策略实时串联起来，模拟压力面试、HR 追问、薪资谈判等高压场景。

系统核心由三个 Agent 构成：

- Agent C / Interviewer：扮演压力面试官，根据岗位和简历提出问题，并在用户回答后继续追问。
- Agent A / Analyzer：从旁观者视角分析面试官问题背后的真实意图、风险点和作答原则。
- Agent B / Strategist：基于问题和上下文生成三类回复建议：保守安全、高情商婉拒、专业反杀。

当前实现是一套可运行的 MVP 骨架，重点覆盖：

- FastAPI REST 接口
- FastAPI WebSocket 实时交互
- SQLAlchemy asyncio 数据模型
- LangGraph 多智能体工作流
- React + TypeScript + Tailwind 基础 UI
- OpenAI-compatible 模型接口，默认指向 DeepSeek
- 历史会话侧栏和手动/AI 代答选择流
- PDF 简历提取、JD 文本/链接导入、easy/pressure 模式、结束面试和面后复盘

## 2. 技术栈

后端：

- Python 3.11+
- FastAPI
- Uvicorn
- SQLite
- SQLAlchemy asyncio
- aiosqlite
- LangGraph
- LangChain
- langchain-openai
- Pydantic Settings

前端：

- React 18
- TypeScript
- Vite
- Tailwind CSS
- lucide-react
- Browser WebSocket API

AI 模型接口：

- 使用 `langchain_openai.ChatOpenAI`
- 默认 Base URL：`https://api.deepseek.com`
- 默认模型：`deepseek-v4-flash`
- 可切换为 `deepseek-v4-pro` 或本地 vLLM OpenAI-compatible 服务

## 3. 项目结构

```text
Interview Breaker/
|-- backend/
|   |-- agents/
|   |   |-- __init__.py
|   |   `-- workflow.py
|   |-- core/
|   |   |-- __init__.py
|   |   `-- config.py
|   |-- models/
|   |   |-- __init__.py
|   |   `-- database.py
|   |-- routers/
|   |   |-- __init__.py
|   |   |-- chat.py
|   |   `-- session.py
|   |-- schemas/
|   |   |-- __init__.py
|   |   `-- session.py
|   |-- __init__.py
|   |-- main.py
|   |-- requirements.txt
|   `-- .env.example
|-- frontend/
|   |-- src/
|   |   |-- App.tsx
|   |   |-- index.css
|   |   `-- main.tsx
|   |-- index.html
|   |-- package.json
|   |-- postcss.config.js
|   |-- tailwind.config.ts
|   |-- tsconfig.json
|   |-- tsconfig.node.json
|   `-- vite.config.ts
|-- docs/
|   `-- TECHNICAL_DOCUMENTATION.md
|-- .gitignore
`-- README.md
```

说明：

- `backend/interview_breaker.db` 是运行时生成的 SQLite 数据库，不应作为源代码提交。
- `frontend/node_modules/` 是依赖安装目录，不应作为源代码提交。
- `__pycache__/` 是 Python 编译缓存，不应作为源代码提交。

## 4. 后端架构

后端采用典型分层结构：

```text
FastAPI app
|-- main.py              应用入口、CORS、生命周期、路由挂载
|-- core/config.py       环境变量配置
|-- models/database.py   数据库引擎、异步会话、ORM 模型
|-- schemas/session.py   Pydantic 请求和响应模型
|-- routers/session.py   REST 会话接口
|-- routers/chat.py      WebSocket 对话接口
`-- agents/workflow.py   LangGraph 多 Agent 工作流
```

### 4.1 应用入口

文件：`backend/main.py`

职责：

- 创建 FastAPI 应用
- 在应用生命周期启动时初始化数据库表
- 配置 CORS
- 挂载 REST 路由和 WebSocket 路由
- 暴露健康检查接口 `/health`

生命周期函数：

```python
@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    await init_db()
    yield
```

这意味着服务启动时会自动执行 `Base.metadata.create_all`，适合 MVP 阶段。生产环境建议迁移到 Alembic。

### 4.2 配置层

文件：`backend/core/config.py`

核心配置类：

```python
class Settings(BaseSettings):
    app_name: str = "Interview Breaker"
    app_env: str = "development"
    database_url: str = "sqlite+aiosqlite:///./interview_breaker.db"
    openai_api_key: str = ""
    openai_base_url: str = "https://api.deepseek.com"
    openai_model: str = "deepseek-v4-flash"
    frontend_origin: str = "http://localhost:5173"
```

配置读取：

- 默认从 `backend/.env` 读取。
- 使用 `@lru_cache` 缓存配置对象。
- 环境变量名由 Pydantic Settings 自动映射，例如 `OPENAI_API_KEY` 对应 `openai_api_key`。

### 4.3 数据库层

文件：`backend/models/database.py`

数据库引擎：

```python
engine = create_async_engine(settings.database_url, echo=settings.app_env == "development")
async_session_maker = async_sessionmaker(engine, expire_on_commit=False)
```

异步会话依赖：

```python
async def get_async_session() -> AsyncGenerator[AsyncDbSession, None]:
    async with async_session_maker() as session:
        try:
            yield session
        finally:
            await session.close()
```

当前使用 SQLite + aiosqlite。切换 PostgreSQL 时，需要：

- 安装 `asyncpg`
- 修改 `DATABASE_URL`
- 用 Alembic 管理迁移
- 重新评估 SQLite 特有行为

## 5. 数据模型

### 5.1 Session 表

ORM 类：`Session`  
表名：`sessions`

字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `session_id` | `String(36)` | 主键，UUID 字符串 |
| `job_title` | `String(160)` | 目标岗位 |
| `resume` | `Text` | 简历摘要 |
| `resume_filename` | `String` | PDF 简历文件名 |
| `jd_text` | `Text` | JD 文本 |
| `jd_url` | `String` | JD 来源链接 |
| `jd_requirements_json` | `Text` | 大模型拆解后的 JD 要求 |
| `interview_mode` | `String` | `easy` 或 `pressure` |
| `question_time_limit_seconds` | `Integer` | 压力模式单题时间限制 |
| `deadline_at` | `DateTime` | 当前题截止时间 |
| `ended_at` | `DateTime` | 面试结束时间 |
| `end_reason` | `String` | 结束原因 |
| `final_report_json` | `Text` | 面后复盘报告 |
| `status` | `Enum(SessionStatus)` | 会话状态 |
| `created_at` | `DateTime` | 创建时间 |
| `updated_at` | `DateTime` | 更新时间 |

状态枚举：

```python
class SessionStatus(StrEnum):
    ACTIVE = "active"
    COMPLETED = "completed"
    ARCHIVED = "archived"
```

### 5.2 Message 表

ORM 类：`Message`  
表名：`messages`

字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | `int` | 自增主键 |
| `session_id` | `String` | 外键，关联 `sessions.session_id` |
| `role` | `Enum(MessageRole)` | 消息角色 |
| `content` | `Text` | 消息正文 |
| `timestamp` | `DateTime` | 消息时间 |

角色枚举：

```python
class MessageRole(StrEnum):
    INTERVIEWER = "interviewer"
    USER = "user"
    ANALYZER = "analyzer"
    STRATEGIST = "strategist"
```

关系：

- `Session.messages` 一对多关联 `Message`
- 删除 Session 时级联删除 Message

## 6. Agent 工作流

文件：`backend/agents/workflow.py`

### 6.1 状态定义

```python
class InterviewState(TypedDict, total=False):
    messages: Annotated[list[InterviewMessage], operator.add]
    job_title: str
    resume: str
    current_interviewer_intent: str
    strategies: list[Strategy]
    awaiting_user: bool
    round: int
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `messages` | 对话历史，使用 `operator.add` 合并多个节点产出的消息 |
| `job_title` | 当前面试目标岗位 |
| `resume` | 候选人简历摘要 |
| `current_interviewer_intent` | Analyzer 输出的潜台词分析 |
| `strategies` | Strategist 输出的结构化策略卡片 |
| `awaiting_user` | 当前是否等待用户输入 |
| `round` | 面试官提问轮次 |

### 6.2 节点设计

#### interviewer_node

角色：Agent C / Interviewer

输入：

- 岗位目标
- 简历摘要
- 最近 16 条对话历史

输出：

```python
{
    "messages": [{"role": "interviewer", "content": content}],
    "awaiting_user": False,
    "round": state.round + 1,
}
```

行为：

- 生成本轮压力面试问题。
- 如果用户已回答上一问，会先指出回答中的风险点，再继续追问。

#### analyzer_node

角色：Agent A / Analyzer

输入：

- 最新面试官问题
- 对话上下文

输出：

```python
{
    "messages": [{"role": "analyzer", "content": content}],
    "current_interviewer_intent": content,
}
```

行为：

- 分析真实意图。
- 列出潜在陷阱。
- 给出风险等级和应对原则。

#### strategist_node

角色：Agent B / Strategist

输入：

- 最新面试官问题
- 潜台词分析，如果并行时尚未存在，则自行基于上下文推断
- 简历摘要
- 对话上下文

输出：

```python
{
    "messages": [{"role": "strategist", "content": readable}],
    "strategies": strategies,
    "awaiting_user": True,
}
```

行为：

- 要求模型严格输出 JSON。
- 解析为三张策略卡。
- 如果 JSON 解析失败，使用单卡兜底。

### 6.3 图结构

当前图结构：

```text
START
  |
  v
interviewer
  |-------------|
  v             v
analyzer     strategist
  |             |
  v             v
 END           END
```

代码：

```python
graph.add_edge(START, "interviewer")
graph.add_edge("interviewer", "analyzer")
graph.add_edge("interviewer", "strategist")
graph.add_edge("analyzer", END)
graph.add_edge("strategist", END)
```

说明：

- 面试官节点先生成问题。
- Analyzer 和 Strategist 从面试官问题分叉执行。
- WebSocket 使用 `astream(..., stream_mode="updates")` 接收每个节点的增量结果。
- 当前版本没有在图内部等待用户输入，而是在 WebSocket 层通过事件循环实现“用户输入 -> 驱动图执行 -> 推送结果 -> 等待用户下一轮输入”。

### 6.4 并行策略说明

Analyzer 和 Strategist 是从 Interviewer 后并行触发的。由于 Strategist 可能早于 Analyzer 完成，`strategist_node` 内部允许在没有 `current_interviewer_intent` 时自行推断：

```python
state.get("current_interviewer_intent") or "本轮为并行分析，请你基于问题和上下文自行推断。"
```

优点：

- 响应更快。
- UI 可以先展示任一 Agent 的结果。

代价：

- Strategist 不一定使用 Analyzer 的正式分析。
- 如果后续希望策略强依赖分析，应改为串行：`interviewer -> analyzer -> strategist -> END`。

## 7. API 设计

### 7.1 健康检查

```http
GET /health
```

响应：

```json
{
  "status": "ok",
  "service": "Interview Breaker"
}
```

### 7.2 创建面试会话

```http
POST /api/session/create
Content-Type: application/json
```

请求：

```json
{
  "job_title": "高级前端工程师",
  "resume": "5 年前端经验，熟悉 React、TypeScript、性能优化...",
  "jd_text": "岗位职责和任职要求...",
  "jd_url": "https://example.com/job",
  "interview_mode": "pressure",
  "question_time_limit_seconds": 300
}
```

响应：

```json
{
  "session_id": "uuid-string",
  "job_title": "高级前端工程师",
  "status": "active",
  "interview_mode": "pressure",
  "jd_requirements": {
    "hard_skills": ["Python"],
    "soft_skills": ["跨部门沟通"]
  }
}
```

错误：

- `500`：数据库写入失败或服务端异常

### 7.3 上传 PDF 简历

```http
POST /api/session/resume/upload
Content-Type: multipart/form-data
```

字段：

- `file`：PDF 文件

响应：

```json
{
  "filename": "resume.pdf",
  "text": "PDF 中提取到的文本"
}
```

### 7.4 查询会话消息

```http
GET /api/session/{session_id}/messages
```

响应：

```json
[
  {
    "id": 1,
    "session_id": "uuid-string",
    "role": "interviewer",
    "content": "你能解释一下简历中这个项目的真实贡献吗？",
    "timestamp": "2026-06-19T12:00:00"
  }
]
```

错误：

- `404`：会话不存在

### 7.5 查询历史会话

```http
GET /api/session/list
```

响应：

```json
[
  {
    "session_id": "uuid-string",
    "job_title": "高级前端工程师",
    "status": "active",
    "created_at": "2026-06-19T12:00:00",
    "updated_at": "2026-06-19T12:10:00",
    "last_message": "最近一条消息摘要",
    "message_count": 8
  }
]
```

用途：

- 前端左侧历史栏展示历史会话。
- 点击某条会话后，前端继续调用 `/api/session/{session_id}/messages` 恢复消息。

### 7.6 结束面试

```http
POST /api/session/{session_id}/end
Content-Type: application/json
```

请求：

```json
{
  "reason": "abandoned"
}
```

结束原因：

- `passed`：面试官判定通过
- `time_limit`：总面试时长超过 2 小时
- `abandoned`：面试者主动放弃
- `manual`：手动结束或报告触发结束

### 7.7 面后复盘报告

```http
GET /api/session/{session_id}/report
```

报告包含：

- 技术契合度：指出事实风险和证据不足处
- 沟通结构性：检查 STAR 等结构化表达
- 情绪稳定性：分析压力追问下的表现
- 优化建议：给出补强优先级、充电方向和下一次练习建议

### 7.8 WebSocket 对话

连接地址：

```text
ws://127.0.0.1:8000/ws/chat/{session_id}
```

连接成功后服务端发送：

```json
{
  "type": "connected",
  "session_id": "uuid-string",
  "job_title": "高级前端工程师"
}
```

#### 客户端事件：触发首问

```json
{
  "type": "start"
}
```

#### 客户端事件：发送用户回答

```json
{
  "type": "user_message",
  "content": "我的回答是..."
}
```

说明：

- 面试官提出问题后，前端不会自动推进下一问。
- 用户必须选择“我自己回答”并提交文本，或选择“AI 替我回答”并点击 Agent B 的某张策略卡。
- 两种方式最终都会通过 `user_message` 发送，后端保存为 `role=user`，然后才驱动下一轮面试官提问。
- 客户端可发送 `{"type": "end_interview"}` 主动放弃面试。
- 压力模式下，服务端会在面试官消息中返回 `deadline_at`，前端据此显示单题倒计时。

#### 客户端事件：关闭连接

```json
{
  "type": "close"
}
```

#### 服务端事件：用户消息回显

```json
{
  "type": "user_message",
  "role": "user",
  "content": "我的回答是..."
}
```

#### 服务端事件：Agent 状态

```json
{
  "type": "agent_status",
  "status": "thinking"
}
```

可能状态：

- `thinking`
- `waiting_user`

#### 服务端事件：Agent 消息

```json
{
  "type": "agent_message",
  "node": "interviewer",
  "role": "interviewer",
  "content": "面试官问题"
}
```

Analyzer 额外字段：

```json
{
  "type": "agent_message",
  "node": "analyzer",
  "role": "analyzer",
  "content": "潜台词分析",
  "intent": "潜台词分析"
}
```

Strategist 额外字段：

```json
{
  "type": "agent_message",
  "node": "strategist",
  "role": "strategist",
  "content": "可读文本",
  "strategies": [
    {
      "title": "保守安全",
      "stance": "稳健解释，降低风险",
      "content": "可直接参考的中文回复"
    }
  ]
}
```

#### 服务端事件：错误

```json
{
  "type": "error",
  "message": "Agent workflow failed."
}
```

WebSocket 关闭码：

- `1008`：会话不存在或策略拒绝
- `1011`：服务端内部错误

## 8. WebSocket 执行链路

文件：`backend/routers/chat.py`

主要函数：

- `_load_state(session)`：从数据库加载历史消息，转换为 LangGraph 状态。
- `_persist_message(session_id, role, content)`：持久化单条消息。
- `_emit_agent_update(websocket, session_id, node_name, update)`：将 LangGraph 节点输出写库并推给前端。
- `chat_websocket(websocket, session_id)`：WebSocket 主循环。

完整链路：

```text
前端连接 /ws/chat/{session_id}
  |
后端校验 session 是否存在
  |
前端发送 start 或 user_message
  |
如为 user_message，后端先保存用户消息
  |
后端从数据库加载完整历史，组装 InterviewState
  |
执行 interview_graph.astream(state, stream_mode="updates")
  |
每个 Agent 节点产出 update
  |
后端保存 Agent 消息
  |
后端通过 WebSocket 推送给前端
  |
发送 waiting_user 状态，等待下一轮用户输入
```

## 9. 前端架构

文件：`frontend/src/App.tsx`

当前前端采用单文件 MVP 结构，包含：

- 会话创建表单
- WebSocket Hook
- 主聊天区
- 潜台词雷达区
- 策略提示卡片区

### 9.1 状态模型

```ts
type Role = "interviewer" | "user" | "analyzer" | "strategist";

type ChatMessage = {
  role: Role;
  content: string;
};

type StrategyCard = {
  title: string;
  stance: string;
  content: string;
};

type SocketStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "thinking"
  | "waiting_user"
  | "error";
```

### 9.2 WebSocket Hook

函数：`useInterviewSocket(sessionId)`

职责：

- 建立 WebSocket 连接
- 管理连接状态
- 接收和解析服务端消息
- 更新聊天消息、分析文本、策略卡片
- 提供 `send(content)` 和 `start()` 方法

连接地址生成：

```ts
const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8000";
const WS_URL = API_URL.replace(/^http/, "ws");
```

### 9.3 UI 布局

布局目标：面试作战台。

```text
页面
|-- 左侧历史栏
|   |-- 新建模拟表单
|   `-- 历史会话列表
|-- 中间主对话区
|   |-- 连接状态和阶段条
|   |-- 面试官/候选人消息
|   `-- 回答方式选择
`-- 右侧辅助区
    |-- Agent A 潜台词雷达
    `-- Agent B 策略提示卡片
```

Tailwind 设计特点：

- 左侧使用深色档案栏，突出历史问答管理。
- 中间使用浅色面试现场，保留清晰对话气泡。
- 右侧使用白底分析面板，突出辅助决策。
- 签名元素是主对话区顶部的阶段条：面试官提问、分析陷阱、选择回答、进入追问。
- 用户必须明确选择回答方式，系统不会在未回答时自动进入下一问。

## 10. 配置说明

### 10.1 后端 .env

文件：`backend/.env`

示例：

```env
APP_NAME="Interview Breaker"
APP_ENV="development"
DATABASE_URL="sqlite+aiosqlite:///./interview_breaker.db"
OPENAI_API_KEY="replace-with-your-deepseek-api-key"
OPENAI_BASE_URL="https://api.deepseek.com"
OPENAI_MODEL="deepseek-v4-flash"
FRONTEND_ORIGIN="http://localhost:5173"
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `APP_NAME` | FastAPI 应用名称 |
| `APP_ENV` | 当前环境，`development` 时 SQLAlchemy echo 开启 |
| `DATABASE_URL` | 异步数据库连接串 |
| `OPENAI_API_KEY` | 模型服务 API Key |
| `OPENAI_BASE_URL` | OpenAI-compatible API 地址 |
| `OPENAI_MODEL` | 模型名称 |
| `FRONTEND_ORIGIN` | 前端源地址，用于 CORS |

### 10.2 DeepSeek 配置

默认：

```env
OPENAI_BASE_URL="https://api.deepseek.com"
OPENAI_MODEL="deepseek-v4-flash"
```

可选：

```env
OPENAI_MODEL="deepseek-v4-pro"
```

### 10.3 本地 vLLM 配置

```env
OPENAI_BASE_URL="http://127.0.0.1:8001/v1"
OPENAI_API_KEY="EMPTY"
OPENAI_MODEL="your-local-model-name"
```

前提：

- vLLM 服务以 OpenAI-compatible API 方式启动。
- 模型名称与 vLLM 暴露的模型名一致。

### 10.4 前端 .env.local

如后端地址不是默认值，可创建：

```env
VITE_API_URL=http://127.0.0.1:8000
```

## 11. 启动和开发

### 11.1 后端启动

Windows PowerShell：

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
Copy-Item .env.example .env
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

macOS / Linux：

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install -r requirements.txt
cp .env.example .env
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

### 11.2 前端启动

```bash
cd frontend
npm install
npm run dev
```

### 11.3 推荐开发流程

```text
启动后端
  |
访问 /health 验证服务
  |
启动前端
  |
创建面试会话
  |
WebSocket 自动连接并触发首问
  |
用户输入回答
  |
多 Agent 生成下一轮内容
```

## 12. 测试和校验

当前项目尚未配置自动化测试。建议补充：

- 后端单元测试：`pytest`
- 异步接口测试：`pytest-asyncio` + `httpx.AsyncClient`
- WebSocket 测试：FastAPI `TestClient.websocket_connect`
- 前端单元测试：Vitest + React Testing Library
- E2E 测试：Playwright

现有可用校验命令：

后端语法检查：

```bash
cd backend
python -m compileall .
```

前端构建检查：

```bash
cd frontend
npm run build
```

## 13. 安全和合规注意事项

### 13.1 API Key

- 不要提交 `backend/.env`。
- 不要把真实 API Key 写入 README、代码或前端环境变量。
- 生产环境应通过部署平台的 Secret 管理能力注入。

### 13.2 用户数据

当前系统会保存：

- 目标岗位
- 简历摘要
- 用户回答
- Agent 输出

建议后续增加：

- 会话删除接口
- 数据脱敏
- 自动过期清理
- 隐私声明
- 简历内容最大长度限制和敏感信息提醒

### 13.3 模型输出安全

当前 Prompt 已要求：

- 不侮辱
- 不歧视
- 不输出违法或人身攻击内容

生产环境建议增加：

- 输出内容审核
- Prompt 注入防护
- 简历和用户输入的敏感信息过滤
- Agent 输出失败时的降级文案

## 14. 已知限制

1. LangGraph 状态未持久化为检查点，目前每轮从数据库消息重建状态。
2. Analyzer 和 Strategist 并行执行，Strategist 不一定使用 Analyzer 的正式分析。
3. 没有用户账户体系，任何知道 `session_id` 的客户端都可连接会话。
4. 没有分页，消息查询会返回当前会话所有消息。
5. 数据库自动建表适合 MVP，不适合多人协作或生产迁移。
6. 前端所有逻辑集中在 `App.tsx`，后续应拆分 Hook、组件和 API 客户端。
7. WebSocket 当前是节点级结果推送，不是 token 级模型流式输出。
8. 当前没有速率限制和并发控制。
9. 历史会话列表当前为 MVP 查询实现，数据量变大后应优化为聚合查询或物化摘要。
10. PDF 提取当前只支持可复制文本型 PDF，扫描件需要后续接 OCR。
11. JD 链接抓取是基础 HTML 文本提取，复杂招聘网站可能需要专门适配。
12. 专业事实核验目前预留了 `backend/knowledge/` 检索接口，尚未接入在线权威搜索或本地 RAG。

## 15. 后续演进建议

### 15.1 架构演进

- 引入 Alembic 管理数据库迁移。
- 增加 LangGraph checkpoint，实现可恢复状态。
- 将 Agent Prompt 拆分到独立配置文件或 Prompt Registry。
- 引入统一日志结构和 request/session trace id。
- 添加应用级错误码。

### 15.2 功能演进

- 增加面试模式：HR 面、技术面、主管面、薪资谈判。
- 增加压力等级：温和、标准、高压。
- 增加简历解析上传。
- 增加面试报告：表现评分、风险点、改进建议。
- 增加历史会话列表和会话归档。
- 增加回复采纳功能，让系统知道用户选择了哪张策略卡。

### 15.3 前端演进

- 拆分组件：
  - `SessionForm`
  - `InterviewChat`
  - `AnalyzerPanel`
  - `StrategyPanel`
  - `StatusBadge`
- 抽离 Hook：
  - `useInterviewSocket`
  - `useCreateSession`
- 增加自动滚动到底部。
- 增加断线重连。
- 增加加载状态骨架屏。
- 增加移动端布局优化。

### 15.4 生产部署演进

- 后端容器化：Docker + Uvicorn/Gunicorn。
- 前端构建静态资源并部署到 CDN 或 Nginx。
- 数据库切换 PostgreSQL。
- 配置集中化和 Secret 管理。
- 增加 HTTPS 和 WSS。
- 增加监控：日志、指标、错误追踪。

## 16. 编码约定

- 源码统一使用 UTF-8。
- Windows PowerShell 如出现中文乱码，执行：

```powershell
chcp 65001
```

- Python 使用类型注解。
- FastAPI 路由使用 `async def`。
- 数据库访问使用异步 SQLAlchemy 会话。
- 前端 TypeScript 开启 strict 模式。
- 生成物不提交：
  - `.venv/`
  - `node_modules/`
  - `__pycache__/`
  - `*.db`
  - `dist/`

## 17. 关键文件索引

| 文件 | 作用 |
| --- | --- |
| `backend/main.py` | FastAPI 应用入口 |
| `backend/core/config.py` | 环境变量配置 |
| `backend/models/database.py` | ORM 模型和异步数据库会话 |
| `backend/schemas/session.py` | Pydantic 请求响应模型 |
| `backend/routers/session.py` | 会话 REST API |
| `backend/routers/chat.py` | WebSocket 对话 API |
| `backend/agents/workflow.py` | LangGraph 多 Agent 工作流 |
| `frontend/src/App.tsx` | 前端主界面和 WebSocket Hook |
| `frontend/package.json` | 前端依赖和脚本 |
| `backend/requirements.txt` | 后端依赖 |
