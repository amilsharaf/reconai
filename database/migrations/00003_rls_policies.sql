-- ============================================================================
-- Migration: 00003_rls_policies.sql
-- Project: ReconAI (Razorpay Internship, Track 04)
-- Phase: 1 — Data & Database Foundation
--
-- Purpose:
--   Enable Row Level Security on every table and define the access model.
--
-- Domain-driven deviation from WinsFresh's RLS pattern (see PROJECT_SUMMARY.md
-- §7.3 for the full rationale):
--   ReconAI is an internal finance tool, not a customer-facing platform.
--   There is no anonymous access and no multi-role permission matrix - every
--   authenticated user is finance staff and may read every core table.
--   What IS tightened relative to WinsFresh: direct client writes to the
--   core financial tables are denied outright. All mutation happens through
--   the audited SECURITY DEFINER RPCs in 00004_atomic_functions.sql, which
--   run with the function owner's privileges and therefore bypass RLS on
--   the underlying tables - the same mechanism WinsFresh's own atomic
--   functions rely on, just applied to every write instead of some.
--
--   ground_truth_labels carries no policy for `authenticated` or `anon` at
--   all, so RLS default-denies both. Only `service_role` (which bypasses
--   RLS entirely in Supabase) can read it - i.e. only the evaluation
--   script, never the reconciliation engine or the dashboard.
--
-- Rollback Strategy: Reversible
--   ALTER TABLE public.audit_logs DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.ground_truth_labels DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.reconciliation_results DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.bank_transactions DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.settlements DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.payments DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.orders DISABLE ROW LEVEL SECURITY;
--
-- Dependencies: 00002_core_schema.sql
-- ============================================================================

-- ============================================================================
-- 1. Enable RLS on every table
-- ============================================================================
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reconciliation_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ground_truth_labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 2. Core financial tables — read-only for authenticated staff,
--    no direct client writes (mutation is RPC-only).
-- ============================================================================

-- orders
DROP POLICY IF EXISTS orders_select_policy ON public.orders;
CREATE POLICY orders_select_policy ON public.orders
    FOR SELECT
    USING (auth.uid() IS NOT NULL);

-- payments
DROP POLICY IF EXISTS payments_select_policy ON public.payments;
CREATE POLICY payments_select_policy ON public.payments
    FOR SELECT
    USING (auth.uid() IS NOT NULL);

-- settlements
DROP POLICY IF EXISTS settlements_select_policy ON public.settlements;
CREATE POLICY settlements_select_policy ON public.settlements
    FOR SELECT
    USING (auth.uid() IS NOT NULL);

-- bank_transactions
DROP POLICY IF EXISTS bank_transactions_select_policy ON public.bank_transactions;
CREATE POLICY bank_transactions_select_policy ON public.bank_transactions
    FOR SELECT
    USING (auth.uid() IS NOT NULL);

-- reconciliation_results
DROP POLICY IF EXISTS reconciliation_results_select_policy ON public.reconciliation_results;
CREATE POLICY reconciliation_results_select_policy ON public.reconciliation_results
    FOR SELECT
    USING (auth.uid() IS NOT NULL);

-- No INSERT / UPDATE / DELETE policies are defined for `orders`, `payments`,
-- `settlements`, `bank_transactions`, or `reconciliation_results`. Under RLS,
-- an operation with no matching policy is denied by default - so direct
-- client writes to these five tables are impossible. All mutation happens
-- through ingest_bank_transaction_atomic() and compute_reconciliation_atomic()
-- (SECURITY DEFINER, owned by postgres, bypasses RLS), which also write the
-- corresponding audit_logs entry in the same transaction.

-- ============================================================================
-- 3. ground_truth_labels — no policy for authenticated or anon.
--    RLS default-denies both. Only service_role (bypasses RLS) can read it.
-- ============================================================================
-- Intentionally no CREATE POLICY statements here. See header comment.

-- ============================================================================
-- 4. audit_logs Policies (Immutable Append-Only Audit Trail)
-- ============================================================================

-- Policy: audit_logs_insert_policy
-- Any authenticated request (or the system, with actor_id NULL) can append.
DROP POLICY IF EXISTS audit_logs_insert_policy ON public.audit_logs;
CREATE POLICY audit_logs_insert_policy ON public.audit_logs
    FOR INSERT
    WITH CHECK (
        actor_id IS NULL
        OR actor_id = auth.uid()
    );

-- Policy: audit_logs_select_policy
-- Every authenticated finance-staff user may read the audit trail - there is
-- no separate "view audit logs" permission in this domain (see header note).
DROP POLICY IF EXISTS audit_logs_select_policy ON public.audit_logs;
CREATE POLICY audit_logs_select_policy ON public.audit_logs
    FOR SELECT
    USING (auth.uid() IS NOT NULL);

-- Strict Immutability: NO UPDATE or DELETE policy exists for audit_logs.
-- Omitted policies default to complete denial under RLS - the same
-- immutability pattern WinsFresh uses.
