# PROJECT SUMMARY

> **Repository Entry Point for Humans & AI**
>
> Read this document first. It covers purpose, scope, the frozen technology
> decisions, and how this repository is organized. It replaces the separate
> `PROJECT_OVERVIEW.md` / `PROJECT_CONSTITUTION.md` / `PROJECT_DECISIONS.md`
> split used on other projects — see **§7 Deviations from WinsFresh** for why.

---

## 1. Project Information

| Property | Value |
|----------|-------|
| Project Name | ReconAI |
| Track | Razorpay Internship — Track 04 |
| Product Type | AI-assisted multi-source financial reconciliation engine |
| Team Size | Solo |
| Due Date | 2026-09-05 |
| Repository Version | v1.0 |

---

## 2. Project Summary

ReconAI reconciles money across four independent records of the same business
events — **orders**, **payments**, **settlements**, and **bank transactions** —
and explains, for every rupee, whether it landed where it should have.

Reconciliation drift is caused by fees, tax, refunds, timing gaps, and
duplicate credits. ReconAI detects each of these deterministically, classifies
the exception, and uses an LLM (Claude) to explain the evidence in plain
language — the LLM never performs the arithmetic itself.

```
Orders · Payments · Settlements · Bank
                │
                ▼
   Reconciliation Engine (deterministic)
                │
                ▼
          Exception Engine
                │
                ▼
   AI Layer — explains, never calculates
                │
                ▼
 Reconciled · Exception · Review Needed
                │
                ▼
      Audit Trail → Dashboard
```

The project is judged on **honesty**, not optimism: a 1,000-record synthetic
dataset with hidden ground truth (800 dev / 200 held-out test) exists purely
so precision, recall, F1, and ₹-value impact can be reported without the
engine ever having seen the labels it's scored against.

---

## 3. Non-Negotiable Principles

- Every reconciliation decision is auditable — who/what/when/why, immutably.
- The reconciliation engine is deterministic. The AI layer explains; it never
  computes a number that decides a match or a mismatch.
- Held-out test labels are never read by the engine, only by the evaluation
  script. Leaking them invalidates the entire metric.
- Money is stored as integer paise. Never floating point.
- Honest limitations are reported in the README — a track judged on rigor
  punishes overclaiming more than it punishes gaps.

---

## 4. Technology Stack — Frozen (Architecture Freeze v1)

| Area | Decision | Status |
| :--- | :--- | :--- |
| **Frontend + Backend** | Next.js (App Router) — UI and API routes in one deployable | Locked |
| **Database** | PostgreSQL via Supabase | Locked |
| **Auth / RLS** | Supabase Auth + Postgres Row Level Security | Locked |
| **Data Generator** | Python (pandas) — one-off script, outputs CSV, never touches the live app stack | Locked |
| **AI Layer** | Claude API — explanation and classification only, never arithmetic | Locked |
| **Deployment** | Vercel (app) + Supabase (database) — single target | Locked |
| **Synthetic Dataset** | 1,000 records, 800 dev / 200 held-out test, hidden ground truth | Locked — do not shrink to save time |
| **Testing** | Evaluation-set metrics (precision/recall/F1) are the primary confidence signal, not unit test coverage | Locked |
| **Finance Copilot chat** | Stretch — build only if Day 1–6 finish ahead of schedule | Open, defaults to stretch |

These decisions are locked unless a real requirement forces a revision — if
that happens, record the change and the reason in this document's history
rather than silently drifting.

---

## 5. Repository Structure

```text
ReconAI/
├── README.md
├── PROJECT_SUMMARY.md
├── IMPLEMENTATION_ROADMAP.md
│
├── apps/
│   └── web/                  Next.js app — dashboard + API routes
│       └── src/
│           ├── app/          Routes (App Router)
│           ├── types/        Reconciliation domain types
│           └── lib/          Reconciliation engine, AI adapter, Supabase client
│
├── database/
│   ├── migrations/           Numbered, one migration = one purpose
│   └── seeds/                Loader output / reference
│
├── scripts/
│   ├── generate_synthetic_data.py   Generates the 1,000-record dataset
│   ├── load_synthetic_data.py       Loads generated CSVs into Supabase
│   └── requirements.txt
│
└── data/
    └── synthetic/            Generated CSVs (orders, payments, settlements,
                               bank_transactions, ground_truth_labels)
```

There is intentionally no `packages/` workspace split. See §7.

---

## 6. Business Domain

### Core tables

