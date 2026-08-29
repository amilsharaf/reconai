# IMPLEMENTATION ROADMAP

> **Version:** 1.0.0
> **Authority:** High — matches `PROJECT_SUMMARY.md`; do not contradict it.
> **Owner:** Solo build (Razorpay Internship — Track 04)

This roadmap translates the frozen decisions in `PROJECT_SUMMARY.md` into an
executable, day-by-day plan. Unlike a status wishlist, phase status here
reflects **what has actually been built**, updated as work lands — not
aspirational sign-off. A phase's checklist is only checked once it is true in
the repository, not once it is planned.

Each phase follows the same shape WinsFresh uses for its own phases: Purpose,
Prerequisites, Deliverables, Excluded, Validation Checklist, Definition of
Done. The phase *count* is compressed to match an 8-day solo build instead of
WinsFresh's multi-week multi-team schedule — see `PROJECT_SUMMARY.md` §7.

---

## Progress Snapshot

| Phase | Day | Status |
|-------|-----|--------|
| 0 — Scope Freeze & Finance Concepts | Aug 28 | ✅ Complete |
| 1 — Data & Database Foundation | Aug 29 | ✅ Complete |
| 2 — Reconciliation Engine | Aug 30 | ⏳ Planned |
| 3 — Evaluation Framework | Aug 31 | ⏳ Planned |
| 4 — AI Layer | Sep 1 | ⏳ Planned |
| 5 — Dashboard | Sep 2 | ⏳ Planned |
| 6 — Copilot + Polish | Sep 3 | ⏳ Planned (Copilot is stretch) |
| 7 — Submission Prep | Sep 4 | ⏳ Planned |
| 8 — Submit | Sep 5 | ⏳ Planned |

---

# PHASE 0 — Scope Freeze & Finance Concepts

**Day:** Aug 28 · **Priority:** Critical · **Status:** ✅ Complete

## Purpose

Freeze scope in writing before any code exists, and ground the build in the
real payment-reconciliation domain rather than assumptions.

## Deliverables

- Scope frozen: "multi-source payment/settlement reconciliation" — no
  additions after this phase without updating `PROJECT_SUMMARY.md` first.
- Payment lifecycle understood: authorization → capture → settlement → bank
  credit.
- Reconciliation drift causes identified: fees, tax, refunds, timing,
  duplicates — these become the six exception categories used throughout.

## Definition of Done

- ✅ `PROJECT_SUMMARY.md` exists and states the frozen stack and scope.
- ✅ Exception taxonomy (`FEE_MISMATCH`, `MISSING_SETTLEMENT`,
  `AMOUNT_MISMATCH`, `DUPLICATE`, `REFUND`, `TIMING`) is fixed and used
  consistently in the schema, generator, and roadmap.

---

# PHASE 1 — Data & Database Foundation

**Day:** Aug 29 · **Priority:** Critical · **Status:** ✅ Complete

## Purpose

Stand up the persistent schema (with RLS and `audit_logs` from the start, not
retrofitted later) and produce the synthetic dataset the entire project is
evaluated against.

## Prerequisites

✓ Phase 0 — Scope Freeze

## Deliverables

- `database/migrations/00001_extensions_and_utilities.sql` — extensions +
  shared `updated_at` trigger utility.
- `database/migrations/00002_core_schema.sql` — `orders`, `payments`,
  `settlements`, `bank_transactions`, `reconciliation_results`,
  `ground_truth_labels`, `audit_logs`.
- `database/migrations/00003_rls_policies.sql` — RLS enabled on every table;
  `audit_logs` and `ground_truth_labels` locked down (append-only /
  evaluation-only respectively).
- `database/migrations/00004_atomic_functions.sql` — idempotent
  `ingest_bank_transaction_atomic` and `compute_reconciliation_atomic`.
- `scripts/generate_synthetic_data.py` — produces 1,000 records: ~750 normal,
  ~250 split across the six exception categories, with a fixed random seed
  for reproducibility.
- `scripts/load_synthetic_data.py` — loads the generated CSVs into Supabase
  through the atomic RPCs (not raw `INSERT`), so the audit trail exists for
  seed data too.
- Generated dataset committed under `data/synthetic/`.

## Excluded From This Phase

Do NOT implement: the reconciliation engine itself, the evaluation script,
the AI layer, or any dashboard UI. This phase only produces data and the
place to put it.

## Validation Checklist

- [x] All six core tables exist with RLS enabled.
- [x] `audit_logs` has no UPDATE/DELETE policy (immutable by omission, same
      pattern as WinsFresh).
- [x] `ground_truth_labels` is not readable by the `authenticated` role —
      only `service_role`.
- [x] Both atomic functions are `SECURITY DEFINER` with `search_path` pinned
      and resolve caller identity from `auth.uid()`, never a trusted
      parameter.
- [x] Generator produces exactly 1,000 records with an 800/200 dev/test
      split, stratified so both splits contain all six exception types.
- [x] Re-running the generator with the same seed produces an identical
      dataset (byte-identical CSVs).

## Definition of Done

