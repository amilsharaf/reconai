-- ============================================================================
-- Migration: 00001_extensions_and_utilities.sql
-- Project: ReconAI (Razorpay Internship, Track 04)
-- Phase: 1 — Data & Database Foundation
--
-- Purpose:
--   Enable required PostgreSQL extensions for UUID generation and
--   cryptographic operations, and define a shared trigger utility for
--   maintaining updated_at timestamps. Convention carried over from
--   WinsFresh's own 00001 migration.
--
-- Affected Objects:
--   - Extension: pgcrypto
--   - Extension: uuid-ossp
--   - Function: public.update_updated_at_column()
--
-- Rollback Strategy: Reversible
--   DROP FUNCTION IF EXISTS public.update_updated_at_column() CASCADE;
--   DROP EXTENSION IF EXISTS "uuid-ossp";
--   DROP EXTENSION IF EXISTS "pgcrypto";
--
-- Dependencies: None
-- ============================================================================

-- 1. Enable pgcrypto for cryptographic hashing and gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 2. Enable uuid-ossp for legacy UUID utilities if required
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 3. Utility function to automatically set updated_at on row modification
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION public.update_updated_at_column() IS 'Generic trigger function to update updated_at timestamp to current UTC time on modification.';