| Table | Purpose |
|-------|---------|
| `orders` | Merchant order records |
| `payments` | Captured payments linked to orders — amount, fee, tax, refund |
| `settlements` | Gross/fee/tax/net settlement breakdown per payment |
| `bank_transactions` | Actual bank credits |
| `reconciliation_results` | One row per order: status, expected vs actual, confidence, recommendation |
| `ground_truth_labels` | Hidden labels for evaluation only — the engine must never query this table |
| `audit_logs` | Immutable append-only trail of every automated decision |

### Exception categories

`FEE_MISMATCH` · `MISSING_SETTLEMENT` · `AMOUNT_MISMATCH` · `DUPLICATE` ·
`REFUND` · `TIMING`

### Recommendation output

`AUTO_RECONCILE` · `REVIEW` · `INVESTIGATE`

---

## 7. Deviations from WinsFresh — and why

This project reuses WinsFresh's engineering discipline (frozen stack decided
up front, feature-first structure, RLS + `audit_logs` from day one, idempotent
core functions, a roadmap that tracks real completion) but is a **solo,
8-day, single-application build**, not a multi-year multi-app platform.
Copying WinsFresh's document count and package count onto this scope would be
the same mistake WinsFresh's own constitution warns against — premature
abstraction. Specific deviations:

1. **One summary document, not four.** WinsFresh splits orientation across
   `PROJECT_OVERVIEW.md` / `PROJECT_CONSTITUTION.md` / `PROJECT_DECISIONS.md`
   because a multi-contributor platform needs a durable, amendable
   constitution separate from a day-to-day overview. A solo 8-day build has
   one author and one thread of work — splitting the same information across
   four files would be pure ceremony. This file merges all three roles.

2. **No `packages/` workspace.** WinsFresh has four applications
   (`customer`, `admin`, `pos`, `delivery`) sharing one inventory — that's
   *why* `packages/shared`, `packages/types`, etc. exist: to give four
   consumers one implementation. ReconAI has exactly one application
   (`apps/web`). Shared types and the reconciliation engine live in
   `apps/web/src/{types,lib}` until a second consumer actually exists.
   Resurrecting the package split before that happens would violate
   WinsFresh's own "avoid premature abstractions" rule, not follow it.

3. **RLS is simpler, not because it's less rigorous, but because the domain
   is.** WinsFresh serves anonymous customers, so its RLS distinguishes
   public/anonymous access from staff roles across many tables. ReconAI is an
   internal finance tool with no public-facing rows at all — every table
   requires authentication, and every mutation goes through an audited
   `SECURITY DEFINER` RPC rather than direct table writes (see
   `database/migrations/00003_rls_policies.sql`). This is a tightening of
   WinsFresh's own direction (WinsFresh's later migrations, `00010`–`00017`,
   moved *toward* exactly this — hardening RPCs against direct writes and
   caller-parameter spoofing). ReconAI starts there instead of migrating
   there.

4. **Idempotency pattern is applied to ingestion, not order creation.**
   WinsFresh's idempotency key exists because a customer can double-submit a
   checkout — the correct behavior is "return the original result, create
   nothing new." ReconAI's equivalent replay risk is re-importing the same
   bank statement or settlement file — `ingest_bank_transaction_atomic`
   copies that exact pattern (idempotency key checked first, return existing
   row on replay). Reconciliation *results*, by contrast, are recomputed as
   new data arrives for the same order — so `compute_reconciliation_atomic`
   is idempotent by natural key (`ON CONFLICT (order_id) DO UPDATE`) instead.
   Both are legitimate idempotency patterns; WinsFresh only needed the first
   because it only has create-once entities.

5. **No POS-style offline sync, no soft-delete-everywhere.** WinsFresh's
   architecture invariants (soft delete, offline-first POS, WhatsApp
   notifications) come from retail operations that don't exist here.
   Reconciliation records are never deleted at all — they're immutable
   financial history — so soft delete is not just skipped, it's the wrong
   tool: `reconciliation_results` rows are corrected by inserting a new
   `audit_logs` entry and updating the row via the atomic RPC, never by
   marking anything as deleted.

6. **Backend is Next.js API routes only, not "Edge Functions or Next.js."**
   The roadmap's locked decision named both as options to match WinsFresh's
   stack family. Splitting business logic across two runtimes (Node in
   Next.js, Deno in Edge Functions) would be the exact kind of duplicated
   implementation WinsFresh's constitution forbids. Next.js API routes alone
   satisfy "single deployment target," so that's the one implementation.
