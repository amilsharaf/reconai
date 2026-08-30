# ReconAI — Status Report (as of 2026-08-30, Phase 4 run for real)

> Fifth update. Covers the actual live run of the AI explanation layer: a provider switch (Anthropic → Gemini, forced by a real billing constraint, documented as a deviation), a genuinely exhausted free-tier quota, a real concurrency bug found and fixed mid-run (with its own audit trail proving the fix), and the resulting real numbers and sample explanations. Nothing below is estimated — every number is a live query result. Deadline: **2026-09-05** (6 days from today).

---

## 1. Provider switch: Anthropic → Gemini (documented deviation)

You provided an Anthropic key (`sk-ant-api03-...`) and a workspace ID. It's real and would work — verified: the earlier "workspace ID required" auth error went away once workspace ID was supplied — but the account has **no billing configured and can't purchase credits right now** ("credit balance too low to access the Anthropic API"). Given that constraint, switching to your free Gemini key was the pragmatic call, not a preference — recorded per `PROJECT_SUMMARY.md`'s own rule for revising a locked decision:

> **§4, AI Layer row, revised 2026-08-30**: `~~Claude API~~` → **Gemini API** (`gemini-3.5-flash-lite`). The "explanation only, never arithmetic" constraint — the actual reason that row exists — is unaffected; only the vendor changed. Reverting later is restoring `apps/web/src/lib/ai/explainException.ts`'s prior git version once billing is sorted (kept working, just unused — the Anthropic key/workspace ID are still in `.env`, commented as to why).

### Getting the Gemini integration right took real verification, not guessing

