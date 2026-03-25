"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  MessageSquare,
  Send,
  Brain,
  Loader2,
  AlertTriangle,
  ShieldAlert,
  Activity,
  Camera,
  Footprints,
  FileText,
  ShieldCheck,
  Users,
  Clock,
  Wrench,
  Sparkles,
  Copy,
  CheckCircle2,
  Trash2,
  History,
  X,
} from "lucide-react";
import { apiFetch } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  tool_calls_made?: number;
  tools_used?: string[];
}

interface ChatResponse {
  session_id: string;
  response: string;
  tool_calls_made: number;
  tools_used: string[];
}

interface QuickAction {
  id: string;
  label: string;
  description: string;
  prompt: string;
  icon: string;
}

interface CopilotSession {
  id: string;
  title: string;
  message_count: number;
  created_at: string;
  updated_at: string;
}

/* ------------------------------------------------------------------ */
/*  Quick-action icon map                                              */
/* ------------------------------------------------------------------ */

const ICON_MAP: Record<string, React.ReactNode> = {
  clock: <Clock className="h-4 w-4" />,
  shield_alert: <ShieldAlert className="h-4 w-4" />,
  activity: <Activity className="h-4 w-4" />,
  camera: <Camera className="h-4 w-4" />,
  footprints: <Footprints className="h-4 w-4" />,
  file_text: <FileText className="h-4 w-4" />,
  shield_check: <ShieldCheck className="h-4 w-4" />,
  users: <Users className="h-4 w-4" />,
};

/* ------------------------------------------------------------------ */
/*  Default quick actions (fallback if API is unavailable)             */
/* ------------------------------------------------------------------ */

const DEFAULT_QUICK_ACTIONS: QuickAction[] = [
  {
    id: "shift_summary",
    label: "Shift Summary",
    description: "Overview of current shift events",
    prompt: "Give me a complete summary of the current shift including all incidents, alerts, and notable events.",
    icon: "clock",
  },
  {
    id: "threat_level",
    label: "Current Threat Level",
    description: "Facility-wide threat assessment",
    prompt: "What is the current threat level across all zones? Provide a breakdown by zone with any active concerns.",
    icon: "shield_alert",
  },
  {
    id: "unusual_activity",
    label: "Unusual Activity",
    description: "Anomalies detected by agents",
    prompt: "Report any unusual or anomalous activity detected in the last 2 hours across all cameras and sensors.",
    icon: "activity",
  },
  {
    id: "camera_health",
    label: "Camera Health",
    description: "Status of all camera feeds",
    prompt: "Provide a health check on all camera feeds. List any cameras that are offline, degraded, or showing errors.",
    icon: "camera",
  },
  {
    id: "foot_traffic",
    label: "Foot Traffic Analysis",
    description: "Pedestrian flow patterns",
    prompt: "Analyze the current foot traffic patterns across all zones. Highlight any areas with unusually high or low activity.",
    icon: "footprints",
  },
  {
    id: "draft_report",
    label: "Draft Incident Report",
    description: "Generate a report from recent events",
    prompt: "Draft a formal incident report based on the most recent critical or high-severity alert, including timeline, involved zones, and recommended actions.",
    icon: "file_text",
  },
  {
    id: "compliance",
    label: "Compliance Status",
    description: "Security policy compliance check",
    prompt: "Check the current compliance status across all zones. Are there any policy violations or areas that need attention?",
    icon: "shield_check",
  },
  {
    id: "agent_briefing",
    label: "Agent Briefing",
    description: "AI agent fleet status summary",
    prompt: "Provide a briefing on the current status of all SENTINEL AI agents. Which agents are active, their recent actions, and any issues.",
    icon: "users",
  },
];

/* ------------------------------------------------------------------ */
/*  Helper: generate message ID                                        */
/* ------------------------------------------------------------------ */

function generateId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/* ------------------------------------------------------------------ */
/*  QuickActionButton                                                  */
/* ------------------------------------------------------------------ */