Phase 1 is complete when the schema, RLS, audit trail, and the full 1,000-row
labeled dataset exist and are reproducible. No reconciliation logic exists
yet — this phase is data and persistence only.

---

# PHASE 2 — Reconciliation Engine

**Day:** Aug 30 · **Priority:** Critical · **Status:** ⏳ Planned

## Purpose

Implement the deterministic core that decides whether an order's money
trail is clean — this is the engine the AI layer will later explain, never
replace.

## Prerequisites

✓ Phase 1 — Data & Database Foundation

## Deliverables

- Order ↔ Payment exact match + amount validation.
- Settlement calculation: `gross − fee − tax − refund = expected net`.
- Settlement ↔ Bank match with a configurable date tolerance.
- Duplicate and missing-record detection.
- Confidence scoring for non-ID matches (amount/date/reference candidate
  score) feeding `reconciliation_results.confidence_score`.

## Excluded From This Phase

Do NOT implement: the AI explanation layer, the evaluation script's metrics
reporting, or the dashboard.

## Definition of Done

Every order in the dataset produces a `reconciliation_results` row via
`compute_reconciliation_atomic`, with no reference to `ground_truth_labels`
anywhere in the engine's code path.

---

# PHASE 3 — Evaluation Framework

**Day:** Aug 31 · **Priority:** Critical · **Status:** ⏳ Planned

## Purpose

Prove the engine's accuracy honestly, against labels it has never seen.

## Prerequisites

✓ Phase 2 — Reconciliation Engine

## Deliverables

- Evaluation script reads `ground_truth_labels` (dev split only during
  development) and compares against `reconciliation_results`.
- Precision, recall, F1, false positives, false negatives computed per
  exception category and overall.
- ₹-value impact computed: value reconciled vs. value at risk — not just
  record counts.
- Held-out test split (`split = 'test'`) is only run once, at the end, and
  its result is reported as-is.

## Definition of Done

A single command reproduces the metrics report from a clean database, and
the held-out test numbers are reported even if they are worse than dev.

---

# PHASE 4 — AI Layer

**Day:** Sep 1 · **Priority:** High · **Status:** ⏳ Planned

## Purpose

Turn a structured exception into a plain-language explanation a finance
operator can act on — without letting the model touch the arithmetic.

## Prerequisites

✓ Phase 2 — Reconciliation Engine

## Deliverables

- Exception classifier maps engine output to one of the six categories
  (already computed deterministically — the AI layer explains the existing
  classification, it does not re-derive it).
- Claude API call receives structured evidence (amounts, dates, references)
  and returns an explanation string — never a number that changes the
  reconciliation status.
- Recommendation output surfaced: `AUTO_RECONCILE` / `REVIEW` /
  `INVESTIGATE`.

## Definition of Done

Every `EXCEPTION` or `REVIEW_NEEDED` row has an AI-generated explanation
string, and swapping the explanation model would never change a single
reconciliation number.

---

# PHASE 5 — Dashboard

**Day:** Sep 2 · **Priority:** High · **Status:** ⏳ Planned (trim first if
behind schedule)

## Purpose

Make the engine's output legible.

## Deliverables

- Overview: KPIs (match rate, value reconciled, value at risk) + status
  chart.
- Exceptions table: issue, amount, confidence, priority, filters.
- Transaction investigation page: timeline + evidence + AI explanation.
- *Stretch:* separate audit-log page (fold into investigation page if short
  on time).

## Definition of Done

A finance operator can go from "match rate dropped" to "here's the specific
order, here's why, here's what to do" without touching SQL.

---

# PHASE 6 — Copilot + Polish

**Day:** Sep 3 · **Priority:** Medium (stretch-heavy) · **Status:** ⏳
Planned

## Purpose

Ship the highest-leverage remaining polish; build the Finance Copilot chat
only if every prior phase is done.

## Deliverables

- *Stretch:* Finance Copilot — question → tool call → SQL → verified result
  → explanation.
- Loading / error / empty states across the dashboard.
- Desktop polish (mobile responsiveness is explicitly not a priority for
  this track).

## Definition of Done

Every prior phase's Definition of Done still holds; Copilot ships only if it
doesn't put those at risk.

---

# PHASE 7 — Submission Prep

**Day:** Sep 4 · **Priority:** Critical · **Status:** ⏳ Planned

## Deliverables

- Tested at 50 / 100 / 500 / 1,000 records — confirm consistent results at
  each scale.
- Security pass: no exposed keys, `.env` excluded, RLS verified table by
  table.
- README finished: problem, solution, real metrics, architecture, and
  **honest limitations** — non-negotiable per `PROJECT_SUMMARY.md` §3.
- 3–5 minute demo video recorded.

## Definition of Done

A reviewer with zero prior context can read the README, understand what was
built and what wasn't, and reproduce the metrics.

---

# PHASE 8 — Submit

**Day:** Sep 5 · **Priority:** Critical · **Status:** ⏳ Planned

## Deliverables

- Final test pass — fix critical bugs only, no new building.
- Repository, deployment, and README checked one last time.
- Submit.
