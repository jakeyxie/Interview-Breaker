import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Archive,
  BrainCircuit,
  ChevronRight,
  History,
  Loader2,
  MessageSquareText,
  PenLine,
  Radar,
  Send,
  ShieldCheck,
  Sparkles,
  UserRound,
} from "lucide-react";

type Role = "interviewer" | "user" | "analyzer" | "strategist";
type AnswerMode = "idle" | "manual" | "ai";
type SocketStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "thinking"
  | "waiting_user"
  | "waiting_user_choice"
  | "error";

type ChatMessage = {
  id?: number;
  session_id?: string;
  role: Role;
  content: string;
  timestamp?: string;
};

type StrategyCard = {
  title: string;
  stance: string;
  content: string;
};

type SessionSummary = {
  session_id: string;
  job_title: string;
  status: string;
  created_at: string;
  updated_at: string;
  last_message: string | null;
  message_count: number;
};

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8000";
const WS_URL = API_URL.replace(/^http/, "ws");

function statusCopy(status: SocketStatus) {
  const labels: Record<SocketStatus, string> = {
    idle: "待连接",
    connecting: "连接中",
    connected: "已连接",
    thinking: "面试官思考中",
    waiting_user: "等待回答",
    waiting_user_choice: "选择回答方式",
    error: "连接异常",
  };
  return labels[status];
}

function formatTime(value?: string) {
  if (!value) {
    return "";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function latestByRole(messages: ChatMessage[], role: Role) {
  return [...messages].reverse().find((message) => message.role === role)?.content ?? "";
}

async function fetchSessions() {
  const response = await fetch(`${API_URL}/api/session/list`);
  if (!response.ok) {
    throw new Error("无法加载历史会话");
  }
  return (await response.json()) as SessionSummary[];
}

async function fetchMessages(sessionId: string) {
  const response = await fetch(`${API_URL}/api/session/${sessionId}/messages`);
  if (!response.ok) {
    throw new Error("无法加载历史消息");
  }
  return (await response.json()) as ChatMessage[];
}

function useInterviewSocket(sessionId: string | null) {
  const socketRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<SocketStatus>("idle");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [analysis, setAnalysis] = useState("");
  const [strategies, setStrategies] = useState<StrategyCard[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    setError("");
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) {
      return;
    }

    setStatus("connecting");
    const socket = new WebSocket(`${WS_URL}/ws/chat/${sessionId}`);
    socketRef.current = socket;

    socket.onopen = () => setStatus("connected");
    socket.onerror = () => {
      setError("WebSocket 连接失败，请确认后端服务已启动");
      setStatus("error");
    };
    socket.onclose = () => {
      socketRef.current = null;
      setStatus((current) => (current === "error" ? "error" : "idle"));
    };
    socket.onmessage = (event: MessageEvent<string>) => {
      let payload: Record<string, any>;
      try {
        payload = JSON.parse(event.data);
      } catch {
        setError("收到无法解析的消息");
        setStatus("error");
        return;
      }

      if (payload.type === "agent_status") {
        setStatus(payload.status as SocketStatus);
        return;
      }
      if (payload.type === "error") {
        setError(String(payload.message ?? "服务端返回错误"));
        setStatus("error");
        return;
      }
      if (payload.type === "user_message" || payload.type === "agent_message") {
        const nextMessage = {
          role: payload.role,
          content: payload.content,
        } as ChatMessage;
        setMessages((current) => [...current, nextMessage]);
      }
      if (payload.role === "analyzer") {
        setAnalysis(String(payload.intent ?? payload.content ?? ""));
      }
      if (payload.role === "strategist") {
        setStrategies((payload.strategies ?? []) as StrategyCard[]);
      }
    };

    return () => {
      socket.close();
    };
  }, [sessionId]);

  const replaceMessages = useCallback((nextMessages: ChatMessage[]) => {
    setMessages(nextMessages);
    setAnalysis(latestByRole(nextMessages, "analyzer"));
    const strategistText = latestByRole(nextMessages, "strategist");
    setStrategies([]);
    if (strategistText) {
      setStrategies(
        strategistText.split("\n\n").map((item, index) => {
          const [headline, ...contentLines] = item.split("\n");
          const [title, stance] = headline.split("｜");
          return {
            title: title || `策略 ${index + 1}`,
            stance: stance || "从历史记录恢复",
            content: contentLines.join("\n").trim(),
          };
        }),
      );
    }
  }, []);

  const send = useCallback((content: string) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setError("连接尚未就绪");
      return;
    }
    socket.send(JSON.stringify({ type: "user_message", content }));
  }, []);

  const start = useCallback(() => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "start" }));
    }
  }, []);

  return { status, messages, analysis, strategies, error, send, start, replaceMessages };
}