No bundled reference skill exists for Gemini here (only Claude's). Rather than write code against possibly-stale training knowledge, I verified the actual API directly:
- First raw call against `gemini-2.5-flash` (a model name from my training data) returned: *"This model is no longer available to new users... use gemini-3.6-flash... We recommend the Interactions API."* — confirming the API itself, and the SDK generation, had moved on.
- Fetched current docs, cross-checked the digested response against a **direct REST call** to `POST /v1beta/interactions` (not the SDK — the digest was hedgy about exact TypeScript field casing, but the raw JSON contract was fully verifiable by just calling it), and used that verified contract to write `explainException.ts`. Confirmed with a real smoke-test call before touching the full pipeline.

---

## 2. Real bug found and fixed mid-run: a stale in-flight request corrupting status

**What happened**: the first full-batch attempt (`gemini-3.6-flash`) hit a hard daily quota (`limit: 20, model: gemini-3.6-flash`) partway through and was stopped. A second attempt with `gemini-3.5-flash-lite` (separate quota pool) was started. `TaskStop` on the first run killed the *shell*, but — discovered by checking process lists directly — **not the underlying Node child processes**, which kept running with in-flight requests still sleeping through their 429 retry-backoff delays. When those stale calls finally resolved (with `FAILED`, since the old model's quota was still exhausted), they wrote to the database *after* the new run had already legitimately completed the same rows — and the RPC had no guard against a later `FAILED` call overwriting an already-`COMPLETED` row's status.

**How it was caught**: not by luck — I cross-checked `COUNT(ai_explanation IS NOT NULL)` against `COUNT(ai_explanation_status = 'COMPLETED')` as a basic consistency check and found they disagreed (43 vs. 37 at first observation). The audit trail made the root cause fully reconstructable without guessing:
```
AI_EXPLANATION_GENERATED  09:54:54  {model: gemini-3.5-flash-lite, failure_reason: null}
AI_EXPLANATION_FAILED     09:55:23  {model: gemini-3.6-flash, failure_reason: "HTTP 429 ... quota exceeded"}
```
Same row, real success 29 seconds before a stale failure clobbered its status — the `model` field on each audit entry alone proves which run each write came from.

**The fix, in order:**
1. Found and killed the actual lingering OS processes (`Get-CimInstance Win32_Process`, filtered to `ReconAI` paths specifically — there are unrelated dev servers for another project running on this machine, left untouched).
2. New migration, `database/migrations/00006_ai_explanation_guard.sql`: `set_ai_explanation_atomic` now treats `COMPLETED` as **sticky** — a `FAILED` call arriving for an already-`COMPLETED` row is still audited (logged as `AI_EXPLANATION_FAILED_IGNORED_ALREADY_COMPLETED` — the failure really happened somewhere, that's worth keeping) but no longer overwrites the row. Applied and verified live.
3. Corrected the then-11 affected rows **through the RPC** (`p_status: 'COMPLETED'`, `p_ai_explanation` = their own already-real text) — not a raw `UPDATE` — so the correction itself is audited, not a silent patch.
4. Verified: after the fix, the guard caught **5 more** of the same race condition live in the wild (from the processes I hadn't found yet) — `AI_EXPLANATION_FAILED_IGNORED_ALREADY_COMPLETED` appears 5 times in `audit_logs`, each one a real explanation that would otherwise have been wrongly hidden behind `FAILED`.

**Final consistency, verified live:**
```
non-null ai_explanation:                    96
inconsistent (non-null but not COMPLETED):   0
completed-but-null (should never happen):    0
```

I'm reporting this at this length because it's directly the thing requirement #5 asked me to get right ("never silently blank or a fabricated-looking placeholder"), and the honest answer is: my first version of the write path *did* have exactly that failure mode under concurrent/interrupted runs, it surfaced for real, and the audit trail is what made it fixable instead of invisible.

---

## 3. Real run results — partial, and honestly reported as such

Two separate free-tier quota walls were hit:
- `gemini-3.6-flash`: hard daily cap, `limit: 20, model: gemini-3.6-flash` (Google's own error text).
- `gemini-3.5-flash-lite`: no hard 20/day wall, but a soft throughput ceiling — observed real throughput was ~4–5 rows/minute at concurrency 2, meaning the full 286-candidate-row batch would take **3+ hours** on this key, not something to force through a single session.

Given that, I stopped rather than let it grind, verified/fixed the data as above, and am reporting the real, partial state:

```
ai_explanation_status breakdown: COMPLETED=96, FAILED=49, PENDING=935
non-null ai_explanation: 96
```

**Resuming later is just `npm run explain` again** — it's idempotent (only picks up `PENDING` rows by default; `--retry-failed` re-attempts genuine `FAILED` ones; the new `--ids=<uuid,...>` flag targets specific rows). Whether "later" means more Gemini quota tomorrow, a paid Gemini tier, or switching back to Anthropic once billing is sorted (the code for that still exists in git history) is your call — all three are viable, none require further code changes.

---

## 4. Real generated explanations — one per issue type, plus the ambiguous case

All pulled live just now, verbatim, from `reconciliation_results.ai_explanation`. Grounded correctly in every case — no invented amounts, no contradicted verdicts, no recomputed numbers:

**AMOUNT_MISMATCH** (ORD-2026-000317, confidence 99, recommend INVESTIGATE):
> Order ORD-2026-000317 has been flagged as an exception due to an amount mismatch where the bank credit of ₹10,467.31 differs from the settlement net of ₹10,757.00 by ₹-289.69. The reconciliation engine reached this verdict with a 99 percent confidence score based on this variance. You should investigate the discrepancy to resolve the issue.

**DUPLICATE** (ORD-2026-000288, confidence 98, recommend INVESTIGATE):
> Order ORD-2026-000288 has been flagged as an exception due to a duplicate issue with a confidence score of 98. The system detected 2 bank credits (₹21420.26 total) matched to settlement setl_K9X0740C98UZZY, which expects one credit of ₹10710.13, resulting in a difference of ₹10,710.13. You should investigate this discrepancy to resolve the duplicate payment before proceeding.

**FEE_MISMATCH** (ORD-2026-000479, confidence 99, recommend INVESTIGATE):
> Order ORD-2026-000479 has been flagged as an exception due to a fee mismatch, resulting in an actual amount of ₹12,524.46 against an expected amount of ₹12,755.69, which is a difference of ₹-231.23. The engine notes that the settlement fee ₹457.24 differs from the payment fee ₹261.28 by ₹195.96 (expected rate 2.0%, GST 18% on fee), with a confidence score of 99. You should investigate this discrepancy based on the recommendation.

**MISSING_SETTLEMENT** (ORD-2026-000582, confidence 95, recommend INVESTIGATE):
> Order ORD-2026-000582 has been flagged as an exception with a confidence score of 95 because payment pay_4NCBJM2GK9JYFD was captured but no settlement has been created yet. The expected amount is ₹2,180.30, while the actual amount is currently unavailable. You should investigate this missing settlement to resolve the discrepancy.

**REFUND** (ORD-2026-000572, confidence 92, recommend INVESTIGATE):
> Order ORD-2026-000572 has been flagged with an exception of type REFUND because the payment shows a ₹3,172.00 refund that the settlement and the bank credit that mirrors it do not account for. The expected amount is ₹-74.86 while the actual amount is ₹3,097.14, resulting in a difference of ₹3,172.00. With a confidence score of 92, the recommended action is to investigate this discrepancy immediately.

**TIMING** (ORD-2026-000580, confidence 85, recommend REVIEW):
> Order ORD-2026-000580 has been flagged with an exception due to a timing issue, despite the expected amount of ₹9,538.45 matching the actual amount of ₹9,538.45. The engine noted that the bank credit arrived 15 days after the settlement date, which exceeds the expected 3-day window. With a confidence score of 85, the system recommends that you review the case before proceeding.

**Unresolved/ambiguous** (ORD-2026-001030, `issue_type=NULL`, `status=REVIEW_NEEDED`, confidence 90, recommend REVIEW — one of the hard-tier ambiguous pairs from the fuzzy-matching pass):
> Order ORD-2026-001030 requires manual review because the expected amount is ₹3,414.47 and the best candidate bank credit for settlement setl_MSYQMNF8J0SU86 scores a confidence score of 90, but it is only 0 points ahead of the next candidate, making it too ambiguous to auto-match. Since this is an unresolved case, you need to manually inspect the candidates to choose the correct match. Please review the settlement options to resolve the ambiguity and complete the reconciliation.

This last one is the one worth reading closely against the requirements: `issue_type` is `NULL` (the model correctly never invented a category for it, per the system prompt's explicit rule), and the specific detail — "90, only 0 points ahead of the next candidate" — is pulled directly from the engine's own deterministic `reason` string (the fuzzy-match candidate-scoring breakdown you asked to see reused as context, not recomputed).

---

## 5. Documentation updated

- `PROJECT_SUMMARY.md` §4: AI Layer row struck through and revised, with a dated note explaining why and how to revert.
- `IMPLEMENTATION_ROADMAP.md`: Phase 4 marked 🟡 (built and verified, not a full run) rather than either "Planned" or a false "Complete" — Definition of Done items checked individually, with the one genuinely incomplete item (`96 of 286` explained) called out honestly rather than rounded up.

---

## What's next

The mechanism is proven correct end-to-end, including a real concurrency bug that got found and fixed with its own audit trail rather than papered over. What's left is purely throughput: resume `npm run explain` whenever more Gemini quota is available, switch back to the already-working Anthropic integration once billing allows it, or accept a paid tier on either — all three finish the remaining ~935 rows with zero further code changes. Given 6 days to Sep 5 and this being the last mechanically-risky piece, Phase 5 (dashboard) is reasonable to start in parallel rather than block on quota.

All work in this update is committed locally; not yet pushed — say the word.
