/**
 * ReconAI — AI Explanation Call
 *
 * Wraps a single Gemini API call that turns one row's structured evidence
 * (ExceptionEvidence) into a plain-language explanation string. This
 * module never touches Supabase and never sees a raw table — the caller
 * (apps/web/scripts/run-ai-explanations.ts) is responsible for building
 * the evidence object and for persisting the result via
 * set_ai_explanation_atomic().
 *
 * DEVIATION FROM PROJECT_SUMMARY.md §4 (recorded per that document's own
 * rule — "record the change and the reason ... rather than silently
 * drifting"): the frozen decision names "Claude API" for this layer. This
 * was built against Claude first (git history has the claude-opus-5
 * version) and is now Gemini instead, because the Anthropic account in use
 * has no billing set up and cannot purchase credits right now, while a
 * free Gemini API key was available. Reverting to Claude later is a matter
 * of restoring this file's prior version — the rest of the pipeline
 * (evidence shape, prompts, the RPC, the runner) is provider-agnostic and
 * unchanged either way.
 *
 * Uses the REST API directly (Gemini's "Interactions API",
 * POST /v1beta/interactions) rather than the @google/genai SDK: the exact
 * request/response shape below was verified directly against the live API
 * (not guessed from documentation, which was inconsistent about field
 * names across sources at the time of writing) before this file was
 * written, and there's no bundled reference for the current Node SDK's
 * exact TypeScript field casing to verify against instead.
 *
 * Every failure mode (HTTP error, non-"completed" status, empty/unusable
 * output) is caught here and returned as a typed FAILED result — nothing
 * throws past this module, and nothing here ever fabricates a plausible-
 * looking explanation to paper over a failure.
 */

import { buildUserPrompt, SYSTEM_PROMPT } from "./prompts";
import type { ExceptionEvidence, ExplanationResult } from "./types";

const MODEL = "gemini-3.5-flash-lite"; // gemini-3.6-flash's free-tier daily quota (20 req/day) was exhausted mid-run; -lite is a separate model with its own quota pool
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const MAX_OUTPUT_TOKENS = 600;
const MIN_USABLE_LENGTH = 20; // shorter than this isn't a real explanation

interface InteractionStep {
  type: string;
  content?: { type: string; text?: string }[];
}

interface InteractionResponse {
  status?: string;
  steps?: InteractionStep[];
  error?: { message?: string; code?: string | number };
}

const MAX_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 2000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Free-tier Gemini keys have a low requests-per-minute quota. A 429 here is
 * a quota/rate-limit condition, not "the explanation is unusable" — retrying
 * with backoff keeps that distinct from a real FAILED result instead of
 * letting throttling masquerade as bad output quality.
 */
async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(url, init);
    if (response.status !== 429 || attempt === MAX_RETRIES) return response;
    const retryAfterHeader = response.headers.get("retry-after");
    const delay = retryAfterHeader ? Number(retryAfterHeader) * 1000 : RETRY_BASE_DELAY_MS * 2 ** attempt;
    await sleep(delay);
  }
  // Unreachable — the loop above always returns by the final attempt.
  throw new Error("fetchWithRetry: exhausted retries without returning");
}

export async function explainException(evidence: ExceptionEvidence): Promise<ExplanationResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { status: "FAILED", reason: "GEMINI_API_KEY is not set", model: MODEL };
  }

  let httpResponse: Response;
  try {
    httpResponse = await fetchWithRetry(`${ENDPOINT}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `models/${MODEL}`,
        input: buildUserPrompt(evidence),
        system_instruction: SYSTEM_PROMPT,
        generation_config: {
          max_output_tokens: MAX_OUTPUT_TOKENS,
          thinking_level: "low", // bounded, repetitive task — not deep reasoning; keeps cost/quota down
        },
      }),
    });
  } catch (error) {
    return { status: "FAILED", reason: `Network error: ${error instanceof Error ? error.message : String(error)}`, model: MODEL };
  }

  let body: InteractionResponse;
  try {
    body = (await httpResponse.json()) as InteractionResponse;
  } catch {
    return { status: "FAILED", reason: `Non-JSON response, HTTP ${httpResponse.status}`, model: MODEL };
  }

  if (!httpResponse.ok) {
    return { status: "FAILED", reason: `HTTP ${httpResponse.status}: ${body.error?.message ?? "unknown error"}`, model: MODEL };
  }

  if (body.status !== "completed") {
    return { status: "FAILED", reason: `Interaction status was "${body.status ?? "unknown"}", not "completed"`, model: MODEL };
  }

  const outputStep = (body.steps ?? []).find((s) => s.type === "model_output");
  const explanation = (outputStep?.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n")
    .trim();

  if (explanation.length < MIN_USABLE_LENGTH) {
    return { status: "FAILED", reason: `Response too short to be a real explanation (${explanation.length} chars)`, model: MODEL };
  }

  return { status: "COMPLETED", explanation, model: MODEL };
}
