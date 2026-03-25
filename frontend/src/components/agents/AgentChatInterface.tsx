"use client";

import { useState, useRef, useEffect, useCallback, FormEvent } from "react";
import {
  Brain,
  ChevronDown,
  Loader2,
  MessageSquare,
  Send,
  Sparkles,
  User,
  Wrench,
} from "lucide-react";
import { cn, apiFetch } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ChatMessage {
  id: string;
  role: "operator" | "cortex";
  content: string;
  timestamp: string;
  tool_calls?: { name: string; result?: string }[];
}

interface ChatResponse {
  response: string;
  tool_calls?: { name: string; result?: string }[];
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const SUGGESTED_QUERIES = [
  "What's happening right now?",
  "Any active threats?",
  "Run a patrol check",
];

/* ------------------------------------------------------------------ */
/*  MessageBubble                                                      */
/* ------------------------------------------------------------------ */

function MessageBubble({ message }: { message: ChatMessage }) {
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const isOperator = message.role === "operator";

  return (
    <div
      className={cn(
        "flex gap-2.5",
        isOperator ? "justify-end" : "justify-start"
      )}
    >
      {/* Avatar for cortex */}
      {!isOperator && (
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-cyan-900/40 border border-cyan-800/50">
          <Brain className="h-3.5 w-3.5 text-cyan-400" />
        </div>
      )}

      <div
        className={cn(
          "max-w-[80%] rounded-lg px-3.5 py-2.5 text-sm leading-relaxed",
          isOperator
            ? "bg-gray-800 text-gray-200 rounded-br-sm"
            : "bg-cyan-900/30 border border-cyan-800/30 text-gray-200 rounded-bl-sm"
        )}
      >
        {/* Message content */}
        <p className="whitespace-pre-wrap">{message.content}</p>

        {/* Tool calls */}
        {message.tool_calls && message.tool_calls.length > 0 && (
          <div className="mt-2 border-t border-gray-700/50 pt-2">
            <button
              onClick={() => setToolsExpanded(!toolsExpanded)}
              className="flex items-center gap-1.5 text-[11px] font-semibold text-blue-400 hover:text-blue-300 transition-colors"
            >
              <Wrench className="h-3 w-3" />
              {message.tool_calls.length} tool call
              {message.tool_calls.length > 1 ? "s" : ""}
              <ChevronDown
                className={cn(
                  "h-2.5 w-2.5 transition-transform duration-150",
                  toolsExpanded && "rotate-180"
                )}
              />
            </button>
            {toolsExpanded && (
              <div className="mt-1.5 space-y-1">
                {message.tool_calls.map((tc, i) => (
                  <div
                    key={i}
                    className="rounded border border-gray-800 bg-gray-950/60 px-2.5 py-1.5"
                  >
                    <p className="font-mono text-[11px] text-blue-300">
                      {tc.name}
                    </p>
                    {tc.result && (
                      <p className="mt-0.5 text-[11px] text-gray-500 line-clamp-3">
                        {tc.result}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Timestamp */}
        <p
          className={cn(
            "mt-1 text-[10px]",
            isOperator ? "text-gray-500 text-right" : "text-cyan-700"
          )}
        >
          {new Date(message.timestamp).toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          })}
        </p>
      </div>

      {/* Avatar for operator */}
      {isOperator && (
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gray-800 border border-gray-700">
          <User className="h-3.5 w-3.5 text-gray-400" />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  AgentChatInterface                                                 */
/* ------------------------------------------------------------------ */

export default function AgentChatInterface({
  className,
}: {
  className?: string;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /* --- Auto-scroll on new messages --- */
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  /* --- Focus input on mount --- */
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  /* --- Send message --- */
  const handleSend = useCallback(
    async (queryText?: string) => {
      const text = (queryText || input).trim();
      if (!text || sending) return;

      // Add operator message
      const operatorMsg: ChatMessage = {
        id: `op-${Date.now()}`,
        role: "operator",
        content: text,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, operatorMsg]);
      setInput("");
      setSending(true);

      try {
        const data = await apiFetch<ChatResponse>("/api/agents/chat", {
          method: "POST",
          body: JSON.stringify({ query: text }),
        });

        const cortexMsg: ChatMessage = {
          id: `cx-${Date.now()}`,
          role: "cortex",
          content: data.response || "No response received.",
          timestamp: new Date().toISOString(),
          tool_calls: data.tool_calls,
        };
        setMessages((prev) => [...prev, cortexMsg]);
      } catch (err) {
        const errorMsg: ChatMessage = {
          id: `err-${Date.now()}`,
          role: "cortex",
          content: `Error: ${
            err instanceof Error ? err.message : "Failed to get response"
          }`,
          timestamp: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, errorMsg]);
      } finally {
        setSending(false);
        inputRef.current?.focus();
      }
    },
    [input, sending]
  );

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    handleSend();
  };

  return (
    <div
      className={cn(
        "flex flex-col rounded-lg border border-gray-800 bg-gray-950",
        className
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-gray-800 px-4 py-3">
        <MessageSquare className="h-4 w-4 text-cyan-400" />
        <h3 className="text-sm font-semibold text-gray-200">
          Operator Chat
        </h3>
        <span className="rounded-full bg-cyan-900/30 border border-cyan-800/40 px-2 py-0.5 text-[10px] font-semibold text-cyan-400">
          CORTEX
        </span>
      </div>

      {/* Messages area */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-4 space-y-4 scrollbar-thin scrollbar-track-gray-950 scrollbar-thumb-gray-800"
      >
        {/* Empty state */}
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center py-8">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-cyan-900/20 border border-cyan-800/30 mb-3">
              <Sparkles className="h-7 w-7 text-cyan-400" />
            </div>
            <p className="text-sm font-medium text-gray-400 mb-1">
              Sentinel Cortex
            </p>
            <p className="text-xs text-gray-600 text-center max-w-[260px]">
              Ask about security status, active threats, or issue commands to
              the agent fleet
            </p>

            {/* Suggested queries */}
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {SUGGESTED_QUERIES.map((q) => (
                <button
                  key={q}
                  onClick={() => handleSend(q)}
                  disabled={sending}
                  className={cn(
                    "rounded-full border border-gray-700 bg-gray-900 px-3 py-1.5 text-xs text-gray-400 transition-colors",
                    "hover:border-cyan-700 hover:bg-cyan-900/20 hover:text-cyan-300",
                    "disabled:opacity-50 disabled:cursor-not-allowed"
                  )}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Message list */}
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {/* Sending indicator */}
        {sending && (
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-cyan-900/40 border border-cyan-800/50">
              <Brain className="h-3.5 w-3.5 text-cyan-400" />
            </div>
            <div className="flex items-center gap-2 rounded-lg bg-cyan-900/30 border border-cyan-800/30 px-3.5 py-2.5 rounded-bl-sm">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-cyan-400" />
              <span className="text-xs text-cyan-400">Analyzing...</span>
            </div>
          </div>
        )}
      </div>

      {/* Suggested queries (when there are messages) */}
      {messages.length > 0 && !sending && (
        <div className="flex items-center gap-1.5 border-t border-gray-800/50 px-4 py-2 overflow-x-auto">
          {SUGGESTED_QUERIES.map((q) => (
            <button
              key={q}
              onClick={() => handleSend(q)}
              className="shrink-0 rounded-full border border-gray-800 bg-gray-900/60 px-2.5 py-1 text-[11px] text-gray-500 hover:border-cyan-700 hover:text-cyan-400 transition-colors"
            >
              {q}
            </button>
          ))}
        </div>
      )}

      {/* Input bar */}
      <form
        onSubmit={handleSubmit}
        className="flex items-center gap-2 border-t border-gray-800 px-4 py-3"
      >
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask Sentinel Cortex..."
          disabled={sending}
          className={cn(
            "flex-1 rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200",
            "placeholder-gray-600 focus:border-cyan-700 focus:outline-none focus:ring-1 focus:ring-cyan-700",
            "disabled:opacity-60"
          )}
        />
        <button
          type="submit"
          disabled={!input.trim() || sending}
          className={cn(
            "flex h-9 w-9 items-center justify-center rounded-lg transition-colors",
            "bg-cyan-900/50 text-cyan-400 border border-cyan-800/60",
            "hover:bg-cyan-800/60 hover:text-cyan-300",
            "disabled:opacity-40 disabled:cursor-not-allowed"
          )}
        >
          {sending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
        </button>
      </form>
    </div>
  );
}
