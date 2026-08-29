-- ============================================================================
-- Migration: 00004_atomic_functions.sql
-- Project: ReconAI (Razorpay Internship, Track 04)
-- Phase: 1 — Data & Database Foundation
--
-- Purpose:
--   Idempotent core functions - the only sanctioned way to mutate the core
--   financial tables (see 00003_rls_policies.sql). Two distinct idempotency
--   patterns are used, matching the two distinct replay risks in this
--   domain (see PROJECT_SUMMARY.md §7.4 for the full rationale):
--
--   1. ingest_bank_transaction_atomic - "idempotency key, return original"
--      pattern (identical in shape to WinsFresh's create_order_atomic).
--      Re-importing the same bank statement line must never create a
--      second row; it must return the row that already exists.
--
--   2. compute_reconciliation_atomic - "natural key, upsert" pattern.
--      A reconciliation result is recomputed every time new evidence
--      arrives for the same order; ON CONFLICT (order_id) DO UPDATE is the
--      correct idempotency mechanism, not a return-cached-result check.
--
--   Both functions:
--     - Are SECURITY DEFINER with a pinned search_path.
--     - Resolve caller identity from auth.uid() first; a client-supplied
--       p_actor_id is only trusted when auth.uid() IS NULL, i.e. the call
--       is coming from a service-role context (the seed loader, a
--       scheduled job) rather than a spoofable end-user JWT. This mirrors
--       the hardening WinsFresh's own atomic functions were patched to
--       require (see WinsFresh migration 00010).
--     - Write an audit_logs row in the same transaction as the mutation,
--       so no reconciliation decision can exist without an audit trail.
--
-- Affected Objects:
--   - Function: public.ingest_bank_transaction_atomic(...)
--   - Function: public.compute_reconciliation_atomic(...)
--
-- Rollback Strategy: Reversible
--   DROP FUNCTION IF EXISTS public.compute_reconciliation_atomic CASCADE;
--   DROP FUNCTION IF EXISTS public.ingest_bank_transaction_atomic CASCADE;
--
-- Dependencies: 00002_core_schema.sql, 00003_rls_policies.sql
-- ============================================================================

-- ============================================================================
-- 1. Function: ingest_bank_transaction_atomic
-- ============================================================================
CREATE OR REPLACE FUNCTION public.ingest_bank_transaction_atomic(
    p_bank_reference VARCHAR(64),
    p_utr VARCHAR(32),
    p_amount_paise BIGINT,
    p_transaction_date DATE,
    p_narration TEXT DEFAULT NULL,
    p_matched_settlement_id UUID DEFAULT NULL,
    p_actor_id UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller_id UUID;
    v_existing RECORD;
    v_new_id UUID;
BEGIN
    -- 1. Resolve caller identity. p_actor_id is only trusted when there is
    --    no authenticated JWT context (service-role callers, e.g. the
    --    synthetic-data loader) — never as an override for a real session.
    IF auth.uid() IS NOT NULL THEN
        v_caller_id := auth.uid();
    ELSE
        v_caller_id := p_actor_id;
    END IF;

    -- 2. Idempotency check: replaying the same statement line returns the
    --    row that already exists instead of creating a duplicate.
    SELECT id, bank_reference, utr, amount_paise, transaction_date
    INTO v_existing
    FROM public.bank_transactions
    WHERE bank_reference = p_bank_reference;

    IF FOUND THEN
        RETURN jsonb_build_object(
            'id', v_existing.id,
            'bank_reference', v_existing.bank_reference,
            'amount_paise', v_existing.amount_paise,
            'is_idempotent_duplicate', true
        );
    END IF;

    -- 3. Validate
    IF p_amount_paise IS NULL OR p_amount_paise <= 0 THEN
        RAISE EXCEPTION 'Bank transaction amount must be positive';
    END IF;

    IF p_transaction_date IS NULL THEN
        RAISE EXCEPTION 'Bank transaction date is required';
    END IF;

    -- 4. Insert
    INSERT INTO public.bank_transactions (
        bank_reference, utr, amount_paise, transaction_date,
        narration, matched_settlement_id
    ) VALUES (
        p_bank_reference, p_utr, p_amount_paise, p_transaction_date,
        p_narration, p_matched_settlement_id
    ) RETURNING id INTO v_new_id;

    -- 5. Audit
    INSERT INTO public.audit_logs (
        actor_id, action, entity_type, entity_id, new_values, metadata
    ) VALUES (
        v_caller_id,
        'BANK_TRANSACTION_INGESTED',
        'bank_transaction',
        v_new_id::TEXT,
        jsonb_build_object(
            'bank_reference', p_bank_reference,
            'utr', p_utr,
            'amount_paise', p_amount_paise,
            'transaction_date', p_transaction_date
        ),
        jsonb_build_object('source', 'ingest_bank_transaction_atomic')
    );

    RETURN jsonb_build_object(
        'id', v_new_id,
        'bank_reference', p_bank_reference,
        'amount_paise', p_amount_paise,
        'is_idempotent_duplicate', false
    );
END;
$$;

COMMENT ON FUNCTION public.ingest_bank_transaction_atomic IS 'Idempotently ingests a bank statement line: replaying the same bank_reference returns the original row instead of duplicating it. Writes an audit_logs entry.';

-- ============================================================================
-- 2. Function: compute_reconciliation_atomic
-- ============================================================================
CREATE OR REPLACE FUNCTION public.compute_reconciliation_atomic(
    p_order_id UUID,
    p_status VARCHAR(20),
    p_issue_type VARCHAR(30) DEFAULT NULL,
    p_expected_amount_paise BIGINT DEFAULT NULL,
    p_actual_amount_paise BIGINT DEFAULT NULL,
    p_confidence_score NUMERIC(5, 2) DEFAULT NULL,
    p_recommendation VARCHAR(20) DEFAULT NULL,
    p_reason TEXT DEFAULT NULL,
    p_payment_id UUID DEFAULT NULL,
    p_settlement_id UUID DEFAULT NULL,
    p_bank_transaction_id UUID DEFAULT NULL,
    p_actor_id UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller_id UUID;
    v_old RECORD;
    v_new RECORD;
    v_difference_paise BIGINT;
    v_was_update BOOLEAN;
BEGIN
    -- 1. Resolve caller identity (see header comment - same rule as
    --    ingest_bank_transaction_atomic).
    IF auth.uid() IS NOT NULL THEN
        v_caller_id := auth.uid();
    ELSE
        v_caller_id := p_actor_id;
    END IF;

    -- 2. Validate the order exists and lock it, so two concurrent
    --    computations for the same order serialize instead of racing.
    IF NOT EXISTS (SELECT 1 FROM public.orders WHERE id = p_order_id FOR UPDATE) THEN
        RAISE EXCEPTION 'Order % does not exist', p_order_id;
    END IF;

    IF p_expected_amount_paise IS NOT NULL AND p_actual_amount_paise IS NOT NULL THEN
        v_difference_paise := p_actual_amount_paise - p_expected_amount_paise;
    END IF;

    -- 3. Capture prior state (if any) for the audit trail before mutating.
    SELECT * INTO v_old FROM public.reconciliation_results WHERE order_id = p_order_id;
    v_was_update := FOUND;

    -- 4. Upsert by natural key (order_id) — this IS the idempotency
    --    mechanism: recomputing for the same order updates the same row.
    INSERT INTO public.reconciliation_results (
        order_id, payment_id, settlement_id, bank_transaction_id,
        status, issue_type, expected_amount_paise, actual_amount_paise,
        difference_paise, confidence_score, recommendation, reason
    ) VALUES (
        p_order_id, p_payment_id, p_settlement_id, p_bank_transaction_id,
        p_status, p_issue_type, p_expected_amount_paise, p_actual_amount_paise,
        v_difference_paise, p_confidence_score, p_recommendation, p_reason
    )
    ON CONFLICT (order_id) DO UPDATE SET
        payment_id = EXCLUDED.payment_id,
        settlement_id = EXCLUDED.settlement_id,
        bank_transaction_id = EXCLUDED.bank_transaction_id,
        status = EXCLUDED.status,
        issue_type = EXCLUDED.issue_type,
        expected_amount_paise = EXCLUDED.expected_amount_paise,
        actual_amount_paise = EXCLUDED.actual_amount_paise,
        difference_paise = EXCLUDED.difference_paise,
        confidence_score = EXCLUDED.confidence_score,
        recommendation = EXCLUDED.recommendation,
        reason = EXCLUDED.reason
    RETURNING * INTO v_new;

    -- 5. Audit — old_values is NULL on first computation, populated on
    --    every recomputation.
    INSERT INTO public.audit_logs (
        actor_id, action, entity_type, entity_id, old_values, new_values, metadata
    ) VALUES (
        v_caller_id,
        CASE WHEN v_was_update THEN 'RECONCILIATION_RECOMPUTED' ELSE 'RECONCILIATION_COMPUTED' END,
        'reconciliation_result',
        v_new.id::TEXT,
        CASE WHEN v_was_update THEN to_jsonb(v_old) ELSE NULL END,
        to_jsonb(v_new),
        jsonb_build_object('source', 'compute_reconciliation_atomic')
    );

    RETURN jsonb_build_object(
        'id', v_new.id,
        'order_id', v_new.order_id,
        'status', v_new.status,
        'issue_type', v_new.issue_type,
        'was_recomputed', v_was_update
    );
END;
$$;

COMMENT ON FUNCTION public.compute_reconciliation_atomic IS 'Idempotently upserts a reconciliation_results row by order_id (natural-key upsert, not an idempotency-key cache). Writes an audit_logs entry on every computation and recomputation.';
