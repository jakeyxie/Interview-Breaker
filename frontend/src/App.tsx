import {
  ChangeEvent,
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
  Clock3,
  FileText,
  Flag,
  History,
  Link,
  Loader2,
  MessageSquareText,
  PenLine,
  Radar,
  Send,
  ShieldCheck,
  Sparkles,
  TimerReset,
  Upload,
  UserRound,
} from "lucide-react";

type Role = "interviewer" | "user" | "analyzer" | "strategist";
type AnswerMode = "idle" | "manual" | "ai";
type InterviewMode = "easy" | "pressure";
type SocketStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "thinking"
  | "waiting_user"
  | "waiting_user_choice"
  | "ended"
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
  interview_mode: InterviewMode;
  ended_at: string | null;
  end_reason: string | null;
};

type Report = {
  technical_fit?: { score?: number; summary?: string; fact_risks?: string[] };
  communication_structure?: { score?: number; summary?: string; star_observations?: string[] };
  emotional_stability?: { score?: number; summary?: string; pressure_moments?: string[] };
  improvement_plan?: { priorities?: string[]; study_directions?: string[]; next_practice?: string[] };
  overall_result?: string;
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
    ended: "面试已结束",
    error: "连接异常",
  };
  return labels[status];
}

function formatTime(value?: string | null) {
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

function formatRemaining(seconds: number) {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
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

async function fetchReport(sessionId: string) {
  const response = await fetch(`${API_URL}/api/session/${sessionId}/report`);
  if (!response.ok) {
    throw new Error("无法生成复盘报告");
  }
  const payload = (await response.json()) as { report: Report };
  return payload.report;
}

function useInterviewSocket(sessionId: string | null) {
  const socketRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<SocketStatus>("idle");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [analysis, setAnalysis] = useState("");
  const [strategies, setStrategies] = useState<StrategyCard[]>([]);
  const [deadlineAt, setDeadlineAt] = useState<string | null>(null);
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
      setStatus((current) => (current === "error" || current === "ended" ? current : "idle"));
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

      if (payload.type === "connected") {
        setDeadlineAt(payload.deadline_at ?? null);
        if (payload.status === "completed") {
          setStatus("ended");
        }
        return;
      }
      if (payload.type === "interview_ended") {
        setStatus("ended");
        setDeadlineAt(null);
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
      if (payload.deadline_at) {
        setDeadlineAt(String(payload.deadline_at));
      }
      if (payload.ended) {
        setStatus("ended");
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

  const endViaSocket = useCallback(() => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "end_interview" }));
    }
    setStatus("ended");
    setDeadlineAt(null);
  }, []);

  return {
    status,
    messages,
    analysis,
    strategies,
    deadlineAt,
    error,
    send,
    start,
    endViaSocket,
    replaceMessages,
  };
}

function ReportPanel({ report }: { report: Report | null }) {
  if (!report) {
    return (
      <p className="rounded-md border border-dashed border-slate-300 p-4 text-sm leading-6 text-slate-500">
        面试结束后，这里会生成技术契合度、沟通结构性、情绪稳定性和优化建议。
      </p>
    );
  }

  const blocks = [
    {
      title: "技术契合度",
      score: report.technical_fit?.score,
      summary: report.technical_fit?.summary,
      items: report.technical_fit?.fact_risks,
    },
    {
      title: "沟通结构性",
      score: report.communication_structure?.score,
      summary: report.communication_structure?.summary,
      items: report.communication_structure?.star_observations,
    },
    {
      title: "情绪稳定性",
      score: report.emotional_stability?.score,
      summary: report.emotional_stability?.summary,
      items: report.emotional_stability?.pressure_moments,
    },
    {
      title: "优化建议",
      score: undefined,
      summary: report.improvement_plan?.priorities?.join(" / "),
      items: [
        ...(report.improvement_plan?.study_directions ?? []),
        ...(report.improvement_plan?.next_practice ?? []),
      ],
    },
  ];

  return (
    <div className="space-y-3">
      <div className="rounded-md bg-slate-950 px-3 py-2 text-sm font-semibold text-cyan-200">
        综合结论：{report.overall_result ?? "needs_practice"}
      </div>
      {blocks.map((block) => (
        <article key={block.title} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-slate-950">{block.title}</h3>
            {typeof block.score === "number" && (
              <span className="rounded-full bg-cyan-50 px-2 py-1 text-xs font-semibold text-cyan-800">
                {block.score}
              </span>
            )}
          </div>
          <p className="mt-2 text-sm leading-6 text-slate-700">{block.summary || "暂无总结。"}</p>
          <ul className="mt-2 space-y-1 text-xs leading-5 text-slate-600">
            {(block.items ?? []).map((item) => (
              <li key={item}>- {item}</li>
            ))}
          </ul>
        </article>
      ))}
    </div>
  );
}

