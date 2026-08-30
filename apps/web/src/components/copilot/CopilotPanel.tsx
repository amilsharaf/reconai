"use client";

import { useState } from "react";

interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCallRecord[];
  error?: boolean;
}

const SUGGESTIONS = [
  "How much is currently unreconciled?",
  "What are my five largest exceptions?",
  "How many fee mismatches happened?",
];

function ToolCallBlock({ call }: { call: ToolCallRecord }) {
  const argsStr = Object.keys(call.args).length > 0 ? JSON.stringify(call.args) : "()";
  return (
    <div className="mb-2 rounded-md border px-3 py-2" style={{ borderColor: "var(--border)", background: "var(--surface-page)" }}>
      <div className="font-mono text-xs" style={{ color: "var(--accent)" }}>
        🔧 {call.name}{argsStr === "()" ? "()" : `(${argsStr})`}
      </div>
      <pre
        className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap font-mono text-[11px]"
        style={{ color: "var(--ink-secondary)" }}
      >
        {JSON.stringify(call.result, null, 2)}
      </pre>
    </div>
  );
}

export function CopilotPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  async function send(question: string) {
    if (!question.trim() || loading) return;
    setMessages((m) => [...m, { role: "user", content: question }]);
    setInput("");
    setLoading(true);
    try {
      const res = await fetch("/api/copilot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessages((m) => [...m, { role: "assistant", content: data.error ?? "Something went wrong.", error: true }]);
      } else {
        setMessages((m) => [...m, { role: "assistant", content: data.answer, toolCalls: data.toolCalls }]);
      }
    } catch {
      setMessages((m) => [...m, { role: "assistant", content: "Network error — could not reach the Copilot.", error: true }]);
    } finally {
      setLoading(false);
    }
  }

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <div
        className="fixed right-0 top-0 z-50 flex h-full w-[440px] flex-col border-l"
        style={{ background: "var(--surface-card)", borderColor: "var(--border)" }}
      >
        <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: "var(--border)" }}>
          <div>
            <div className="text-sm font-semibold" style={{ color: "var(--ink-primary)" }}>
              Finance Copilot
            </div>
            <div className="text-xs" style={{ color: "var(--ink-muted)" }}>
              Answers are grounded in real tool calls, shown below each reply.
            </div>
          </div>
          <button onClick={onClose} className="text-sm" style={{ color: "var(--ink-muted)" }}>
            ✕
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {messages.length === 0 && (
            <div>
              <p className="text-sm" style={{ color: "var(--ink-secondary)" }}>
                Ask a question about reconciliation status, exceptions, or a specific order.
              </p>
              <div className="mt-3 space-y-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => send(s)}
                    className="block w-full rounded-md border px-3 py-2 text-left text-sm hover:opacity-80"
                    style={{ borderColor: "var(--border)", color: "var(--ink-primary)" }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m, i) => (
            <div key={i}>
              {m.role === "user" ? (
                <div className="ml-8 rounded-lg px-3 py-2 text-sm" style={{ background: "var(--accent-bg)", color: "var(--ink-primary)" }}>
                  {m.content}
                </div>
              ) : (
                <div>
                  {m.toolCalls && m.toolCalls.length > 0 && (
                    <div className="mb-2">
                      {m.toolCalls.map((c, j) => (
                        <ToolCallBlock key={j} call={c} />
                      ))}
                    </div>
                  )}
                  <div
                    className="rounded-lg px-3 py-2 text-sm"
                    style={{
                      background: m.error ? "var(--status-critical-bg)" : "var(--surface-page)",
                      color: m.error ? "var(--status-critical)" : "var(--ink-primary)",
                    }}
                  >
                    {m.content}
                  </div>
                </div>
              )}
            </div>
          ))}

          {loading && (
            <div className="text-sm" style={{ color: "var(--ink-muted)" }}>
              Thinking…
            </div>
          )}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
          className="flex gap-2 border-t p-3"
          style={{ borderColor: "var(--border)" }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask the Copilot…"
            className="flex-1 rounded-md border px-3 py-2 text-sm"
            style={{ borderColor: "var(--border)", color: "var(--ink-primary)" }}
          />
          <button
            type="submit"
            disabled={loading}
            className="rounded-md px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
            style={{ background: "var(--accent)" }}
          >
            Ask
          </button>
        </form>
      </div>
    </>
  );
}
