import { createClient } from "@supabase/supabase-js";

/**
 * Service-role Supabase client — bypasses RLS entirely. Only for trusted,
 * server-only contexts (batch jobs, the reconciliation runner), never for
 * anything reachable from a browser request. Mirrors the trust boundary
 * scripts/load_synthetic_data.py already uses via DATABASE_URL directly.
 */
export function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (see .env.example).",
    );
  }
  return createClient(url, key, { auth: { persistSession: false } });
}