export default function App() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [jobTitle, setJobTitle] = useState("高级前端工程师");
  const [resume, setResume] = useState("");
  const [jdText, setJdText] = useState("");
  const [jdUrl, setJdUrl] = useState("");
  const [interviewMode, setInterviewMode] = useState<InterviewMode>("easy");
  const [input, setInput] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [isUploadingPdf, setIsUploadingPdf] = useState(false);
  const [isGeneratingReport, setIsGeneratingReport] = useState(false);
  const [createError, setCreateError] = useState("");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [answerMode, setAnswerMode] = useState<AnswerMode>("idle");
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const hasStartedRef = useRef(false);
  const {
    status,
    messages,
    analysis,
    strategies,
    deadlineAt,
    error,
    send,
    start,
    endViaSocket,
    replaceMessages,
  } = useInterviewSocket(sessionId);

  const conversationMessages = useMemo(
    () => messages.filter((message) => message.role === "interviewer" || message.role === "user"),
    [messages],
  );
  const hasQuestionWaiting = useMemo(() => {
    const lastInterviewMessage = [...conversationMessages]
      .reverse()
      .find((message) => message.role === "interviewer" || message.role === "user");
    return lastInterviewMessage?.role === "interviewer" && status !== "thinking" && status !== "ended";
  }, [conversationMessages, status]);

  const activeSession = sessions.find((session) => session.session_id === sessionId);
  const activeMode = activeSession?.interview_mode ?? interviewMode;
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
    if (status === "waiting_user" || status === "waiting_user_choice" || status === "ended") {
      refreshSessions();
    }
  }, [refreshSessions, status]);

  useEffect(() => {
    if (status === "ended" && sessionId && !report && !isGeneratingReport) {
      generateCurrentReport();
    }
  }, [isGeneratingReport, report, sessionId, status]);

  useEffect(() => {
    if (!deadlineAt || activeMode !== "pressure" || status === "ended") {
      setRemainingSeconds(0);
      return;
    }
    const tick = () => {
      setRemainingSeconds(Math.max(0, Math.floor((new Date(deadlineAt).getTime() - Date.now()) / 1000)));
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [activeMode, deadlineAt, status]);

  async function uploadPdf(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    setIsUploadingPdf(true);
    setCreateError("");
    try {
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch(`${API_URL}/api/session/resume/upload`, {
        method: "POST",
        body: formData,
      });
      if (!response.ok) {
        throw new Error("PDF 解析失败");
      }
      const payload = (await response.json()) as { text: string };
      setResume(payload.text);
    } catch (caught) {
      setCreateError(caught instanceof Error ? caught.message : "PDF 解析失败");
    } finally {
      setIsUploadingPdf(false);
      event.target.value = "";
    }
  }

  async function createSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreateError("");
    setIsCreating(true);
    setReport(null);
    try {
      const response = await fetch(`${API_URL}/api/session/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          job_title: jobTitle,
          resume,
          jd_text: jdText,
          jd_url: jdUrl,
          interview_mode: interviewMode,
          question_time_limit_seconds: 300,
        }),
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
    setReport(null);
    hasStartedRef.current = true;
    try {
      const history = await fetchMessages(nextSessionId);
      setSessionId(nextSessionId);
      replaceMessages(history);
      const nextSession = sessions.find((item) => item.session_id === nextSessionId);
      if (nextSession?.status === "completed") {
        setReport(await fetchReport(nextSessionId));
      }
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

  async function endInterview() {
    if (!sessionId) {
      return;
    }
    const confirmed = window.confirm("确定要结束这场面试并生成复盘吗？");
    if (!confirmed) {
      return;
    }
    setIsGeneratingReport(true);
    try {
      await fetch(`${API_URL}/api/session/${sessionId}/end`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "abandoned" }),
      });
      endViaSocket();
      setReport(await fetchReport(sessionId));
      await refreshSessions();
    } finally {
      setIsGeneratingReport(false);
    }
  }

  async function generateCurrentReport() {
    if (!sessionId) {
      return;
    }
    setIsGeneratingReport(true);
    try {
      setReport(await fetchReport(sessionId));
      await refreshSessions();
    } finally {
      setIsGeneratingReport(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#e9edf0] text-slate-950">
      <div className="grid min-h-screen grid-cols-1 gap-3 p-3 xl:grid-cols-[330px_minmax(540px,1fr)_410px]">
        <aside className="flex min-h-[220px] flex-col overflow-hidden rounded-lg border border-slate-300 bg-[#111820] text-slate-100 shadow-sm">
          <header className="border-b border-white/10 p-4">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-cyan-300">
              <Archive size={15} />
              Interview files
            </div>
            <h1 className="mt-3 text-2xl font-semibold tracking-tight">面试档案</h1>
            <p className="mt-1 text-sm leading-6 text-slate-400">导入简历和 JD，开始一场更贴近真实岗位的模拟。</p>
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

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setInterviewMode("easy")}
                className={`rounded-md border px-3 py-2 text-left text-sm ${
                  interviewMode === "easy" ? "border-cyan-300 bg-cyan-300/15 text-cyan-100" : "border-white/10 bg-white/[0.04] text-slate-300"
                }`}
              >
                <Clock3 size={16} />
                <div className="mt-1 font-semibold">Easy</div>
                <div className="text-xs text-slate-500">不限时</div>
              </button>
              <button
                type="button"
                onClick={() => setInterviewMode("pressure")}
                className={`rounded-md border px-3 py-2 text-left text-sm ${
                  interviewMode === "pressure" ? "border-cyan-300 bg-cyan-300/15 text-cyan-100" : "border-white/10 bg-white/[0.04] text-slate-300"
                }`}
              >
                <TimerReset size={16} />
                <div className="mt-1 font-semibold">压力</div>
                <div className="text-xs text-slate-500">每题 5 分钟</div>
              </button>
            </div>

            <label className="grid gap-1.5">
              <span className="flex items-center gap-2 text-xs font-medium text-slate-300">
                <FileText size={14} />
                简历 / 项目经历
              </span>
              <textarea
                className="min-h-28 resize-none rounded-md border border-white/10 bg-white/[0.08] p-3 text-sm leading-6 text-white outline-none ring-cyan-300/40 placeholder:text-slate-500 focus:ring-2"
                value={resume}
                onChange={(event) => setResume(event.target.value)}
                placeholder="手动输入，或上传 PDF 自动识别"
              />
            </label>
            <label className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-md border border-white/10 bg-white/[0.05] px-3 text-sm text-slate-200 hover:bg-white/[0.09]">
              {isUploadingPdf ? <Loader2 className="animate-spin" size={17} /> : <Upload size={17} />}
              上传 PDF 简历
              <input className="hidden" type="file" accept="application/pdf" onChange={uploadPdf} />
            </label>

            <label className="grid gap-1.5">
              <span className="flex items-center gap-2 text-xs font-medium text-slate-300">
                <Link size={14} />
                JD 链接
              </span>
              <input
                className="h-10 rounded-md border border-white/10 bg-white/[0.08] px-3 text-sm text-white outline-none ring-cyan-300/40 placeholder:text-slate-500 focus:ring-2"
                value={jdUrl}
                onChange={(event) => setJdUrl(event.target.value)}
                placeholder="https://..."
              />
            </label>
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-slate-300">JD 文本</span>
              <textarea
                className="min-h-24 resize-none rounded-md border border-white/10 bg-white/[0.08] p-3 text-sm leading-6 text-white outline-none ring-cyan-300/40 placeholder:text-slate-500 focus:ring-2"
                value={jdText}
                onChange={(event) => setJdText(event.target.value)}
                placeholder="粘贴岗位职责、任职要求"
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
                      <div className="mt-1 text-xs text-slate-500">
                        {formatTime(session.updated_at)} · {session.interview_mode}
                      </div>
                    </div>
                    <ChevronRight size={16} className="mt-0.5 text-slate-500" />
                  </div>
                  <p className="mt-2 max-h-10 overflow-hidden text-xs leading-5 text-slate-400">
                    {session.last_message || "尚未产生问答"}
                  </p>
                  <div className="mt-2 flex items-center justify-between text-xs">
                    <span className="text-cyan-200">{session.message_count} 条消息</span>
                    {session.status === "completed" && <span className="text-amber-200">已结束</span>}
                  </div>
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
              <div className="flex flex-wrap items-center gap-2">
                {activeMode === "pressure" && status !== "ended" && (
                  <div className={`rounded-md px-3 py-2 text-sm font-semibold ${remainingSeconds <= 60 && remainingSeconds > 0 ? "bg-rose-50 text-rose-700" : "bg-slate-950 text-cyan-200"}`}>
                    {remainingSeconds > 0 ? formatRemaining(remainingSeconds) : "等待计时"}
                  </div>
                )}
                <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
                  {isLoadingHistory ? "加载历史中" : statusCopy(status)}
                </div>
                {sessionId && status !== "ended" && (
                  <button
                    type="button"
                    onClick={endInterview}
                    className="inline-flex h-10 items-center gap-2 rounded-md bg-rose-600 px-3 text-sm font-semibold text-white hover:bg-rose-700"
                  >
                    <Flag size={16} />
                    放弃面试
                  </button>
                )}
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
                  <h3 className="mt-4 text-lg font-semibold">从左侧创建一场 JD 驱动面试</h3>
                  <p className="mt-2 text-sm leading-6 text-slate-500">
                    上传简历、粘贴 JD，系统会先拆解岗位诉求，再让面试官围绕核心要求追问。
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
            {status === "ended" ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-800">
                <span>面试已结束，可以查看或重新生成面后复盘。</span>
                <button
                  type="button"
                  onClick={generateCurrentReport}
                  className="inline-flex h-9 items-center gap-2 rounded-md bg-amber-600 px-3 font-semibold text-white"
                >
                  {isGeneratingReport ? <Loader2 className="animate-spin" size={16} /> : <FileText size={16} />}
                  生成复盘
                </button>
              </div>
            ) : hasQuestionWaiting ? (
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
            <div className="h-[230px] overflow-y-auto whitespace-pre-wrap p-4 text-sm leading-6 text-slate-700">
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
            <div className="grid max-h-[320px] gap-3 overflow-y-auto p-4">
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

          <section className="overflow-hidden rounded-lg border border-slate-300 bg-white shadow-sm">
            <header className="flex h-14 items-center justify-between border-b border-slate-200 px-4">
              <div className="flex items-center gap-2">
                <FileText className="text-amber-600" size={18} />
                <h2 className="text-sm font-semibold text-slate-950">面后复盘</h2>
              </div>
              <span className="rounded-full bg-amber-50 px-2 py-1 text-xs text-amber-700">Report</span>
            </header>
            <div className="max-h-[430px] overflow-y-auto p-4">
              <ReportPanel report={report} />
            </div>
          </section>

          {error && <div className="rounded-md bg-rose-50 p-3 text-sm text-rose-700">{error}</div>}
        </aside>
      </div>
    </main>
  );
}
