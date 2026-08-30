/**
 * ReconAI — AI Explanation Call
 *
 * Wraps a single Anthropic API call that turns one row's structured
 * evidence (ExceptionEvidence) into a plain-language explanation string.
 * This module never touches Supabase and never sees a raw table — the
 * caller (apps/web/scripts/run-ai-explanations.ts) is responsible for
 * building the evidence object and for persisting the result via
 * set_ai_explanation_atomic().
 *
 * Every failure mode (API error, refusal, truncation, empty/unusable
 * output) is caught here and returned as a typed FAILED result — nothing
 * throws past this module, and nothing here ever fabricates a plausible-
 * looking explanation to paper over a failure.
 */

import Anthropic from "@anthropic-ai/sdk";
import { buildUserPrompt, SYSTEM_PROMPT } from "./prompts";
import type { ExceptionEvidence, ExplanationResult } from "./types";

const MODEL = "claude-opus-5";
const MAX_TOKENS = 600;
const MIN_USABLE_LENGTH = 20; // shorter than this isn't a real explanation

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

export async function explainException(evidence: ExceptionEvidence): Promise<ExplanationResult> {
  let response: Anthropic.Message;
  try {
    response = await getClient().messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      output_config: { effort: "medium" },
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: buildUserPrompt(evidence) }],
    });
  } catch (error) {
    return { status: "FAILED", reason: describeApiError(error), model: MODEL };
  }

  if (response.stop_reason === "refusal") {
    const category = response.stop_details?.type === "refusal" ? response.stop_details.category : null;
    return { status: "FAILED", reason: `Model refused${category ? ` (category: ${category})` : ""}`, model: MODEL };
  }

  if (response.stop_reason === "max_tokens") {
    return { status: "FAILED", reason: `Response truncated at max_tokens=${MAX_TOKENS}`, model: MODEL };
  }

  const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text");
  const explanation = textBlocks.map((b) => b.text).join("\n").trim();

  if (explanation.length < MIN_USABLE_LENGTH) {
    return { status: "FAILED", reason: `Response too short to be a real explanation (${explanation.length} chars)`, model: MODEL };
  }

  return { status: "COMPLETED", explanation, model: MODEL };
}

function describeApiError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) return "Authentication error — check ANTHROPIC_API_KEY";
  if (error instanceof Anthropic.RateLimitError) return "Rate limited";
  if (error instanceof Anthropic.BadRequestError) return `Bad request: ${error.message}`;
  if (error instanceof Anthropic.APIConnectionError) return `Connection error: ${error.message}`;
  if (error instanceof Anthropic.APIError) return `API error ${error.status}: ${error.message}`;
  return `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
}
