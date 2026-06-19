# AI 面试破局者 Interview Breaker

多智能体求职与薪资谈判模拟系统。系统使用 LangGraph 编排三个 Agent：

- Agent C / Interviewer：压力面试官，负责追问、施压和推进面试。
- Agent A / Analyzer：潜台词雷达，分析面试官问题背后的真实考察意图。
- Agent B / Strategist：策略军师，生成保守安全、高情商婉拒、专业反杀三类回复建议。

完整工程说明见：[技术文档](docs/TECHNICAL_DOCUMENTATION.md)

## 技术栈

后端：

- Python 3.11+
- FastAPI + Uvicorn
- SQLite + SQLAlchemy asyncio + aiosqlite
- LangGraph + LangChain
- OpenAI-compatible Chat API，可切换到本地 vLLM

前端：

- React 18
- TypeScript
- Vite
- Tailwind CSS
- WebSocket

## 目录结构

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
|-- .gitignore
`-- README.md
```

## 后端开发环境

建议一定使用虚拟环境。原因很简单：LangChain、LangGraph、FastAPI、Pydantic 的版本更新比较快，虚拟环境能避免污染系统 Python，也能减少依赖冲突。

### Windows PowerShell

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
Copy-Item .env.example .env
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

如果 PowerShell 禁止激活脚本，可以临时放开当前用户策略：

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

### Windows CMD

```bat
cd backend
python -m venv .venv
.venv\Scripts\activate.bat
python -m pip install --upgrade pip
pip install -r requirements.txt
copy .env.example .env
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

### macOS / Linux

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install -r requirements.txt
cp .env.example .env
uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

后端启动后访问：

```text
http://127.0.0.1:8000/health
```

API 文档：

```text
http://127.0.0.1:8000/docs
```

## 后端环境变量

复制 `backend/.env.example` 为 `backend/.env` 后按需修改：

```env
APP_NAME="Interview Breaker"
APP_ENV="development"
DATABASE_URL="sqlite+aiosqlite:///./interview_breaker.db"
OPENAI_API_KEY="replace-with-your-deepseek-api-key"
OPENAI_BASE_URL="https://api.deepseek.com"
OPENAI_MODEL="deepseek-v4-flash"
FRONTEND_ORIGIN="http://localhost:5173"
```

默认配置使用 DeepSeek V4 Flash，适合多 Agent 实时对话。如果更重视推理质量，可以将 `OPENAI_MODEL` 改成 `deepseek-v4-pro`。

如果后期接本地 vLLM，只需要改成 OpenAI-compatible 地址：

```env
OPENAI_BASE_URL="http://127.0.0.1:8001/v1"
OPENAI_API_KEY="EMPTY"
OPENAI_MODEL="your-local-model-name"
```

## 前端开发环境

需要先安装 Node.js 18+。当前机器如果执行 `npm --version` 报错，说明 Node.js / npm 还没有加入 PATH。

```bash
cd frontend
npm install
npm run dev
```

前端默认地址：

```text
http://127.0.0.1:5173
```

如果后端不在 `http://localhost:8000`，可以创建 `frontend/.env.local`：

```env
VITE_API_URL=http://127.0.0.1:8000
```

## 推荐启动顺序

1. 启动后端：`uvicorn main:app --reload --host 127.0.0.1 --port 8000`
2. 确认 `http://127.0.0.1:8000/health` 返回正常。
3. 启动前端：`npm run dev`
4. 打开 `http://127.0.0.1:5173`
5. 输入目标岗位和简历摘要，点击开始模拟。

## 核心接口

创建面试会话：

```http
POST /api/session/create
Content-Type: application/json

{
  "job_title": "高级前端工程师",
  "resume": "5 年前端经验，熟悉 React、TypeScript、性能优化..."
}
```

WebSocket 对话：

```text
ws://127.0.0.1:8000/ws/chat/{session_id}
```

前端发送用户回答：

```json
{
  "type": "user_message",
  "content": "我的回答是..."
}
```

前端触发首问：

```json
{
  "type": "start"
}
```

## 数据库

默认使用 SQLite，数据库文件会在后端运行目录生成：

```text
backend/interview_breaker.db
```

当前模型：

- `sessions`：记录一次面试模拟，包含 `session_id`、`job_title`、`resume`、`status`、时间戳。
- `messages`：记录对话流，包含 `id`、`session_id`、`role`、`content`、`timestamp`。

## 常见问题

### 1. `OPENAI_API_KEY` 没配会怎样？

后端可以启动，但一旦 WebSocket 驱动 Agent 调用模型，就会失败。请在 `backend/.env` 中配置真实 Key，或者配置本地 vLLM 的兼容接口。

### 2. 为什么前端连不上 WebSocket？

优先检查：

- 后端是否运行在 `127.0.0.1:8000`
- 前端 `VITE_API_URL` 是否指向正确后端
- 后端 CORS 的 `FRONTEND_ORIGIN` 是否包含前端地址
- 浏览器控制台是否出现 WebSocket 连接错误

### 3. PowerShell 里中文显示乱码怎么办？

建议使用 Windows Terminal，并把终端编码切到 UTF-8：

```powershell
chcp 65001
```

README 的目录树已使用 ASCII 字符，能减少跨终端乱码问题。

## 开发校验

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
