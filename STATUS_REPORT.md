# ReconAI — Status Report (as of 2026-08-30, Phase 4 code complete — live run pending API key)

> Fourth update. Covers Phase 4 (AI explanation layer): what's built and verified, and what's explicitly still pending. **The live run has not happened yet** — `ANTHROPIC_API_KEY` is blank in `.env`, and you asked to set that up separately. Everything below that doesn't say "verified live" is code-complete and typechecked, not yet exercised against the real API. No sample explanations are shown in this report because none have been generated — I'm not going to fabricate what one might look like. Deadline: **2026-09-05** (6 days from today).

---

## What's blocking the live run

`.env`'s `ANTHROPIC_API_KEY` is empty. You said you'll set this up separately. The moment you paste a key here, I can run `npm run explain` (from `apps/web`) against the live 1,080-row dataset and report real output — actual generated explanations for a representative sample (one per issue type, plus an ambiguous-pair case, as you asked for), and a live query confirming how many `reconciliation_results` rows now have `ai_explanation_status = 'COMPLETED'`. None of that exists yet.

---

## 1. A real gap found before writing any code: the existing RPC couldn't write `ai_explanation`

`reconciliation_results.ai_explanation` has existed since Phase 1's schema (`00002_core_schema.sql`), but `compute_reconciliation_atomic`'s parameter list never included it — by design, since that function is the reconciliation engine's write path, and the engine explicitly must never touch the AI-facing columns. There was no sanctioned way to write to `ai_explanation` at all.

Given the project's own rule ("every reconciliation decision is auditable... immutably" — `PROJECT_SUMMARY.md` §3) and your explicit requirement #4 (log the AI call to `audit_logs`), the correct fix was a new migration, not a raw `UPDATE` from the runner script (which would bypass the audit trail the rest of the system relies on).

### `database/migrations/00005_ai_explanation.sql` — applied and verified live

1. **`reconciliation_results.ai_explanation_status`** — `PENDING` (default) / `COMPLETED` / `FAILED`. This exists specifically because a `NULL ai_explanation` on its own is ambiguous — "never attempted" and "attempted, API call failed" look identical without it, which is exactly the "silently blank" failure mode your requirement #5 asked me to avoid.
2. **`set_ai_explanation_atomic(...)`** — the only sanctioned write path. Same pattern as every existing atomic function: `SECURITY DEFINER`, pinned `search_path`, `auth.uid()`-first identity resolution, and an `audit_logs` insert **in the same transaction** as the write — win or fail. On a `FAILED` call, `ai_explanation` itself is left untouched (stays `NULL` on a first attempt) and only `ai_explanation_status` changes, so a failed row can never be mistaken for a real (if unhelpful) explanation.

Verified live after applying:
```
column: ai_explanation_status | character varying | default 'PENDING'
function: set_ai_explanation_atomic — exists
ai_explanation_status breakdown: [('PENDING', 1080)]
```
All 1,080 existing rows correctly backfilled to `PENDING` by the `ALTER TABLE ... DEFAULT`.

---

## 2. AI layer — built, additive, typechecked

### Structured evidence — the actual constraint enforcement

`apps/web/src/lib/ai/types.ts`:
```typescript
export interface ExceptionEvidence {
  reconciliation_result_id: string;
  order_number: string;
  status: Extract<ReconciliationStatus, "EXCEPTION" | "REVIEW_NEEDED">;
  issue_type: IssueType | null;
  expected_amount_rupees: string | null;
  actual_amount_rupees: string | null;
  difference_rupees: string | null;
  confidence_score: number | null;
  recommendation: Recommendation | null;
  deterministic_reason: string;
}
```
Every field is either copied verbatim from an already-computed `reconciliation_results` column, or (amounts) pre-formatted into rupee strings by the evidence builder *before* the model ever sees them — the model is never asked to divide by 100, because your requirement #1 says it "does NOT perform any calculation itself," and I read that as including trivial unit conversion, not just the reconciliation math. There's no separate field for the fuzzy-match candidate-scoring breakdown (requirement #3's "candidate scoring breakdown" for `REVIEW_NEEDED` cases) — it's already inside `deterministic_reason`, since `fuzzyMatch.ts`'s `unresolvedFuzzyVerdict()` writes the best/second-best score and margin directly into that string (e.g. *"Best candidate bank credit for settlement setl_X scores 90% confidence, only 0 points ahead of the next candidate — too ambiguous to auto-match."*). Reusing it here is exactly what requirement #2 asked for ("reuse the deterministic `reason` field as supporting context").

### The real prompt template — `apps/web/src/lib/ai/prompts.ts`

