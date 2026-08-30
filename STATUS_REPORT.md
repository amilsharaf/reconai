# ReconAI — Status Report (as of 2026-08-30, Phase 5 dashboard built)

> Sixth update. Covers the dashboard: three real pages against live Supabase data, two real bugs found and fixed while building it (verified against independent queries, not the UI's own numbers), and a walkthrough of five representative cases. Deadline: **2026-09-05** (6 days from today).

---

## What was built

Three pages, matching the scope decision (Overview+Exceptions share a page; audit trail folds into investigation rather than a separate page):

1. **`/` — Overview + Exceptions.** KPI row, status-breakdown bar chart, filterable/sortable exceptions table.
2. **`/transactions/[id]` — Investigation.** Timeline, evidence panel, AI-explanation panel (visually distinct from the deterministic reason), full audit trail for that row.

Stack additions: **Tailwind CSS v4** (not previously in the project — `PROJECT_SUMMARY.md` never locked a styling approach, so this isn't a deviation from a frozen decision, just filling in an unspecified gap). Data layer (`apps/web/src/lib/dashboard/queries.ts`) uses the service-role Supabase client inside Server Components only — no auth flow exists yet in this project, so this is the same trust boundary the reconciliation/AI runners already use; the key never reaches the browser bundle.

---

## Two real bugs found while building this — verified, not assumed

### 1. Supabase/PostgREST silently caps `.select()` at 1000 rows

First render of the KPI tiles showed **`Pending: 80`** — a status that shouldn't exist, since all 1,080 orders already have a computed `reconciliation_results` row. Cross-checked immediately against a live query rather than trusting the screen:

```
Live query: RECONCILED=794, EXCEPTION=266, REVIEW_NEEDED=20, total=1080, pending=0
Dashboard showed: RECONCILED=783, EXCEPTION=199, REVIEW_NEEDED=18, pending=80
```

Root cause: `getKpis()`'s original query did a bare `.select("status, order_id")` over 1,080 rows — PostgREST's default page cap is 1000, and it does **not** error or warn on truncation, it just silently returns a partial result. My `pending = total - statusRows.length` logic then manufactured a fake "pending" bucket out of the 80 rows that got silently dropped. The 286-row exceptions table query was unaffected (286 < 1000) — which is exactly why the two numbers on the same page disagreed with each other (KPI tiles said 217 unresolved rows; the table's own header said 286) — that inconsistency was the first tell something was wrong, before I even ran the independent check.

**Fix**: rewrote every count to use exact `head: true` count queries (these read PostgREST's `Content-Range` metadata, never subject to the row cap, accurate at any table size), and added a `fetchAllRows()` pagination helper for the one query that has no count-only shortcut — the ₹-value sum, which genuinely needs every row's `amount_paise`.

### 2. The exceptions table rendered all 286 rows unvirtualized, no scroll container

Page height was **13,198px** for the table section alone (`document.body.scrollHeight` measured directly, not eyeballed). Fixed with a bounded `max-h-[600px] overflow-y-auto` wrapper and a sticky header — standard pattern for a table this size, verified afterward: full page height dropped to 1,209px.

### A smaller display bug, also fixed

A clean `RECONCILED` row (`issue_type = NULL`, meaning *no issue at all*) showed **"Unresolved"** in the investigation page's evidence panel — the same label the genuinely-ambiguous `REVIEW_NEEDED` fuzzy-match case uses for *its* null `issue_type`. That's misleading: one case means "nothing wrong," the other means "needs a human to pick." Now shows **"None"** specifically for `RECONCILED`, "Unresolved" only for the real ambiguous case.

---

## Real screenshots / what's actually rendering

**Overview page** (`/`), top section:
```
TOTAL TRANSACTIONS   RECONCILED         EXCEPTIONS   REVIEW NEEDED   VALUE RECONCILED
1,080                794 (73.5% match)  266          20              ₹60,58,372.00

VALUE AT RISK         AI EXPLANATIONS
₹21,09,552.94         96/286 generated so far

Status breakdown: [stacked bar] Reconciled 794 (73.5%) · Exception 266 (24.6%) · Review needed 20 (1.9%) · Pending 0 (0.0%)
```

Filter tested live: selecting "DUPLICATE" in the issue-type dropdown correctly narrowed the table to exactly 42 rows (matching the known DUPLICATE count from the generator), each showing a mix of `Completed` and `Failed` AI-explanation badges. Sort-by-amount tested live: clicking the Amount header re-sorted the (filtered) rows strictly ascending (₹257.00 → ₹353.00 → ₹430.00 → ...).

**Investigation page**, five representative cases walked through end-to-end in the real browser (`get_page_text` output, not paraphrased):

- **RECONCILED** (ORD-2026-000001): clean timeline, all four steps green, "Difference ₹0.00", "Issue type: None", AI panel correctly shows *"Not applicable — this order reconciled cleanly."*
- **EXCEPTION / DUPLICATE** (ORD-2026-000452): timeline's bank-transaction step correctly shows **"(2 credits)"** and lists both — `₹4,288.35 on 2026-06-27` and `₹4,288.35 on 2026-06-28` — not just the anchor id stored on the row. AI explanation present and correctly grounded.
- **REVIEW_NEEDED / ambiguous** (ORD-2026-001030, a fuzzy-match case from Phase 2): timeline shows **"Bank transaction (ambiguous)"**, distinct from "(missing)". Evidence panel: "Issue type: Unresolved" (correctly — this *is* the ambiguous case). Audit trail shows all 3 real historical events in order, including the original `AI_EXPLANATION_FAILED` (quota exhaustion) from the previous session followed by the successful retry — the dashboard is reading real history, not a fresh snapshot.
- **MISSING_SETTLEMENT** (ORD-2026-000777): timeline shows "No settlement has been created yet" and "Bank transaction (missing)" — "No bank credit has arrived yet." AI panel shows the **PENDING** state explicitly: *"Explanation not yet generated for this row."* — never blank.
- **FAILED AI explanation** (ORD-2026-000002, a DUPLICATE): AI panel shows the **FAILED** state explicitly — *"Explanation generation failed for this row. See the audit trail below..."* — and the audit trail directly below it shows the real recorded reason (`Interaction status was "incomplete", not "completed"`).

All five states (`COMPLETED`/`FAILED`/`PENDING` for AI explanations; `found`/`missing`/`ambiguous` for the bank-transaction timeline step) render distinctly and correctly — nothing falls through to a blank space.

---

## KPI verification — independent live query, not the UI's own numbers

Ran the exact same aggregation directly via `psycopg2` against Supabase, separately from anything the dashboard code does, and compared:

| KPI | Live query | Dashboard shows |
|---|---|---|
| Total transactions | 1,080 | 1,080 ✓ |
| Reconciled | 794 | 794 ✓ |
| Exceptions | 266 | 266 ✓ |
| Review needed | 20 | 20 ✓ |
| Pending | 0 | 0 ✓ |
| Match rate | 73.5% | 73.5% ✓ |
| Value reconciled | ₹60,58,372.00 | ₹60,58,372.00 ✓ |
| Value at risk | ₹21,09,552.94 | ₹21,09,552.94 ✓ |
| AI explanations completed | 96 / 286 | 96/286 ✓ |

Every number matches exactly. (These numbers are *after* the two bugs above were fixed — the first attempt at this same cross-check is what caught bug #1 in the first place.)

---

## Other verification

- `npx tsc --noEmit` clean throughout.
- `npm run build` (production build) succeeds: both routes correctly marked dynamic (`ƒ`, `force-dynamic` — always live data, never a stale cached snapshot), no build errors.
- One operational note, not a code bug: running `next build` while `next dev` was still running against the same `.next/` directory crashed the dev server (they share build artifacts and stepped on each other) — restarted cleanly, not a real issue, just don't run both concurrently.
- `next lint` isn't configured in this project (interactive first-run setup, not something a prior phase set up) — out of scope for this task; TypeScript's strict checking is the established correctness gate here.

---

## Roadmap updated

`IMPLEMENTATION_ROADMAP.md`: Phase 5 marked ✅ Complete, deliverables checked off against where the code actually lives, Definition of Done rewritten to describe the actual verification performed (the five-case walkthrough + independent KPI cross-check) rather than restating the aspirational goal.

---

## What's next

All 5 core phases (0–5) are now genuinely built and verified, not just planned. What's left: Phase 4's AI explanations are still only 96/286 complete (free-tier Gemini quota, mechanically proven to work, just rate-limited — resume anytime with `npm run explain`), Phase 6 (Copilot, stretch-only) and Phase 7 (submission prep — README rewrite, security pass, demo video) are untouched. With 6 days to Sep 5, Phase 7's honest-limitations README is probably the next highest-leverage item — it can be written now, incrementally, rather than rushed on the last day, and doesn't block on anything else.

Commits `44bc577` and `571259a` are local, not yet pushed — say the word.