export default function App() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [jobTitle, setJobTitle] = useState("高级前端工程师");
  const [resume, setResume] = useState("");
  const [input, setInput] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [answerMode, setAnswerMode] = useState<AnswerMode>("idle");
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const hasStartedRef = useRef(false);
  const { status, messages, analysis, strategies, error, send, start, replaceMessages } =
    useInterviewSocket(sessionId);

  const conversationMessages = useMemo(
    () => messages.filter((message) => message.role === "interviewer" || message.role === "user"),
    [messages],
  );
  const hasQuestionWaiting = useMemo(() => {
    const lastInterviewMessage = [...conversationMessages]
      .reverse()
      .find((message) => message.role === "interviewer" || message.role === "user");
    return lastInterviewMessage?.role === "interviewer" && status !== "thinking";
  }, [conversationMessages, status]);

  const activeSession = sessions.find((session) => session.session_id === sessionId);
  const latestQuestion = latestByRole(messages, "interviewer");

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await fetchSessions());
    } catch {
      setSessions([]);
    }
  }, []);

  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [conversationMessages.length]);

  useEffect(() => {
    if (sessionId && status === "connected" && !hasStartedRef.current && messages.length === 0) {
      hasStartedRef.current = true;
      start();
    }
  }, [messages.length, sessionId, start, status]);

  useEffect(() => {
    if (hasQuestionWaiting) {
      setAnswerMode("idle");
    }
  }, [hasQuestionWaiting, latestQuestion]);

  useEffect(() => {
    if (status === "waiting_user" || status === "waiting_user_choice") {
      refreshSessions();
    }
  }, [refreshSessions, status]);

  async function createSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreateError("");
    setIsCreating(true);
    try {
      const response = await fetch(`${API_URL}/api/session/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_title: jobTitle, resume }),
      });
      if (!response.ok) {
        throw new Error("创建会话失败");
      }
      const payload = await response.json();
      hasStartedRef.current = false;
      setAnswerMode("idle");
      replaceMessages([]);
      setSessionId(payload.session_id);
      await refreshSessions();
    } catch (caught) {
      setCreateError(caught instanceof Error ? caught.message : "创建会话失败");
    } finally {
      setIsCreating(false);
    }
  }

  async function openSession(nextSessionId: string) {
    setIsLoadingHistory(true);
    setAnswerMode("idle");
    hasStartedRef.current = true;
    try {
      const history = await fetchMessages(nextSessionId);
      setSessionId(nextSessionId);
      replaceMessages(history);
    } finally {
      setIsLoadingHistory(false);
    }
  }

  function submitAnswer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = input.trim();
    if (!value) {
      return;
    }
    send(value);
    setInput("");
    setAnswerMode("idle");
  }

  function sendStrategy(strategy: StrategyCard) {
    send(strategy.content);
    setAnswerMode("idle");
  }

  return (
    <main className="min-h-screen bg-[#e9edf0] text-slate-950">
      <div className="grid min-h-screen grid-cols-1 gap-3 p-3 xl:grid-cols-[300px_minmax(520px,1fr)_390px]">
        <aside className="flex min-h-[220px] flex-col overflow-hidden rounded-lg border border-slate-300 bg-[#111820] text-slate-100 shadow-sm">
          <header className="border-b border-white/10 p-4">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-cyan-300">
              <Archive size={15} />
              Interview files
            </div>
            <h1 className="mt-3 text-2xl font-semibold tracking-tight">面试档案</h1>
            <p className="mt-1 text-sm leading-6 text-slate-400">查看历史问答，继续任意一场模拟。</p>
          </header>

          <form onSubmit={createSession} className="grid gap-3 border-b border-white/10 p-4">
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-slate-300">目标岗位</span>
              <input
                className="h-10 rounded-md border border-white/10 bg-white/[0.08] px-3 text-sm text-white outline-none ring-cyan-300/40 placeholder:text-slate-500 focus:ring-2"
                value={jobTitle}
                onChange={(event) => setJobTitle(event.target.value)}
              />
            </label>
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-slate-300">简历摘要</span>
              <textarea
                className="min-h-24 resize-none rounded-md border border-white/10 bg-white/[0.08] p-3 text-sm leading-6 text-white outline-none ring-cyan-300/40 placeholder:text-slate-500 focus:ring-2"
                value={resume}
                onChange={(event) => setResume(event.target.value)}
                placeholder="项目经历、技术栈、薪资诉求"
              />
            </label>
            <button
              type="submit"
              disabled={isCreating}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-cyan-300 px-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-200 disabled:opacity-60"
            >
              {isCreating ? <Loader2 className="animate-spin" size={17} /> : <Sparkles size={17} />}
              新建模拟
            </button>
            {createError && <p className="text-sm text-rose-300">{createError}</p>}
          </form>

          <div className="flex items-center justify-between px-4 py-3">
            <div className="flex items-center gap-2 text-sm font-medium text-slate-300">
              <History size={16} />
              历史问答
            </div>
            <button
              type="button"
              onClick={refreshSessions}
              className="rounded-md px-2 py-1 text-xs text-cyan-200 hover:bg-white/10"
            >
              刷新
            </button>
          </div>

          <div className="flex-1 space-y-2 overflow-y-auto px-3 pb-3">
            {sessions.length === 0 ? (
              <div className="rounded-md border border-dashed border-white/15 p-4 text-sm leading-6 text-slate-400">
                暂无历史会话。创建一场模拟后，这里会记录你的问答轨迹。
              </div>
            ) : (
              sessions.map((session) => (
                <button
                  type="button"
                  key={session.session_id}
                  onClick={() => openSession(session.session_id)}
                  className={`w-full rounded-md border p-3 text-left transition ${
                    session.session_id === sessionId
                      ? "border-cyan-300 bg-cyan-300/12"
                      : "border-white/10 bg-white/[0.04] hover:border-white/25 hover:bg-white/[0.08]"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-white">{session.job_title}</div>
                      <div className="mt-1 text-xs text-slate-500">{formatTime(session.updated_at)}</div>
                    </div>
                    <ChevronRight size={16} className="mt-0.5 text-slate-500" />
                  </div>
                  <p className="mt-2 max-h-10 overflow-hidden text-xs leading-5 text-slate-400">
                    {session.last_message || "尚未产生问答"}
                  </p>
                  <div className="mt-2 text-xs text-cyan-200">{session.message_count} 条消息</div>
                </button>
              ))
            )}
          </div>
        </aside>

        <section className="flex min-h-[680px] flex-col overflow-hidden rounded-lg border border-slate-300 bg-[#f8faf9] shadow-sm">
          <header className="border-b border-slate-200 bg-white px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">
                  <MessageSquareText size={15} />
                  Live interview
                </div>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
                  {activeSession?.job_title || jobTitle || "创建一场模拟"}
                </h2>
              </div>
              <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
                {isLoadingHistory ? "加载历史中" : statusCopy(status)}
              </div>
            </div>

            <div className="mt-4 grid grid-cols-4 overflow-hidden rounded-md border border-slate-200 text-xs font-medium">
              {["面试官提问", "分析陷阱", "选择回答", "进入追问"].map((label, index) => {
                const active =
                  (index === 0 && status === "thinking") ||
                  (index === 1 && status === "waiting_user") ||
                  (index === 2 && hasQuestionWaiting) ||
                  (index === 3 &&
                    conversationMessages[conversationMessages.length - 1]?.role === "user");
                return (
                  <div
                    key={label}
                    className={`border-r border-slate-200 px-3 py-2 last:border-r-0 ${
                      active ? "bg-[#16202a] text-cyan-200" : "bg-white text-slate-500"
                    }`}
                  >
                    {label}
                  </div>
                );
              })}
            </div>
          </header>

          <div className="flex-1 space-y-4 overflow-y-auto p-5">
            {!sessionId ? (
              <div className="flex h-full items-center justify-center">
                <div className="max-w-md rounded-lg border border-dashed border-slate-300 bg-white p-6 text-center">
                  <BrainCircuit className="mx-auto text-cyan-700" size={34} />
                  <h3 className="mt-4 text-lg font-semibold">从左侧创建一场压力面试</h3>
                  <p className="mt-2 text-sm leading-6 text-slate-500">
                    输入岗位和简历摘要后，系统会生成首问，并在右侧给出潜台词和策略。
                  </p>
                </div>
              </div>
            ) : conversationMessages.length === 0 ? (
              <div className="flex h-full items-center justify-center">
                <button
                  type="button"
                  onClick={start}
                  className="inline-flex h-11 items-center gap-2 rounded-md bg-[#16202a] px-4 text-sm font-semibold text-white hover:bg-slate-800"
                >
                  <BrainCircuit size={18} />
                  生成首问
                </button>
              </div>
            ) : (
              conversationMessages.map((message, index) => (
                <article
                  key={`${message.role}-${message.id ?? index}`}
                  className={`flex gap-3 ${message.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  {message.role === "interviewer" && (
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[#16202a] text-cyan-200">
                      <BrainCircuit size={18} />
                    </div>
                  )}
                  <div
                    className={`max-w-[82%] rounded-lg px-4 py-3 text-sm leading-6 shadow-sm ${
                      message.role === "user"
                        ? "bg-cyan-700 text-white"
                        : "border border-slate-200 bg-white text-slate-900"
                    }`}
                  >
                    <div className="mb-1 flex items-center gap-2 text-xs font-semibold opacity-75">
                      {message.role === "user" ? <UserRound size={14} /> : <MessageSquareText size={14} />}
                      {message.role === "user" ? "候选人" : "面试官"}
                    </div>
                    {message.content}
                  </div>
                  {message.role === "user" && (
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-cyan-700 text-white">
                      <UserRound size={18} />
                    </div>
                  )}
                </article>
              ))
            )}
            <div ref={messagesEndRef} />
          </div>

          <footer className="border-t border-slate-200 bg-white p-4">
            {hasQuestionWaiting ? (
              <div className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setAnswerMode("manual")}
                    className={`inline-flex h-10 items-center gap-2 rounded-md px-3 text-sm font-semibold ${
                      answerMode === "manual"
                        ? "bg-[#16202a] text-white"
                        : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                    }`}
                  >
                    <PenLine size={17} />
                    我自己回答
                  </button>
                  <button
                    type="button"
                    onClick={() => setAnswerMode("ai")}
                    className={`inline-flex h-10 items-center gap-2 rounded-md px-3 text-sm font-semibold ${
                      answerMode === "ai"
                        ? "bg-cyan-700 text-white"
                        : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                    }`}
                  >
                    <ShieldCheck size={17} />
                    AI 替我回答
                  </button>
                </div>

                {answerMode === "manual" && (
                  <form onSubmit={submitAnswer} className="flex gap-2">
                    <input
                      className="h-11 flex-1 rounded-md border border-slate-300 px-3 text-sm outline-none focus:border-cyan-700"
                      value={input}
                      onChange={(event) => setInput(event.target.value)}
                      placeholder="输入你的回答，提交后面试官才会继续追问"
                    />
                    <button
                      type="submit"
                      className="inline-flex h-11 w-11 items-center justify-center rounded-md bg-[#16202a] text-white hover:bg-slate-800"
                      aria-label="发送回答"
                    >
                      <Send size={18} />
                    </button>
                  </form>
                )}

                {answerMode === "ai" && (
                  <div className="grid gap-2 md:grid-cols-3">
                    {strategies.length === 0 ? (
                      <div className="col-span-full rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-500">
                        策略还在生成，稍等片刻再选择。
                      </div>
                    ) : (
                      strategies.map((strategy) => (
                        <button
                          key={`${strategy.title}-${strategy.content}`}
                          type="button"
                          onClick={() => sendStrategy(strategy)}
                          className="rounded-md border border-slate-200 bg-slate-50 p-3 text-left transition hover:border-cyan-500 hover:bg-cyan-50"
                        >
                          <div className="text-sm font-semibold text-slate-950">{strategy.title}</div>
                          <div className="mt-1 text-xs text-cyan-800">{strategy.stance}</div>
                          <p className="mt-2 max-h-20 overflow-hidden text-xs leading-5 text-slate-600">{strategy.content}</p>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-500">
                {status === "thinking" ? <Loader2 className="animate-spin" size={17} /> : <Radar size={17} />}
                {sessionId ? "等待面试官和辅助 Agent 输出。" : "创建会话后开始。"}
              </div>
            )}
          </footer>
        </section>

        <aside className="grid min-h-[680px] gap-3">
          <section className="overflow-hidden rounded-lg border border-slate-300 bg-white shadow-sm">
            <header className="flex h-14 items-center justify-between border-b border-slate-200 px-4">
              <div className="flex items-center gap-2">
                <Radar className="text-rose-600" size={18} />
                <h2 className="text-sm font-semibold text-slate-950">潜台词雷达</h2>
              </div>
              <span className="rounded-full bg-rose-50 px-2 py-1 text-xs text-rose-700">Agent A</span>
            </header>
            <div className="h-[290px] overflow-y-auto whitespace-pre-wrap p-4 text-sm leading-6 text-slate-700">
              {analysis || "面试官发问后，这里会拆解真实意图、潜在陷阱和应对原则。"}
            </div>
          </section>

          <section className="overflow-hidden rounded-lg border border-slate-300 bg-white shadow-sm">
            <header className="flex h-14 items-center justify-between border-b border-slate-200 px-4">
              <div className="flex items-center gap-2">
                <ShieldCheck className="text-cyan-700" size={18} />
                <h2 className="text-sm font-semibold text-slate-950">策略提示卡片</h2>
              </div>
              <span className="rounded-full bg-cyan-50 px-2 py-1 text-xs text-cyan-800">Agent B</span>
            </header>
            <div className="grid max-h-[520px] gap-3 overflow-y-auto p-4">
              {strategies.length === 0 ? (
                <p className="rounded-md border border-dashed border-slate-300 p-4 text-sm leading-6 text-slate-500">
                  等待策略生成。选择 AI 替答后，可点击卡片直接作为候选人回答。
                </p>
              ) : (
                strategies.map((strategy) => (
                  <article key={`${strategy.title}-${strategy.content}`} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <div className="text-sm font-semibold text-slate-950">{strategy.title}</div>
                    <div className="mt-1 text-xs text-cyan-800">{strategy.stance}</div>
                    <p className="mt-2 text-sm leading-6 text-slate-700">{strategy.content}</p>
                  </article>
                ))
              )}
            </div>
          </section>

          {error && <div className="rounded-md bg-rose-50 p-3 text-sm text-rose-700">{error}</div>}
        </aside>
      </div>
    </main>
  );
}
