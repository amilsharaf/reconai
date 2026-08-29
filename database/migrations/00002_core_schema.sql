-- ============================================================================
-- Migration: 00002_core_schema.sql
-- Project: ReconAI (Razorpay Internship, Track 04)
-- Phase: 1 — Data & Database Foundation
--
-- Purpose:
--   Create the core reconciliation domain schema:
--     1. orders                 - Merchant order records
--     2. payments                - Captured payments linked to orders
--     3. settlements              - Gross/fee/tax/net settlement breakdown
--     4. bank_transactions         - Actual bank credits
--     5. reconciliation_results     - One row per order: status + evidence
--     6. ground_truth_labels         - Hidden evaluation-only labels
--     7. audit_logs                  - Immutable append-only audit trail
--
-- Money convention:
--   All monetary columns are BIGINT storing integer paise (never floating
--   point), matching WinsFresh's amount_paise pattern.
--
-- Rollback Strategy: Reversible
--   DROP TABLE IF EXISTS public.audit_logs CASCADE;
--   DROP TABLE IF EXISTS public.ground_truth_labels CASCADE;
--   DROP TABLE IF EXISTS public.reconciliation_results CASCADE;
--   DROP TABLE IF EXISTS public.bank_transactions CASCADE;
--   DROP TABLE IF EXISTS public.settlements CASCADE;
--   DROP TABLE IF EXISTS public.payments CASCADE;
--   DROP TABLE IF EXISTS public.orders CASCADE;
--
-- Dependencies:
--   - 00001_extensions_and_utilities.sql (pgcrypto, update_updated_at_column())
--   - Supabase Auth schema (auth.users)
-- ============================================================================

