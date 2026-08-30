-- ============================================================================
-- Migration: 00006_ai_explanation_guard.sql
-- Project: ReconAI (Razorpay Internship, Track 04)
-- Phase: 4 — AI Layer
--
-- Purpose:
--   Fix a real concurrency bug found while running Phase 4 for real: a
--   stopped-but-still-in-flight AI explanation call (a slow retry sleeping
--   through a stale rate-limit backoff) wrote AI_EXPLANATION_FAILED for a
--   row *after* a different, faster call had already legitimately written
--   AI_EXPLANATION_GENERATED for the same row moments earlier. The RPC had
--   no guard against this: it always overwrote ai_explanation_status
--   unconditionally, so a late-arriving FAILED call could stomp a real,
--   already-completed explanation's status — leaving the correct
--   explanation text sitting in the column but flagged FAILED, which is
--   exactly the kind of misleading state Phase 4's own failure-handling
--   requirement exists to prevent.
--
--   Fix: COMPLETED is now sticky. Once a row is COMPLETED, a FAILED call
--   for the same row is accepted (still audited — the failure genuinely
--   happened and that's worth recording) but no longer overwrites the
--   status or the real explanation. Only another COMPLETED call (a
--   deliberate regeneration) can change a COMPLETED row afterward.
--
-- Affected Objects:
--   - Function: public.set_ai_explanation_atomic(...) — replaced in place
--
-- Rollback Strategy: Reversible
--   Re-apply 00005_ai_explanation.sql's original CREATE OR REPLACE to
--   restore the unguarded version.
--
-- Dependencies: 00005_ai_explanation.sql
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
    v_current_status VARCHAR(20);
    v_status_to_apply VARCHAR(20);
BEGIN
    IF p_status NOT IN ('COMPLETED', 'FAILED') THEN
        RAISE EXCEPTION 'p_status must be COMPLETED or FAILED, got %', p_status;
    END IF;

    IF p_status = 'COMPLETED' AND (p_ai_explanation IS NULL OR btrim(p_ai_explanation) = '') THEN
        RAISE EXCEPTION 'p_ai_explanation is required when p_status is COMPLETED';
    END IF;

    IF auth.uid() IS NOT NULL THEN
        v_caller_id := auth.uid();
    ELSE
        v_caller_id := p_actor_id;
    END IF;

    SELECT ai_explanation_status INTO v_current_status
    FROM public.reconciliation_results WHERE id = p_reconciliation_result_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'reconciliation_results row % does not exist', p_reconciliation_result_id;
    END IF;

    -- COMPLETED is sticky: a FAILED call arriving after the row is already
    -- COMPLETED is audited (the failure really happened, somewhere) but
    -- does not touch the row. Any other transition proceeds normally.
    v_status_to_apply := CASE
        WHEN v_current_status = 'COMPLETED' AND p_status = 'FAILED' THEN v_current_status
        ELSE p_status
    END;

    UPDATE public.reconciliation_results
    SET ai_explanation = CASE WHEN v_status_to_apply = 'COMPLETED' AND p_status = 'COMPLETED' THEN p_ai_explanation ELSE ai_explanation END,
        ai_explanation_status = v_status_to_apply
    WHERE id = p_reconciliation_result_id
    RETURNING * INTO v_row;

    INSERT INTO public.audit_logs (
        actor_id, action, entity_type, entity_id, new_values, metadata
    ) VALUES (
        v_caller_id,
        CASE
            WHEN p_status = 'COMPLETED' THEN 'AI_EXPLANATION_GENERATED'
            WHEN v_current_status = 'COMPLETED' THEN 'AI_EXPLANATION_FAILED_IGNORED_ALREADY_COMPLETED'
            ELSE 'AI_EXPLANATION_FAILED'
        END,
        'reconciliation_result',
        p_reconciliation_result_id::TEXT,
        jsonb_build_object('ai_explanation_status', v_status_to_apply, 'requested_status', p_status),
        jsonb_build_object(
            'source', 'set_ai_explanation_atomic',
            'model', p_model,
            'failure_reason', p_failure_reason
        )
    );

    RETURN jsonb_build_object(
        'id', v_row.id,
        'order_id', v_row.order_id,
        'ai_explanation_status', v_row.ai_explanation_status,
        'ignored_stale_failure', (v_current_status = 'COMPLETED' AND p_status = 'FAILED')
    );
END;
$$;

COMMENT ON FUNCTION public.set_ai_explanation_atomic IS 'The only sanctioned write path for reconciliation_results.ai_explanation / ai_explanation_status. COMPLETED is sticky — a later FAILED call for an already-COMPLETED row is audited but does not overwrite it. Writes an audit_logs entry in the same transaction either way.';
