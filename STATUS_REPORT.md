# ReconAI — Status Report (as of 2026-08-30, Phase 6 Finance Copilot built)

> Seventh update. Covers the Finance Copilot: a tool-calling chat grounded in real Supabase queries, verified against the live Gemini API before any orchestration code was written, all six required exchanges run for real (five in-scope + one out-of-scope), a real grounding leak found and fixed mid-build, and confirmed audit logging for both outcomes. Deadline: **2026-09-05** (5 days from today).

---

## Verifying the API contract before writing orchestration code

No bundled reference exists for Gemini function-calling via the Interactions API (same gap as Phase 4). Rather than guess field names again, every step of the request/response contract was verified directly against the live API first — three guesses were **rejected by the API itself** before landing on the real shape:

```
1st attempt: tools: [{function_declarations: [...]}]        -> "Unknown parameter 'function_declarations'"
2nd attempt: input: [{type: "function_response", ...}]      -> "not supported... Supported values: ... 'function_result' ..."
3rd attempt: input: [{type: "function_result", response: {...}}]  -> "Unknown parameter 'response'"
Working:     input: [{type: "function_result", name, call_id, result: [{type: "text", text: JSON}]}]
```

Confirmed with a working minimal round trip (an `add` tool, `47 + 89 = 136`) before touching any Copilot-specific code. The real contract: a `function_call` step arrives when `status: "requires_action"`; the result is submitted via `previous_interaction_id` plus an `input` array of `function_result` entries, re-sending `tools` on the follow-up request too.

---

## What was built

**Five tools** (`apps/web/src/lib/copilot/tools.ts`), each a real, parameterized Supabase query — not an open-ended SQL executor:

| Tool | Real query |
|---|---|
| `get_summary_stats()` | Same aggregates as the Overview KPIs |
| `get_largest_exceptions(limit, issue_type?)` | Top exceptions/reviews by order amount, optional filter |
| `get_exception_by_order(order_number)` | Full detail for one order, same data the investigation page shows |
| `get_exceptions_by_type()` | Count + total ₹ value per issue type |
| `get_ai_explanation_progress()` | Completed vs. candidate count |

