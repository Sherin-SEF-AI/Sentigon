"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { usePathname } from "next/navigation";
import {
  MessageSquare,
  Send,
  Brain,
  Loader2,
  X,
  Minimize2,
  Maximize2,
  Copy,
  CheckCircle2,
  Wrench,
  Sparkles,
  ChevronDown,
  AlertTriangle,
  Shield,
  Lock,
  Search,
  FolderOpen,
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
  action_results?: ActionResult[];
}

interface ChatResponse {
  session_id: string;
  response: string;
  tool_calls_made: number;
  tools_used: string[];
  action_results?: ActionResult[];
}

interface ActionResult {
  tool: string;
  success: boolean;
  summary: string;
  data?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/*  Page context mapping                                               */
/* ------------------------------------------------------------------ */

const PAGE_CONTEXT_MAP: Record<string, { label: string; entity_type: string }> = {
  "/": { label: "Dashboard", entity_type: "dashboard" },
  "/alerts": { label: "Alerts", entity_type: "alert" },
  "/video-wall": { label: "Video Wall", entity_type: "camera" },
  "/cases": { label: "Cases", entity_type: "case" },
  "/forensics": { label: "Forensics", entity_type: "forensics" },
  "/zones": { label: "Zones", entity_type: "zone" },
  "/agents": { label: "AI Agents", entity_type: "agent" },
  "/analytics": { label: "Analytics", entity_type: "analytics" },
  "/status": { label: "System Status", entity_type: "health" },
  "/dispatch": { label: "Dispatch", entity_type: "dispatch" },
  "/pacs": { label: "Access Control", entity_type: "access_control" },
  "/incidents": { label: "Incidents", entity_type: "incident" },
  "/cameras": { label: "Cameras", entity_type: "camera" },
  "/threat-response": { label: "Threat Response", entity_type: "threat" },
  "/compliance": { label: "Compliance", entity_type: "compliance" },
  "/privacy": { label: "Privacy & GDPR", entity_type: "privacy" },
  "/bolo": { label: "BOLO & Logbook", entity_type: "bolo" },
  "/evidence": { label: "Evidence", entity_type: "evidence" },
  "/lpr": { label: "Plate Reader", entity_type: "lpr" },
  "/visitors": { label: "Visitors", entity_type: "visitor" },
  "/patrol": { label: "Patrol Command", entity_type: "patrol" },
};

/* ------------------------------------------------------------------ */
/*  Context-aware quick suggestions                                    */
/* ------------------------------------------------------------------ */

function getContextSuggestions(pathname: string): string[] {
  if (pathname === "/" || pathname === "/status") {
    return [
      "What's the current threat level?",
      "Give me a shift summary",
      "Any cameras offline?",
    ];
  }
  if (pathname.startsWith("/alerts")) {
    return [
      "Summarize recent critical alerts",
      "Acknowledge all low-severity alerts",
      "What zones have the most alerts?",
    ];
  }
  if (pathname.startsWith("/cases") || pathname.startsWith("/forensics")) {
    return [
      "Create a case from the latest alert",
      "Search for suspicious activity in the last hour",
      "Draft an incident report",
    ];
  }
  if (pathname.startsWith("/video-wall") || pathname.startsWith("/cameras")) {
    return [
      "Which cameras are offline?",
      "Show me detections on all cameras",
      "Any blind spots in coverage?",
    ];
  }
  if (pathname.startsWith("/zones")) {
    return [
      "Which zones are over capacity?",
      "Show zone occupancy trends",
      "Any zones with unusual activity?",
    ];
  }
  if (pathname.startsWith("/dispatch")) {
    return [
      "What resources are available?",
      "Recommend dispatch for latest alert",
      "Show active dispatches",
    ];
  }
  if (pathname.startsWith("/pacs")) {
    return [
      "Any access violations today?",
      "Which doors are unlocked?",
      "Show tailgating events",
    ];
  }
  return [
    "What's happening right now?",
    "Any unusual activity?",
    "Give me a quick briefing",
  ];
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function generateId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/* ------------------------------------------------------------------ */
/*  Action Result Card                                                 */
/* ------------------------------------------------------------------ */

function ActionResultCard({ result }: { result: ActionResult }) {
  const iconMap: Record<string, React.ReactNode> = {
    acknowledge_alert: <AlertTriangle className="h-3.5 w-3.5" />,
    create_case: <FolderOpen className="h-3.5 w-3.5" />,
    lock_door: <Lock className="h-3.5 w-3.5" />,
    search_cameras: <Search className="h-3.5 w-3.5" />,
    get_alert_details: <Shield className="h-3.5 w-3.5" />,
  };

  return (
    <div
      className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${
        result.success
          ? "border-emerald-800/50 bg-emerald-950/30 text-emerald-300"
          : "border-red-800/50 bg-red-950/30 text-red-300"
      }`}
    >
      <div className="mt-0.5 shrink-0">
        {iconMap[result.tool] || <Wrench className="h-3.5 w-3.5" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-semibold">{result.tool.replace(/_/g, " ")}</div>
        <div className="text-[10px] opacity-80">{result.summary}</div>
      </div>
      {result.success ? (
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
      ) : (
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-400" />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Chat Message Bubble (compact version for widget)                   */
/* ------------------------------------------------------------------ */

function WidgetMessage({ message }: { message: ChatMessage }) {
  const [copied, setCopied] = useState(false);
  const isUser = message.role === "user";
  const time = message.timestamp.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  if (isUser) {
    return (
      <div className="flex justify-end px-3 py-1">
        <div className="max-w-[85%]">
          <div className="rounded-xl rounded-tr-sm bg-cyan-900/50 border border-cyan-800/40 px-3 py-2">
            <p className="text-xs text-cyan-100 whitespace-pre-wrap leading-relaxed">
              {message.content}
            </p>
          </div>
          <p className="text-right text-[9px] text-gray-600 pr-1 mt-0.5">{time}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2 px-3 py-1">
      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-purple-900/30 border border-purple-800/50 mt-0.5">
        <Brain className="h-3 w-3 text-purple-400" />
      </div>
      <div className="max-w-[85%] min-w-0">
        <div className="rounded-xl rounded-tl-sm bg-gray-800/80 border border-gray-700/50 px-3 py-2">
          <p className="text-xs text-gray-200 whitespace-pre-wrap leading-relaxed">
            {message.content.split(/(`[^`]+`)/g).map((segment, i) => {
              if (segment.startsWith("`") && segment.endsWith("`")) {
                return (
                  <code
                    key={i}
                    className="rounded bg-gray-700/60 px-1 py-0.5 text-[10px] font-mono text-cyan-300"
                  >
                    {segment.slice(1, -1)}
                  </code>
                );
              }
              return <span key={i}>{segment}</span>;
            })}
          </p>
        </div>
        {/* Action results */}
        {message.action_results && message.action_results.length > 0 && (
          <div className="mt-1.5 space-y-1">
            {message.action_results.map((result, i) => (
              <ActionResultCard key={i} result={result} />
            ))}
          </div>
        )}
        <div className="flex items-center gap-2 pl-1 mt-0.5">
          <span className="text-[9px] text-gray-600">{time}</span>
          <button
            onClick={() => {
              navigator.clipboard.writeText(message.content);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
            className="text-[9px] text-gray-600 hover:text-gray-400 transition-colors flex items-center gap-0.5"
          >
            {copied ? (
              <CheckCircle2 className="h-2.5 w-2.5 text-green-400" />
            ) : (
              <Copy className="h-2.5 w-2.5" />
            )}
          </button>
          {message.tool_calls_made !== undefined && message.tool_calls_made > 0 && (
            <span className="inline-flex items-center gap-0.5 rounded-full bg-purple-900/30 border border-purple-800/40 px-1.5 py-0.5 text-[9px] font-medium text-purple-400">
              <Wrench className="h-2 w-2" />
              {message.tool_calls_made} tool{message.tool_calls_made !== 1 ? "s" : ""}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Typing Indicator                                                   */
/* ------------------------------------------------------------------ */

function TypingDots() {
  return (
    <div className="flex items-start gap-2 px-3 py-1">
      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-purple-900/30 border border-purple-800/50">
        <Brain className="h-3 w-3 text-purple-400" />
      </div>
      <div className="flex items-center gap-1 rounded-xl rounded-tl-sm bg-gray-800/80 border border-gray-700/50 px-3 py-2">
        <div className="h-1.5 w-1.5 rounded-full bg-cyan-400 animate-bounce" style={{ animationDelay: "0ms" }} />
        <div className="h-1.5 w-1.5 rounded-full bg-cyan-400 animate-bounce" style={{ animationDelay: "150ms" }} />
        <div className="h-1.5 w-1.5 rounded-full bg-cyan-400 animate-bounce" style={{ animationDelay: "300ms" }} />
        <span className="ml-1.5 text-[10px] text-gray-500">Analyzing...</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  CopilotWidget — Main exported component                            */
/* ------------------------------------------------------------------ */

export default function CopilotWidget() {
  const pathname = usePathname();

  /* --- State --- */
  const [isOpen, setIsOpen] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("copilot_session_id");
    }
    return null;
  });
  const [isProcessing, setIsProcessing] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);

  /* --- Refs --- */
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  /* --- Context --- */
  const pageContext = PAGE_CONTEXT_MAP[pathname] || PAGE_CONTEXT_MAP["/"];
  const suggestions = getContextSuggestions(pathname);

  /* --- Auto-scroll --- */
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isProcessing]);

  /* --- Focus input when opened --- */
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 200);
    }
  }, [isOpen]);

  /* --- Send message --- */
  const sendMessage = useCallback(
    async (content: string) => {
      if (!content.trim() || isProcessing) return;

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
          timeoutMs: 120000,
          body: JSON.stringify({
            message: content.trim(),
            session_id: sessionId,
            context: {
              page: pathname,
              page_label: pageContext?.label || "Unknown",
              entity_type: pageContext?.entity_type || "general",
            },
          }),
        });

        if (data.session_id) {
          setSessionId(data.session_id);
          localStorage.setItem("copilot_session_id", data.session_id);
        }

        const assistantMessage: ChatMessage = {
          id: generateId(),
          role: "assistant",
          content: data.response,
          timestamp: new Date(),
          tool_calls_made: data.tool_calls_made,
          tools_used: data.tools_used,
          action_results: data.action_results,
        };
        setMessages((prev) => [...prev, assistantMessage]);

        if (!isOpen) {
          setUnreadCount((c) => c + 1);
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "Failed to get response";
        const errorMessage: ChatMessage = {
          id: generateId(),
          role: "assistant",
          content: `Error: ${errorMsg}\n\nPlease try again.`,
          timestamp: new Date(),
        };
        setMessages((prev) => [...prev, errorMessage]);
      } finally {
        setIsProcessing(false);
        setTimeout(() => inputRef.current?.focus(), 100);
      }
    },
    [isProcessing, sessionId, pathname, pageContext, isOpen]
  );

  /* --- Handle submit --- */
  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      sendMessage(inputValue);
    },
    [inputValue, sendMessage]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage(inputValue);
      }
    },
    [inputValue, sendMessage]
  );

  /* --- Clear unread on open --- */
  useEffect(() => {
    if (isOpen) setUnreadCount(0);
  }, [isOpen]);

  /* --- New session --- */
  const startNewSession = useCallback(() => {
    setSessionId(null);
    setMessages([]);
    localStorage.removeItem("copilot_session_id");
  }, []);

  // Don't render on copilot full page or login
  if (pathname === "/copilot" || pathname === "/login") return null;

  /* --- Collapsed bubble --- */
  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="fixed bottom-5 right-5 z-[9990] flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-cyan-600 to-cyan-700 text-white shadow-lg shadow-cyan-900/40 hover:from-cyan-500 hover:to-cyan-600 hover:shadow-xl hover:shadow-cyan-900/50 transition-all duration-200 active:scale-95 group"
        title="Open SOC Copilot"
      >
        <MessageSquare className="h-5 w-5 group-hover:scale-110 transition-transform" />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white shadow">
            {unreadCount}
          </span>
        )}
        <span className="absolute -top-0.5 -right-0.5 h-3 w-3 rounded-full bg-green-500 border-2 border-gray-950 animate-pulse" />
      </button>
    );
  }

  /* --- Expanded panel --- */
  const panelWidth = isExpanded ? "w-[600px]" : "w-[380px]";
  const panelHeight = isExpanded ? "h-[80vh]" : "h-[520px]";

  return (
    <div
      className={`fixed bottom-5 right-5 z-[9990] ${panelWidth} ${panelHeight} flex flex-col rounded-2xl border border-gray-800 bg-gray-950 shadow-2xl shadow-black/60 transition-all duration-200`}
    >
      {/* ---- Header ---- */}
      <div className="flex items-center justify-between border-b border-gray-800 px-4 py-2.5 shrink-0">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-cyan-900/30 border border-cyan-800/50">
            <Brain className="h-3.5 w-3.5 text-cyan-400" />
          </div>
          <div>
            <h3 className="text-xs font-bold text-gray-100">SOC Copilot</h3>
            <div className="flex items-center gap-1.5">
              <div className="h-1.5 w-1.5 rounded-full bg-green-500" />
              <span className="text-[9px] text-gray-500">
                {pageContext?.label || "Active"}
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={startNewSession}
            className="rounded-md px-2 py-1 text-[9px] text-gray-500 hover:bg-gray-800 hover:text-gray-300 transition-colors"
            title="New Chat"
          >
            New
          </button>
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="rounded-md p-1.5 text-gray-500 hover:bg-gray-800 hover:text-gray-300 transition-colors"
            title={isExpanded ? "Minimize" : "Expand"}
          >
            {isExpanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
          <button
            onClick={() => setIsOpen(false)}
            className="rounded-md p-1.5 text-gray-500 hover:bg-gray-800 hover:text-gray-300 transition-colors"
            title="Close"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* ---- Messages ---- */}
      <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-track-gray-950 scrollbar-thumb-gray-800">
        {messages.length === 0 && !isProcessing ? (
          /* Welcome + context suggestions */
          <div className="flex flex-col items-center justify-center h-full px-6 py-8 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-900/40 to-purple-900/40 border border-cyan-800/30 mb-4">
              <Sparkles className="h-6 w-6 text-cyan-400" />
            </div>
            <p className="text-xs text-gray-400 mb-4">
              I have context about your current view ({pageContext?.label}).
              <br />
              Ask me anything or try a suggestion:
            </p>
            <div className="space-y-1.5 w-full max-w-[280px]">
              {suggestions.map((s) => (
                <button
                  key={s}
                  onClick={() => sendMessage(s)}
                  className="w-full rounded-lg border border-gray-800 bg-gray-900/60 px-3 py-2 text-left text-[11px] text-gray-400 hover:border-cyan-800/50 hover:bg-cyan-950/20 hover:text-cyan-300 transition-all"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="py-2 space-y-0.5">
            {messages.map((msg) => (
              <WidgetMessage key={msg.id} message={msg} />
            ))}
            {isProcessing && <TypingDots />}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* ---- Scroll to bottom button ---- */}
      {messages.length > 4 && (
        <button
          onClick={() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })}
          className="absolute bottom-[72px] right-4 rounded-full bg-gray-800 border border-gray-700 p-1.5 text-gray-400 hover:text-gray-200 shadow-lg transition-colors"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      )}

      {/* ---- Input ---- */}
      <div className="border-t border-gray-800 bg-gray-900/50 px-3 py-2.5 shrink-0">
        <form onSubmit={handleSubmit} className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={`Ask about ${pageContext?.label?.toLowerCase() || "security"}...`}
            disabled={isProcessing}
            rows={1}
            className="flex-1 resize-none rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-xs text-gray-200 placeholder:text-gray-600 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700/50 disabled:opacity-50 transition-all"
            style={{ minHeight: "36px", maxHeight: "80px" }}
            onInput={(e) => {
              const target = e.target as HTMLTextAreaElement;
              target.style.height = "auto";
              target.style.height = `${Math.min(target.scrollHeight, 80)}px`;
            }}
          />
          <button
            type="submit"
            disabled={!inputValue.trim() || isProcessing}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-cyan-600 text-white hover:bg-cyan-500 disabled:bg-gray-800 disabled:text-gray-600 disabled:cursor-not-allowed transition-all active:scale-95"
          >
            {isProcessing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