-- ============================================================================
-- 1. Table: orders
-- Purpose: Merchant order records — the anchor entity every other table
--          reconciles against.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_number VARCHAR(32) NOT NULL UNIQUE,
    customer_ref VARCHAR(64) NOT NULL,
    amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
    currency VARCHAR(3) NOT NULL DEFAULT 'INR',
    status VARCHAR(20) NOT NULL DEFAULT 'CREATED'
        CHECK (status IN ('CREATED', 'PAID', 'REFUNDED', 'CANCELLED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON public.orders (status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON public.orders (created_at DESC);

DROP TRIGGER IF EXISTS trg_orders_updated_at ON public.orders;
CREATE TRIGGER trg_orders_updated_at
    BEFORE UPDATE ON public.orders
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE public.orders IS 'Merchant order records - the anchor entity for reconciliation.';

-- ============================================================================
-- 2. Table: payments
-- Purpose: Captured payments linked to orders — the gateway-side record of
--          money moving, including fee and tax that will later be deducted
--          at settlement.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
    payment_ref VARCHAR(64) NOT NULL UNIQUE,
    amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
    fee_paise BIGINT NOT NULL DEFAULT 0 CHECK (fee_paise >= 0),
    tax_paise BIGINT NOT NULL DEFAULT 0 CHECK (tax_paise >= 0),
    refund_amount_paise BIGINT NOT NULL DEFAULT 0 CHECK (refund_amount_paise >= 0),
    method VARCHAR(20) NOT NULL DEFAULT 'UPI'
        CHECK (method IN ('UPI', 'CARD', 'NETBANKING', 'WALLET')),
    status VARCHAR(20) NOT NULL DEFAULT 'CAPTURED'
        CHECK (status IN ('CAPTURED', 'FAILED', 'REFUNDED')),
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_order_id ON public.payments (order_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON public.payments (status);

DROP TRIGGER IF EXISTS trg_payments_updated_at ON public.payments;
CREATE TRIGGER trg_payments_updated_at
    BEFORE UPDATE ON public.payments
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE public.payments IS 'Captured payments linked to orders - gateway-side record including fee and tax.';

-- ============================================================================
-- 3. Table: settlements
-- Purpose: Gross/fee/tax/net settlement breakdown per payment - what the
--          payment gateway says it will credit to the bank account.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.settlements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id UUID NOT NULL REFERENCES public.payments(id) ON DELETE RESTRICT,
    settlement_ref VARCHAR(64) NOT NULL UNIQUE,
    gross_amount_paise BIGINT NOT NULL CHECK (gross_amount_paise >= 0),
    fee_paise BIGINT NOT NULL DEFAULT 0 CHECK (fee_paise >= 0),
    tax_paise BIGINT NOT NULL DEFAULT 0 CHECK (tax_paise >= 0),
    refund_paise BIGINT NOT NULL DEFAULT 0 CHECK (refund_paise >= 0),
    net_amount_paise BIGINT NOT NULL CHECK (net_amount_paise >= 0),
    settlement_date DATE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_settlements_payment_id ON public.settlements (payment_id);
CREATE INDEX IF NOT EXISTS idx_settlements_settlement_date ON public.settlements (settlement_date);

DROP TRIGGER IF EXISTS trg_settlements_updated_at ON public.settlements;
CREATE TRIGGER trg_settlements_updated_at
    BEFORE UPDATE ON public.settlements
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE public.settlements IS 'Gross/fee/tax/net settlement breakdown per payment.';

-- ============================================================================
-- 4. Table: bank_transactions
-- Purpose: Actual bank credits - the ground truth of what money actually
--          moved, independent of what the gateway claims settled.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.bank_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bank_reference VARCHAR(64) NOT NULL UNIQUE,
    utr VARCHAR(32) NOT NULL,
    amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
    transaction_date DATE NOT NULL,
    narration TEXT,
    matched_settlement_id UUID REFERENCES public.settlements(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bank_transactions_matched_settlement ON public.bank_transactions (matched_settlement_id);
CREATE INDEX IF NOT EXISTS idx_bank_transactions_transaction_date ON public.bank_transactions (transaction_date);
CREATE INDEX IF NOT EXISTS idx_bank_transactions_utr ON public.bank_transactions (utr);

COMMENT ON TABLE public.bank_transactions IS 'Actual bank credits - independent record of money that moved.';

-- ============================================================================
-- 5. Table: reconciliation_results
-- Purpose: One row per order — the deterministic engine's verdict, evidence,
--          and the AI layer's explanation. This is the table the dashboard
--          reads from.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.reconciliation_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL UNIQUE REFERENCES public.orders(id) ON DELETE RESTRICT,
    payment_id UUID REFERENCES public.payments(id) ON DELETE SET NULL,
    settlement_id UUID REFERENCES public.settlements(id) ON DELETE SET NULL,
    bank_transaction_id UUID REFERENCES public.bank_transactions(id) ON DELETE SET NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'REVIEW_NEEDED'
        CHECK (status IN ('RECONCILED', 'EXCEPTION', 'REVIEW_NEEDED')),
    issue_type VARCHAR(30)
        CHECK (issue_type IS NULL OR issue_type IN (
            'FEE_MISMATCH', 'MISSING_SETTLEMENT', 'AMOUNT_MISMATCH',
            'DUPLICATE', 'REFUND', 'TIMING'
        )),
    expected_amount_paise BIGINT,
    actual_amount_paise BIGINT,
    difference_paise BIGINT,
    confidence_score NUMERIC(5, 2) CHECK (confidence_score IS NULL OR (confidence_score >= 0 AND confidence_score <= 100)),
    recommendation VARCHAR(20)
        CHECK (recommendation IS NULL OR recommendation IN ('AUTO_RECONCILE', 'REVIEW', 'INVESTIGATE')),
    ai_explanation TEXT,
    reason TEXT,
    resolved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_results_status ON public.reconciliation_results (status);
CREATE INDEX IF NOT EXISTS idx_reconciliation_results_issue_type ON public.reconciliation_results (issue_type);

DROP TRIGGER IF EXISTS trg_reconciliation_results_updated_at ON public.reconciliation_results;
CREATE TRIGGER trg_reconciliation_results_updated_at
    BEFORE UPDATE ON public.reconciliation_results
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE public.reconciliation_results IS 'One row per order: the reconciliation engine verdict, evidence, and AI explanation. Written only via compute_reconciliation_atomic.';

-- ============================================================================
-- 6. Table: ground_truth_labels
-- Purpose: Hidden evaluation-only labels for the synthetic dataset. The
--          reconciliation engine (Phase 2) MUST NEVER query this table -
--          it exists solely for scripts/evaluate.* to score engine output
--          against. Reading it from engine code invalidates every reported
--          metric.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.ground_truth_labels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL UNIQUE REFERENCES public.orders(id) ON DELETE CASCADE,
    is_anomaly BOOLEAN NOT NULL DEFAULT false,
    true_issue_type VARCHAR(30)
        CHECK (true_issue_type IS NULL OR true_issue_type IN (
            'FEE_MISMATCH', 'MISSING_SETTLEMENT', 'AMOUNT_MISMATCH',
            'DUPLICATE', 'REFUND', 'TIMING'
        )),
    split VARCHAR(4) NOT NULL CHECK (split IN ('dev', 'test')),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ground_truth_labels_split ON public.ground_truth_labels (split);

COMMENT ON TABLE public.ground_truth_labels IS 'Hidden evaluation-only labels. The reconciliation engine must never query this table - see database/migrations/00003_rls_policies.sql for the enforcement.';

-- ============================================================================
-- 7. Table: audit_logs
-- Purpose: Immutable append-only audit trail recording every automated
--          reconciliation decision. Same shape as WinsFresh's audit_logs.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(50) NOT NULL,
    entity_id VARCHAR(100),
    old_values JSONB,
    new_values JSONB,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_audit_logs_action CHECK (char_length(action) >= 2)
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_id ON public.audit_logs (actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON public.audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON public.audit_logs (action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON public.audit_logs (entity_type, entity_id);

COMMENT ON TABLE public.audit_logs IS 'Immutable append-only operational audit log for every automated reconciliation decision.';