**Orchestration** (`apps/web/src/lib/copilot/orchestrate.ts`): question → Gemini decides which tool(s) to call → real query executes → result fed back → Gemini writes the final answer. Model never sees a raw table, never writes SQL. Amounts are pre-formatted in rupees before the model ever sees them (same never-let-the-model-do-arithmetic rule as Phase 4's AI explanations).

**Migration** `00007_copilot_audit.sql`: `log_copilot_interaction_atomic` — same `SECURITY DEFINER` + audit-trail-in-the-transaction pattern as every other atomic function in this system. Applied and verified live.

**UI**: a slide-over chat panel (`CopilotLauncher` + `CopilotPanel`), launched from the Overview page header. Each assistant turn renders the actual tool call and its raw JSON result **before** the final answer — visibly grounded, not a black box.

---

## A real grounding leak found and fixed mid-build

First working version answered "How much is currently unreconciled?" correctly grounded in real tool numbers, but then did this:

> *"...**286** transactions (266 exceptions + 20 cases needing review)... This represents about **26.5%** of the total transaction volume."*

Both `266 + 20` and `100 − 73.5` are arithmetically correct — and both are the model doing math itself, which the system prompt explicitly forbids ("every number in your answer must be copied from a tool result verbatim"). The tool result only contained the two addends and the match rate separately; the model derived the sum and the complement on its own.

**Fix**: pre-computed `unreconciled_count` and `unreconciled_rate_pct` directly inside `get_summary_stats()`, so there is nothing left for the model to add or subtract. Re-ran the same question — the answer now cites `unreconciled_count: 286` verbatim, copied, not computed. This is worth being honest about as a residual risk category, not something I'd claim is now provably impossible to recur: prompting can reduce this failure mode but a small model can still slip in an unexpected derivation on a differently-phrased question. The fix here closes the two specific derivations that were actually observed; it isn't a formal guarantee against every possible one.

---

## All six required exchanges — real output, not paraphrased

**1. "How much is currently unreconciled?"**
> Tool: `get_summary_stats()` → `{unreconciled_count: 286, unreconciled_rate_pct: 26.5, value_at_risk: "₹21,09,552.94", ...}`
> Answer: *"Based on the current reconciliation data: **Unreconciled transactions:** 286 (26.5% unreconciled rate out of 1,080 total transactions) **Total value at risk:** ₹21,09,552.94 (across exceptions and review-needed items)"*

**2. "What are my five largest exceptions?"**
> Tool: `get_largest_exceptions({limit: 5})` → real top-5 by order amount (₹14,973.00 down to ₹14,835.00)
> Answer: numbered list, order number / amount / issue type / recommendation for each, all copied from the tool result — verified independently: `ORD-2026-000848` at ₹14,973.00 (FEE_MISMATCH) genuinely is the single largest exception in the dataset.

**3. "Why is ORD-2026-001030 unresolved?"**
> Tool: `get_exception_by_order({order_number: "ORD-2026-001030"})` → the real fuzzy-match ambiguous case from Phase 2/3 (confidence 90%, "only 0 points ahead of the next candidate")
> Answer: three-part breakdown (what happened / why it couldn't auto-match / next step), correctly citing the real confidence score and candidate-margin detail from the engine's own deterministic reason — no invented cause.

**4. "How many fee mismatches happened?"**
> Tool: `get_exceptions_by_type()` → full 7-way breakdown; model correctly picked out `FEE_MISMATCH: {count: 42, total_value: "₹3,12,895.00"}`
> Answer: *"There were **42** fee mismatch exceptions, with a total order value of **₹3,12,895.00**."* — matches the known FEE_MISMATCH count from every prior phase's report.

**5. "What's the total settlement value?" — the deliberately imprecise one**
> Tool: `get_summary_stats()` (the only tool with a value figure — there's no tool exposing a raw `settlements` table sum)
> Answer: *"Based on the reconciliation summary, here is the breakdown of the total order values: Value Reconciled: ₹60,58,372.00, Value at Risk: ₹21,09,552.94. **(Note: These figures represent the total order values tracked across all 1,080 transactions in the dataset.)**"*
> This is the answer worth reading closely: the model did **not** claim to be reporting "settlement value" — it correctly reframed to what it actually has (order value) and added an explicit caveat, exactly the "if a tool result only partially or approximately answers the question, say so explicitly" behavior the system prompt asked for.

**6. Out-of-scope — "What's our total company revenue this quarter?"**
> Tool calls: **none** (`toolCalls: []`)
> Answer: *"I cannot answer questions about total company revenue, as our system only tracks payment reconciliation, order values, and settlement exceptions rather than overall company financials or P&L."*
> Clean refusal, no improvised number, no tool called just to have something to point to.

---

## Verified through the real browser UI, not just the underlying function

All six were first run directly against `askCopilot()` (server-side smoke test) to validate the logic fast, then re-verified through the actual dev server + browser: clicked the "Finance Copilot" button, used both a suggested-question button and a typed question, confirmed the tool-call block renders above the answer text in both cases (`get_page_text` output matches what's described above verbatim).

## Audit logging — confirmed firing for both outcomes

```sql
SELECT question, tool_calls, answer FROM audit_logs WHERE action='COPILOT_QUERY';
```
```
1) question: "How much is currently unreconciled?"
   tool_calls: [{name: "get_summary_stats", args: {}, result: {...full real result...}}]
   answer: "Based on the current reconciliation data: ..."

2) question: "What's our total company revenue this quarter?"
   tool_calls: []
   answer: "I cannot answer questions about total company revenue..."
```
Both interactions logged with the full question, every tool call (name + arguments + real result), and the final answer — confirmed live, not assumed from the code.

---

## Other verification

- `npx tsc --noEmit` clean.
- `npm run build` succeeds: `/api/copilot` registered correctly as a dynamic route alongside the existing dashboard routes.

---

## Roadmap updated, honestly not overstated

`IMPLEMENTATION_ROADMAP.md` Phase 6 marked 🟡, not ✅ — the Copilot itself is done and verified, but the phase's other listed deliverable (loading/error/empty states across the *rest* of the Phase 5 dashboard, not just the Copilot panel) was not touched this pass. Also corrected the roadmap's own original wording ("tool call → **SQL**") — the LLM never writes SQL; the five fixed tool functions do, which is the stricter and correct reading of "never the model guessing."

---

## What's next

Phase 6's Copilot is done; the dashboard polish half of Phase 6 (loading/error/empty states outside the Copilot panel) and Phase 7 (submission prep — README rewrite, security pass, demo video) remain. With 5 days to Sep 5, Phase 7's README is still the highest-leverage next item — it's the one deliverable a reviewer reads first, and it can absorb everything reported across all seven of these status updates into one coherent, honest account rather than being written cold on the last day.

Commits `420166f` and `5241fda` are local, not yet pushed — say the word.