System prompt (frozen, cached via `cache_control: {type: "ephemeral"}` since it's identical on every one of the ~286 calls):
```
You are a reconciliation-exceptions explainer for ReconAI, a payment reconciliation system.

You will be given structured evidence about ONE flagged order: its status, issue type (or none, if unresolved), expected vs. actual amounts, a confidence score, a recommendation, and a deterministic reason string already written by the reconciliation engine.

Your job: turn that evidence into a short, plain-language explanation a finance operator can act on immediately.

Hard rules — these are non-negotiable:
- Use ONLY the evidence provided. Never invent an amount, date, reference, or cause that isn't in the evidence.
- Never perform arithmetic. Every number you use must be copied from the evidence verbatim (already formatted in rupees) — do not add, subtract, convert, or re-derive anything, even something that looks trivial.
- Never contradict or override the given status, issue_type, confidence_score, or recommendation. Your job is to explain the verdict that was already reached, not to second-guess or re-decide it.
- If issue_type is null (an unresolved or ambiguous case — most often a bank credit with no clean reference to a settlement), do not invent a category for it. Explain it as what it is: an unresolved case that needs a human to pick between candidates, using the deterministic reason for the specific detail (e.g. the candidate scores involved).
- Treat the deterministic_reason field as ground truth about *why* the engine reached this verdict — use it as your primary source, not something to editorialize around or contradict.

Output format:
- Plain text only. No markdown, no headers, no bullet points, no preamble like "Here's an explanation:".
- 2-4 sentences. Say what's wrong, why (grounded in the evidence), and what the operator should do next (grounded in the recommendation).
- Write for a finance operator who is busy and needs to triage, not a technical audience.
```

Per-row user prompt (`buildUserPrompt`):
```typescript
export function buildUserPrompt(evidence: ExceptionEvidence): string {
  return `Explain this flagged reconciliation case.

Evidence:
${JSON.stringify(evidence, null, 2)}

Write the explanation now, following the rules and format in your instructions exactly.`;
}
```

### The API call and failure handling — `apps/web/src/lib/ai/explainException.ts`

Model: `claude-opus-5` (per the house default — always Opus 5 unless a different model is explicitly requested), effort `medium` (a deliberate, separate tuning knob from model choice — this is a bounded, repetitive explanation task over ~286 rows, not deep multi-step reasoning, and Opus 5's own guidance calls `medium` the right cost/quality step-down for exactly this shape of workload; happy to bump to `high`/`xhigh` if you'd rather). `max_tokens: 600`. Real code, not paraphrased:

```typescript
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
```

Every failure path — API error (auth/rate-limit/bad-request/connection/other, a most-specific-first typed exception chain, not string matching), a safety refusal, output truncated at `max_tokens`, or a suspiciously short/empty response — returns a typed `FAILED` result with a real reason string. Nothing here can produce a silently blank field or a plausible-looking fabricated placeholder; every path either produces a real model-generated explanation or an explicit, logged failure.

### Runner — `apps/web/scripts/run-ai-explanations.ts`

Fetches `reconciliation_results` rows where `status IN ('EXCEPTION','REVIEW_NEEDED')` and `ai_explanation_status = 'PENDING'` (joined to `orders` for `order_number` only — no other raw table access), builds the evidence, calls `explainException`, and persists via `set_ai_explanation_atomic` — never a direct `UPDATE`. Safe to re-run: only `PENDING` rows are picked up by default; `--retry-failed` opts into re-attempting `FAILED` ones. Concurrency capped at 5 to stay well under any reasonable rate limit for a ~286-row batch.

### SDK version bump

`@anthropic-ai/sdk` was pinned at `^0.30.0` — old enough to predate `output_config.effort`, `stop_details`, and current model IDs entirely (checked: `npm view @anthropic-ai/sdk version` -> `0.122.0` is current). Bumped to `^0.122.0`; `npm install` succeeded, and `npx tsc --noEmit` passes clean against the new types with zero changes needed elsewhere in the codebase.

---

## 3. What's verified vs. what isn't

**Verified (real command output / live queries):**
- Migration `00005` applies cleanly; column + function exist live; all 1,080 rows backfilled to `PENDING`.
- `npx tsc --noEmit` passes clean for the whole `apps/web` project, including the new AI modules, against the upgraded SDK.
- `npm install` succeeded with the SDK bump (50 packages, same 2 pre-existing moderate/high transitive-dependency vulnerabilities as before, unrelated to this change).

**Not yet verified — blocked on the API key:**
- Whether `explainException.ts` actually produces good explanations against real evidence.
- Sample output for each issue type + the ambiguous-pair case, as you asked to see.
- A live count of `ai_explanation_status = 'COMPLETED'` rows.
- Real cost/latency for the ~286-row batch (EXCEPTION: 266 + REVIEW_NEEDED: 20, per the last evaluation run) — my own back-of-envelope estimate is under $2 total at Opus 5 pricing for a batch this size and this short an output, but that's an estimate, not a measurement.

---

## What's next

Send the API key whenever it's ready (paste it here — I'll write it straight to the local, gitignored `.env`, same as the Supabase credentials earlier). The moment that's in place: `npm run explain`, then a live query for the `ai_explanation_status` breakdown, then I'll pull one real explanation per issue type plus the ambiguous-pair case and paste the actual generated text here — not before.
