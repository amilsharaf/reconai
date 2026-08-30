-- ============================================================================
-- Migration: 00005_ai_explanation.sql
-- Project: ReconAI (Razorpay Internship, Track 04)
-- Phase: 4 — AI Layer
--
-- Purpose:
--   reconciliation_results.ai_explanation (added in 00002) has existed since
--   Phase 1 but no function could ever write to it — compute_reconciliation_
--   atomic's parameter list doesn't include it, by design (the reconciliation
--   engine's job is the deterministic verdict, not the explanation). This
--   migration adds the write path for Phase 4 specifically:
--
--   1. reconciliation_results.ai_explanation_status — PENDING (default) /
--      COMPLETED / FAILED. Required because a NULL ai_explanation is
--      ambiguous on its own ("never attempted" vs. "attempted and the API
--      call failed") — this column makes the state explicit instead of
--      leaving a blank field that could be misread as "nothing was wrong
--      here" or silently treated as a placeholder.
--   2. set_ai_explanation_atomic — the only sanctioned way to write
--      ai_explanation, same SECURITY DEFINER + audit-trail-in-the-same-
--      transaction pattern as ingest_bank_transaction_atomic and
--      compute_reconciliation_atomic (00004). On FAILED, ai_explanation
--      itself is left untouched (stays NULL on first attempt) — only the
--      status changes — so a failed row is never confused with a
--      successful blank one.
--
-- Affected Objects:
--   - Column: public.reconciliation_results.ai_explanation_status
--   - Function: public.set_ai_explanation_atomic(...)
--
-- Rollback Strategy: Reversible
--   DROP FUNCTION IF EXISTS public.set_ai_explanation_atomic CASCADE;
--   DROP INDEX IF EXISTS public.idx_reconciliation_results_ai_explanation_status;
--   ALTER TABLE public.reconciliation_results DROP COLUMN IF EXISTS ai_explanation_status;
--
-- Dependencies: 00002_core_schema.sql, 00004_atomic_functions.sql
-- ============================================================================

-- ============================================================================
-- 1. Column: ai_explanation_status
-- ============================================================================
ALTER TABLE public.reconciliation_results
    ADD COLUMN IF NOT EXISTS ai_explanation_status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
        CHECK (ai_explanation_status IN ('PENDING', 'COMPLETED', 'FAILED'));

CREATE INDEX IF NOT EXISTS idx_reconciliation_results_ai_explanation_status
    ON public.reconciliation_results (ai_explanation_status);

COMMENT ON COLUMN public.reconciliation_results.ai_explanation_status IS
    'PENDING (default, not yet attempted) / COMPLETED (ai_explanation is real) / FAILED (attempted, API call or validation failed — ai_explanation stays NULL, never a fabricated placeholder). Only meaningful for EXCEPTION/REVIEW_NEEDED rows; RECONCILED rows are never explained and stay PENDING indefinitely.';

-- ============================================================================
-- 2. Function: set_ai_explanation_atomic
-- ============================================================================
CREATE OR REPLACE FUNCTION public.set_ai_explanation_atomic(
    p_reconciliation_result_id UUID,
    p_status VARCHAR(20),           -- 'COMPLETED' or 'FAILED'
    p_ai_explanation TEXT DEFAULT NULL,
    p_model VARCHAR(64) DEFAULT NULL,
    p_failure_reason TEXT DEFAULT NULL,
    p_actor_id UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller_id UUID;
    v_row RECORD;
BEGIN
    IF p_status NOT IN ('COMPLETED', 'FAILED') THEN
        RAISE EXCEPTION 'p_status must be COMPLETED or FAILED, got %', p_status;
    END IF;

    IF p_status = 'COMPLETED' AND (p_ai_explanation IS NULL OR btrim(p_ai_explanation) = '') THEN
        RAISE EXCEPTION 'p_ai_explanation is required when p_status is COMPLETED';
    END IF;

    -- Resolve caller identity (same rule as every other atomic function —
    -- see 00004_atomic_functions.sql header comment).
    IF auth.uid() IS NOT NULL THEN
        v_caller_id := auth.uid();
    ELSE
        v_caller_id := p_actor_id;
    END IF;

    UPDATE public.reconciliation_results
    SET ai_explanation = CASE WHEN p_status = 'COMPLETED' THEN p_ai_explanation ELSE ai_explanation END,
        ai_explanation_status = p_status
    WHERE id = p_reconciliation_result_id
    RETURNING * INTO v_row;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'reconciliation_results row % does not exist', p_reconciliation_result_id;
    END IF;

    -- Audit — every automated AI call is logged, same transaction as the
    -- write, whether it succeeded or failed.
    INSERT INTO public.audit_logs (
        actor_id, action, entity_type, entity_id, new_values, metadata
    ) VALUES (
        v_caller_id,
        CASE WHEN p_status = 'COMPLETED' THEN 'AI_EXPLANATION_GENERATED' ELSE 'AI_EXPLANATION_FAILED' END,
        'reconciliation_result',
        p_reconciliation_result_id::TEXT,
        jsonb_build_object('ai_explanation_status', p_status),
        jsonb_build_object(
            'source', 'set_ai_explanation_atomic',
            'model', p_model,
            'failure_reason', p_failure_reason
        )
    );

    RETURN jsonb_build_object(
        'id', v_row.id,
        'order_id', v_row.order_id,
        'ai_explanation_status', v_row.ai_explanation_status
    );
END;
$$;

COMMENT ON FUNCTION public.set_ai_explanation_atomic IS 'The only sanctioned write path for reconciliation_results.ai_explanation / ai_explanation_status. Writes an audit_logs entry (model, outcome, which row) in the same transaction, whether the AI call succeeded or failed.';