interface QuickActionButtonProps {
  action: QuickAction;
  onClick: (action: QuickAction) => void;
  disabled: boolean;
}

function QuickActionButton({ action, onClick, disabled }: QuickActionButtonProps) {
  const icon = ICON_MAP[action.icon] || <Sparkles className="h-4 w-4" />;

  return (
    <button
      onClick={() => onClick(action)}
      disabled={disabled}
      className={
        "flex flex-col items-start gap-1.5 rounded-lg border border-gray-800 bg-gray-900/60 px-3 py-2.5 text-left transition-all duration-200 " +
        "hover:border-cyan-800/60 hover:bg-cyan-950/20 hover:shadow-lg hover:shadow-cyan-950/10 " +
        "disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-gray-800 disabled:hover:bg-gray-900/60 disabled:hover:shadow-none " +
        "group"
      }
    >
      <div className="flex items-center gap-2 text-cyan-400 group-hover:text-cyan-300 transition-colors">
        {icon}
        <span className="text-xs font-semibold tracking-wide">{action.label}</span>
      </div>
      <p className="text-[10px] leading-tight text-gray-500 group-hover:text-gray-400 transition-colors">
        {action.description}
      </p>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  TypingIndicator                                                    */
/* ------------------------------------------------------------------ */

function TypingIndicator() {
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-purple-900/30 border border-purple-800/50">
        <Brain className="h-3.5 w-3.5 text-purple-400" />
      </div>
      <div className="flex items-center gap-1.5 rounded-xl rounded-tl-sm bg-gray-800/80 border border-gray-700/50 px-4 py-3">
        <div className="h-2 w-2 rounded-full bg-cyan-400 animate-bounce" style={{ animationDelay: "0ms" }} />
        <div className="h-2 w-2 rounded-full bg-cyan-400 animate-bounce" style={{ animationDelay: "150ms" }} />
        <div className="h-2 w-2 rounded-full bg-cyan-400 animate-bounce" style={{ animationDelay: "300ms" }} />
        <span className="ml-2 text-xs text-gray-500">Analyzing...</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  ChatMessageBubble                                                  */
/* ------------------------------------------------------------------ */

interface ChatMessageBubbleProps {
  message: ChatMessage;
}

function ChatMessageBubble({ message }: ChatMessageBubbleProps) {
  const [copied, setCopied] = useState(false);
  const isUser = message.role === "user";
  const time = message.timestamp.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  if (isUser) {
    return (
      <div className="flex justify-end px-4 py-1.5">
        <div className="max-w-[70%] space-y-1">
          <div className="rounded-xl rounded-tr-sm bg-cyan-900/50 border border-cyan-800/40 px-4 py-3">
            <p className="text-sm text-cyan-100 whitespace-pre-wrap leading-relaxed">
              {message.content}
            </p>
          </div>
          <p className="text-right text-[10px] text-gray-600 pr-1">{time}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3 px-4 py-1.5">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-purple-900/30 border border-purple-800/50 mt-0.5">
        <Brain className="h-3.5 w-3.5 text-purple-400" />
      </div>
      <div className="max-w-[75%] space-y-1">
        <div className="rounded-xl rounded-tl-sm bg-gray-800/80 border border-gray-700/50 px-4 py-3">
          <p className="text-sm text-gray-200 whitespace-pre-wrap leading-relaxed font-[inherit]"
             style={{ fontFamily: "inherit" }}>
            {message.content.split(/(`[^`]+`)/g).map((segment, i) => {
              if (segment.startsWith("`") && segment.endsWith("`")) {
                return (
                  <code
                    key={i}
                    className="rounded bg-gray-700/60 px-1.5 py-0.5 text-xs font-mono text-cyan-300"
                  >
                    {segment.slice(1, -1)}
                  </code>
                );
              }
              return <span key={i}>{segment}</span>;
            })}
          </p>
        </div>
        <div className="flex items-center gap-2 pl-1">
          <span className="text-[10px] text-gray-600">{time}</span>
          <button
            onClick={() => {
              navigator.clipboard.writeText(message.content);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
            className="text-[10px] text-gray-600 hover:text-gray-400 transition-colors flex items-center gap-0.5"
          >
            {copied ? <CheckCircle2 className="h-2.5 w-2.5 text-green-400" /> : <Copy className="h-2.5 w-2.5" />}
            {copied ? "Copied" : "Copy"}
          </button>
          {message.tool_calls_made !== undefined && message.tool_calls_made > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-purple-900/30 border border-purple-800/40 px-2 py-0.5 text-[10px] font-medium text-purple-400">
              <Wrench className="h-2.5 w-2.5" />
              Used {message.tool_calls_made} tool{message.tool_calls_made !== 1 ? "s" : ""}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  WelcomeState                                                       */
/* ------------------------------------------------------------------ */

function WelcomeState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-8 py-12 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-cyan-900/40 to-purple-900/40 border border-cyan-800/30 mb-6">
        <Brain className="h-8 w-8 text-cyan-400" />
      </div>
      <h2 className="text-xl font-bold text-gray-200 tracking-wide mb-2">
        SENTINEL SOC Copilot
      </h2>
      <p className="max-w-md text-sm leading-relaxed text-gray-500">
        Your AI-powered security operations partner. Ask questions about alerts,
        threats, camera status, compliance, or use the quick actions on the left
        to get started.
      </p>
      <div className="mt-6 flex items-center gap-2 text-xs text-gray-600">
        <div className="h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" />
        <span>Connected to SENTINEL AI backend</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  SOCCopilotPage (main)                                              */
/* ------------------------------------------------------------------ */

export default function SOCCopilotPage() {
  /* --- State --- */
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("copilot_session_id");
    }
    return null;
  });
  const [isProcessing, setIsProcessing] = useState(false);
  const [quickActions, setQuickActions] = useState<QuickAction[]>(DEFAULT_QUICK_ACTIONS);
  const [error, setError] = useState<string | null>(null);

  /* --- Session history --- */
  const [sessions, setSessions] = useState<CopilotSession[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);

  /* --- Refs --- */
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  /* --- Auto-scroll to bottom --- */
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, isProcessing, scrollToBottom]);

  /* --- Load quick actions from API --- */
  useEffect(() => {
    async function loadQuickActions() {
      try {
        const data = await apiFetch<{ actions: QuickAction[] }>("/api/copilot/quick-actions");
        if (data.actions && data.actions.length > 0) {
          setQuickActions(data.actions);
        }
      } catch {
        // Fallback to defaults silently
      }
    }
    loadQuickActions();
  }, []);

  /* --- Send message --- */
  const sendMessage = useCallback(
    async (content: string) => {
      if (!content.trim() || isProcessing) return;

      setError(null);

      // Add user message
      const userMessage: ChatMessage = {
        id: generateId(),
        role: "user",
        content: content.trim(),
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, userMessage]);
      setInputValue("");
      setIsProcessing(true);

      try {
        const data = await apiFetch<ChatResponse>("/api/copilot/chat", {
          method: "POST",
          timeoutMs: 120000, // AI inference can take up to 2 minutes
          body: JSON.stringify({
            message: content.trim(),
            session_id: sessionId,
          }),
        });

        // Store session ID for continuity (persisted across page refreshes)
        if (data.session_id) {
          setSessionId(data.session_id);
          localStorage.setItem("copilot_session_id", data.session_id);
        }

        // Add assistant response
        const assistantMessage: ChatMessage = {
          id: generateId(),
          role: "assistant",
          content: data.response,
          timestamp: new Date(),
          tool_calls_made: data.tool_calls_made,
          tools_used: data.tools_used,
        };
        setMessages((prev) => [...prev, assistantMessage]);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "Failed to get response";
        setError(errorMsg);

        // Add error as assistant message
        const errorMessage: ChatMessage = {
          id: generateId(),
          role: "assistant",
          content: `I encountered an error processing your request: ${errorMsg}\n\nPlease try again or rephrase your question.`,
          timestamp: new Date(),
        };
        setMessages((prev) => [...prev, errorMessage]);
      } finally {
        setIsProcessing(false);
        // Refocus input
        setTimeout(() => inputRef.current?.focus(), 100);
      }
    },
    [isProcessing, sessionId]
  );

  /* --- Handle quick action --- */
  const handleQuickAction = useCallback(
    async (action: QuickAction) => {
      if (isProcessing) return;

      setError(null);

      // Show the action as a user message
      const userMessage: ChatMessage = {
        id: generateId(),
        role: "user",
        content: action.prompt,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, userMessage]);
      setIsProcessing(true);

      try {
        const data = await apiFetch<ChatResponse>("/api/copilot/quick-action", {
          method: "POST",
          body: JSON.stringify({
            action: action.id,
            session_id: sessionId,
          }),
        });

        if (data.session_id) {
          setSessionId(data.session_id);
        }

        const assistantMessage: ChatMessage = {
          id: generateId(),
          role: "assistant",
          content: data.response,
          timestamp: new Date(),
          tool_calls_made: data.tool_calls_made,
          tools_used: data.tools_used,
        };
        setMessages((prev) => [...prev, assistantMessage]);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "Failed to execute action";
        setError(errorMsg);

        const errorMessage: ChatMessage = {
          id: generateId(),
          role: "assistant",
          content: `I encountered an error executing "${action.label}": ${errorMsg}\n\nPlease try again.`,
          timestamp: new Date(),
        };
        setMessages((prev) => [...prev, errorMessage]);
      } finally {
        setIsProcessing(false);
        setTimeout(() => inputRef.current?.focus(), 100);
      }
    },
    [isProcessing, sessionId]
  );

  /* --- Handle input submit --- */
  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      sendMessage(inputValue);
    },
    [inputValue, sendMessage]
  );

  /* --- Handle Enter key (Shift+Enter for newline) --- */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage(inputValue);
      }
    },
    [inputValue, sendMessage]
  );

  /* --- Session history functions --- */
  const fetchSessions = useCallback(async () => {
    setLoadingHistory(true);
    try {
      const data = await apiFetch<{ sessions: CopilotSession[] }>("/api/copilot/sessions");
      setSessions(data.sessions ?? []);
    } catch {
      setSessions([]);
    } finally {
      setLoadingHistory(false);
    }
  }, []);

  const loadSession = useCallback(async (sid: string) => {
    try {
      const data = await apiFetch<{ session_id: string; messages: { role: string; content: string; timestamp?: string }[] }>(`/api/copilot/sessions/${sid}`);
      setSessionId(data.session_id);
      setMessages(
        (data.messages ?? []).map((m, i) => ({
          id: `hist_${i}_${Date.now()}`,
          role: m.role as "user" | "assistant",
          content: m.content,
          timestamp: m.timestamp ? new Date(m.timestamp) : new Date(),
        }))
      );
      setShowHistory(false);
    } catch { /* ignore */ }
  }, []);

  const deleteSession = useCallback(async (sid: string) => {
    try {
      await apiFetch(`/api/copilot/sessions/${sid}`, { method: "DELETE" });
      setSessions((prev) => prev.filter((s) => s.id !== sid));
      if (sessionId === sid) {
        setSessionId(null);
        setMessages([]);
      }
    } catch { /* ignore */ }
  }, [sessionId]);

  const startNewSession = useCallback(() => {
    setSessionId(null);
    setMessages([]);
    setError(null);
  }, []);

  /* --- Backend health check --- */
  const [isBackendOnline, setIsBackendOnline] = useState(true);

  useEffect(() => {
    async function checkHealth() {
      try {
        const res = await fetch("/api/health/live");
        setIsBackendOnline(res.ok);
      } catch {
        setIsBackendOnline(false);
      }
    }
    checkHealth();
  }, []);

  /* --- Derived state --- */
  const messageCount = useMemo(() => messages.length, [messages]);

  const exchangeCount = useMemo(
    () => Math.ceil(messageCount / 2),
    [messageCount]
  );

  /* --- Render --- */
  return (
    <div className="flex h-full flex-col bg-gray-950">
      {/* ---- Header ---- */}
      <div className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-cyan-900/30 border border-cyan-800/50">
            <MessageSquare className="h-5 w-5 text-cyan-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-wide text-gray-100">
              SOC Copilot
            </h1>
            <p className="text-xs text-gray-500">
              Your AI Security Partner
            </p>
          </div>
        </div>

        {/* Session info */}
        <div className="flex items-center gap-3 text-xs text-gray-500">
          {sessionId && (
            <span className="hidden sm:inline font-mono text-gray-600">
              Session: {sessionId.slice(0, 8)}
            </span>
          )}
          <span>
            <span className="font-semibold text-gray-300">{messageCount}</span>{" "}
            message{messageCount !== 1 ? "s" : ""}
          </span>
          <div className="flex items-center gap-1.5">
            <div className={`h-1.5 w-1.5 rounded-full animate-pulse ${isBackendOnline ? "bg-green-500" : "bg-red-500"}`} />
            <span className={isBackendOnline ? "text-green-500" : "text-red-500"}>{isBackendOnline ? "Online" : "Offline"}</span>
          </div>
          <button
            onClick={startNewSession}
            className="rounded-md border border-gray-700 bg-gray-800 px-2.5 py-1 text-[10px] text-gray-400 hover:text-gray-200 transition-colors"
          >
            New Chat
          </button>
          <button
            onClick={() => { setShowHistory(!showHistory); if (!showHistory) fetchSessions(); }}
            className="rounded-md border border-gray-700 bg-gray-800 px-2.5 py-1 text-[10px] text-gray-400 hover:text-gray-200 transition-colors flex items-center gap-1"
          >
            <History className="h-3 w-3" />
            History
          </button>
        </div>
      </div>

      {/* ---- Main content area ---- */}
      <div className="flex flex-1 overflow-hidden">
        {/* ---- Left sidebar: Quick actions ---- */}
        <div className="hidden md:flex w-64 shrink-0 flex-col border-r border-gray-800 bg-gray-950/50">
          <div className="px-4 py-3 border-b border-gray-800/50">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400">
              Quick Actions
            </h2>
            <p className="mt-0.5 text-[10px] text-gray-600">
              Click to execute instantly
            </p>
          </div>

          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2 scrollbar-thin scrollbar-track-gray-950 scrollbar-thumb-gray-800">
            {quickActions.map((action) => (
              <QuickActionButton
                key={action.id}
                action={action}
                onClick={handleQuickAction}
                disabled={isProcessing}
              />
            ))}
          </div>

          {/* Sidebar footer */}
          <div className="border-t border-gray-800/50 px-4 py-3">
            <p className="text-[10px] text-gray-600 leading-relaxed">
              Powered by SENTINEL AI multi-agent reasoning engine with access to
              live camera feeds, alerts, and zone data.
            </p>
          </div>
        </div>

        {/* ---- Session History Sidebar ---- */}
        {showHistory && (
          <div className="w-64 shrink-0 flex flex-col border-r border-gray-800 bg-gray-950/50">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800/50">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400">
                Session History
              </h2>
              <button onClick={() => setShowHistory(false)} className="text-gray-500 hover:text-gray-300">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-3 py-3 space-y-1.5">
              {loadingHistory ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-4 w-4 animate-spin text-cyan-400" />
                </div>
              ) : sessions.length === 0 ? (
                <p className="text-[10px] text-gray-600 text-center py-8">No past sessions</p>
              ) : (
                sessions.map((s) => (
                  <div
                    key={s.id}
                    className={`group rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                      sessionId === s.id
                        ? "border-cyan-800/50 bg-cyan-900/20"
                        : "border-gray-800 bg-gray-900/40 hover:border-gray-700"
                    }`}
                    onClick={() => loadSession(s.id)}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-gray-300 truncate">
                        {s.title || `Session ${s.id.slice(0, 8)}`}
                      </span>
                      <button
                        onClick={(e) => { e.stopPropagation(); deleteSession(s.id); }}
                        className="hidden group-hover:block text-gray-600 hover:text-red-400 transition-colors"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[10px] text-gray-600">{s.message_count} msgs</span>
                      <span className="text-[10px] text-gray-600">
                        {new Date(s.updated_at || s.created_at).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* ---- Chat area ---- */}
        <div className="flex flex-1 flex-col min-w-0">
          {/* Messages area */}
          <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-track-gray-950 scrollbar-thumb-gray-800">
            {messages.length === 0 && !isProcessing ? (
              <WelcomeState />
            ) : (
              <div className="py-4 space-y-1">
                {messages.map((msg) => (
                  <ChatMessageBubble key={msg.id} message={msg} />
                ))}
                {isProcessing && <TypingIndicator />}
                <div ref={messagesEndRef} />
              </div>
            )}
            {messages.length > 0 && !isProcessing && (
              <div ref={messagesEndRef} />
            )}
          </div>

          {/* Error banner */}
          {error && (
            <div className="mx-4 mb-2 flex items-center gap-2 rounded-lg border border-red-800/50 bg-red-950/30 px-3 py-2">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-400" />
              <p className="text-xs text-red-400 truncate">{error}</p>
              <button
                onClick={() => setError(null)}
                className="ml-auto shrink-0 text-[10px] text-red-500 hover:text-red-300 transition-colors"
              >
                Dismiss
              </button>
            </div>
          )}

          {/* ---- Input bar ---- */}
          <div className="border-t border-gray-800 bg-gray-900/50 px-4 py-3">
            <form onSubmit={handleSubmit} className="flex items-end gap-3">
              <div className="relative flex-1">
                <textarea
                  ref={inputRef}
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask your AI security partner anything..."
                  disabled={isProcessing}
                  rows={1}
                  className={
                    "w-full resize-none rounded-xl border border-gray-700 bg-gray-900 px-4 py-3 pr-12 text-sm text-gray-200 " +
                    "placeholder:text-gray-600 " +
                    "focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700/50 " +
                    "disabled:opacity-50 disabled:cursor-not-allowed " +
                    "scrollbar-thin scrollbar-track-gray-900 scrollbar-thumb-gray-700 " +
                    "transition-all duration-200"
                  }
                  style={{
                    minHeight: "44px",
                    maxHeight: "120px",
                    height: "auto",
                  }}
                  onInput={(e) => {
                    const target = e.target as HTMLTextAreaElement;
                    target.style.height = "auto";
                    target.style.height = `${Math.min(target.scrollHeight, 120)}px`;
                  }}
                />
              </div>

              <button
                type="submit"
                disabled={!inputValue.trim() || isProcessing}
                className={
                  "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition-all duration-200 " +
                  "bg-cyan-600 text-white " +
                  "hover:bg-cyan-500 hover:shadow-lg hover:shadow-cyan-600/20 " +
                  "disabled:bg-gray-800 disabled:text-gray-600 disabled:cursor-not-allowed disabled:shadow-none " +
                  "active:scale-95"
                }
              >
                {isProcessing ? (
                  <Loader2 className="h-4.5 w-4.5 animate-spin" />
                ) : (
                  <Send className="h-4.5 w-4.5" />
                )}
              </button>
            </form>

            {/* Input footer info */}
            <div className="mt-2 flex items-center justify-between text-[10px] text-gray-600">
              <span>
                Press <kbd className="rounded border border-gray-700 bg-gray-800 px-1 py-0.5 font-mono text-[9px] text-gray-500">Enter</kbd> to
                send, <kbd className="rounded border border-gray-700 bg-gray-800 px-1 py-0.5 font-mono text-[9px] text-gray-500">Shift+Enter</kbd> for
                new line
              </span>
              <span>
                {messageCount > 0 && (
                  <>
                    {exchangeCount} exchange{exchangeCount !== 1 ? "s" : ""} this session
                  </>
                )}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
