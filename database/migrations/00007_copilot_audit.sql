-- ============================================================================
-- Migration: 00007_copilot_audit.sql
-- Project: ReconAI (Razorpay Internship, Track 04)
-- Phase: 6 — Finance Copilot
--
-- Purpose:
--   The Copilot never writes to any reconciliation table (it's a read-only
--   Q&A surface backed by the same tool functions the dashboard's data
--   layer uses) — but per the project's "every automated step needs a
--   trail" discipline, every interaction (question asked, which tools were
--   called with what arguments, and the final grounded answer) is still
--   logged, same pattern as every other atomic function: SECURITY DEFINER,
--   pinned search_path, audit_logs write in the same transaction.
--
--   Unlike the other atomic functions, there's no existing row this action
--   mutates — entity_id is NULL (no natural entity), entity_type is the
--   fixed string 'copilot_interaction'.
--
-- Affected Objects:
--   - Function: public.log_copilot_interaction_atomic(...)
--
-- Rollback Strategy: Reversible
--   DROP FUNCTION IF EXISTS public.log_copilot_interaction_atomic CASCADE;
--
-- Dependencies: 00002_core_schema.sql
-- ============================================================================

CREATE OR REPLACE FUNCTION public.log_copilot_interaction_atomic(
    p_question TEXT,
    p_answer TEXT,
    p_tool_calls JSONB,
    p_model VARCHAR(64) DEFAULT NULL,
    p_actor_id UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller_id UUID;
    v_id UUID;
BEGIN
    IF p_question IS NULL OR btrim(p_question) = '' THEN
        RAISE EXCEPTION 'p_question is required';
    END IF;

    IF auth.uid() IS NOT NULL THEN
        v_caller_id := auth.uid();
    ELSE
        v_caller_id := p_actor_id;
    END IF;

    INSERT INTO public.audit_logs (
        actor_id, action, entity_type, entity_id, new_values, metadata
    ) VALUES (
        v_caller_id,
        'COPILOT_QUERY',
        'copilot_interaction',
        NULL,
        jsonb_build_object(
            'question', p_question,
            'answer', p_answer,
            'tool_calls', COALESCE(p_tool_calls, '[]'::jsonb)
        ),
        jsonb_build_object('source', 'log_copilot_interaction_atomic', 'model', p_model)
    )
    RETURNING id INTO v_id;

    RETURN jsonb_build_object('id', v_id);
END;
$$;

COMMENT ON FUNCTION public.log_copilot_interaction_atomic IS 'Logs one Finance Copilot Q&A interaction (question, tool calls with arguments, grounded answer) to audit_logs. The Copilot never writes to any other table — this is its only footprint.';
