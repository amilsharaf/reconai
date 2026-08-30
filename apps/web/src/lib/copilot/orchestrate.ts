/**
 * ReconAI — Finance Copilot Orchestration
 *
 * The loop: user question -> Gemini decides which tool(s) to call -> we
 * execute the real Supabase-backed tool function -> result goes back to
 * Gemini -> Gemini writes the final answer grounded in that real result.
 * Gemini never writes SQL and never sees a raw table — only the fixed
 * tool declarations and their JSON results (src/lib/copilot/tools.ts).
 *
 * Verified directly against the live Gemini Interactions API before
 * writing this (not guessed): a function_call step arrives with
 * status="requires_action"; the result is submitted back via
 * previous_interaction_id + an input array of {type:"function_result",
 * name, call_id, result:[{type:"text", text: JSON}]} entries, re-sending
 * `tools` on that follow-up request too.
 */

import { TOOL_DECLARATIONS, callTool } from "./tools";

const MODEL = "gemini-3.5-flash-lite";
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const MAX_TOOL_ROUNDS = 4; // safety cap against a runaway tool-call loop

const SYSTEM_PROMPT = `You are ReconAI's Finance Copilot — a chat assistant for a payment reconciliation system.

You have exactly five tools, each backed by a real, live database query. You have NO other source of information about this system's data — you cannot see any table directly, and you must never write or reason out SQL yourself.

Hard rules:
- For ANY question about counts, amounts, specific orders, exception types, or reconciliation/AI-explanation status, you MUST call one of your five tools and base your answer only on its real result. Never estimate, guess, or answer from memory or general reasoning about what the numbers "probably" are.
- Never perform arithmetic yourself. Every number in your answer must be copied from a tool result verbatim (amounts are already formatted in rupees).
- If none of your five tools can actually answer the question — it asks for something outside this schema (e.g. company revenue/P&L, predictions, opinions, anything this system doesn't track) — say so plainly, in one or two sentences. Do not call a tool that doesn't really address the question just to have something to point to, and do not improvise an answer.
- If a tool result only partially or approximately answers the question, say so explicitly rather than presenting it as more precise than it is.
- Keep answers short: 2-4 sentences, plain language, citing the actual figures.`;

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
}

export interface CopilotResult {
  answer: string;
  toolCalls: ToolCallRecord[];
  model: string;
}

interface InteractionStep {
  type: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  content?: { type: string; text?: string }[];
}

interface InteractionResponse {
  id?: string;
  status?: string;
  steps?: InteractionStep[];
  error?: { message?: string };
}

async function callInteractionsApi(body: Record<string, unknown>): Promise<InteractionResponse> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const res = await fetch(`${ENDPOINT}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as InteractionResponse;
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${json.error?.message ?? "unknown error"}`);
  return json;
}

export async function askCopilot(question: string): Promise<CopilotResult> {
  const toolCalls: ToolCallRecord[] = [];

  let response = await callInteractionsApi({
    model: `models/${MODEL}`,
    input: question,
    system_instruction: SYSTEM_PROMPT,
    tools: TOOL_DECLARATIONS,
    generation_config: { max_output_tokens: 700, thinking_level: "low" },
  });

  let rounds = 0;
  while (response.status === "requires_action" && rounds < MAX_TOOL_ROUNDS) {
    rounds++;
    const calls = (response.steps ?? []).filter((s) => s.type === "function_call");
    if (calls.length === 0) break;

    const resultInputs = await Promise.all(
      calls.map(async (call) => {
        const name = call.name ?? "";
        const args = call.arguments ?? {};
        let result: unknown;
        try {
          result = await callTool(name, args);
        } catch (error) {
          result = { error: error instanceof Error ? error.message : String(error) };
        }
        toolCalls.push({ name, args, result });
        return {
          type: "function_result",
          name,
          call_id: call.id,
          result: [{ type: "text", text: JSON.stringify(result) }],
        };
      }),
    );

    response = await callInteractionsApi({
      model: `models/${MODEL}`,
      previous_interaction_id: response.id,
      tools: TOOL_DECLARATIONS,
      input: resultInputs,
    });
  }

  const textStep = (response.steps ?? []).find((s) => s.type === "model_output");
  const answer =
    (textStep?.content ?? [])
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n")
      .trim() || "I wasn't able to produce an answer for that — please try rephrasing.";

  return { answer, toolCalls, model: MODEL };
}
