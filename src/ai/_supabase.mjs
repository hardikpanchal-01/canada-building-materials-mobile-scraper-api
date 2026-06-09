/**
 * Service-role Supabase client for the AI Assistant engine (ported from the
 * web app's `@/supabase/server`). Bypasses RLS — server-side use only.
 *
 * Reuses the backend's existing Supabase env vars. The AI engine talks to the
 * SAME Supabase project the web app uses, so the shared RPCs (ai_aggregate,
 * ai_select_rows, ai_count, _ai_validate_columns) and tables (ai_chat_threads,
 * ai_audit_log) are all available here.
 */

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey =
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl) {
  console.warn('[ai/_supabase] SUPABASE_URL is not set — AI data tools will fail.');
}
if (!process.env.SUPABASE_SERVICE_KEY && !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('[ai/_supabase] No service-role key found; falling back to anon key (RLS may block queries).');
}

export const supabaseServer = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

export default supabaseServer;
