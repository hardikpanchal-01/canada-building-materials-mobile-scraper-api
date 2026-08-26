/**
 * Service-role data client for the AI Assistant engine.
 *
 * Table access (ai_chat_threads, ai_audit_log, …) runs on DIRECT Postgres via
 * the shared main pool; the AI database functions (ai_aggregate, ai_select_rows,
 * ai_count, _ai_validate_columns, ai_record_feedback) are served by the thin
 * fetch rpc client against the tenant's self-hosted gateway. No hosted SDK.
 *
 * The export name `dbServer` is preserved so the 13 ai/*.mjs importers are
 * unchanged; it is a plain data client returning `{ data, error }`.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { makeClient } = require('../db/client.js');
const { getPool } = require('../services/database/postgresClient.js');

const restUrl = process.env.SUPABASE_URL;
const serviceKey =
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY;

if (!restUrl) {
  console.warn('[ai/_data] Data gateway URL is not set — AI rpc tools will fail.');
}

export const dbServer = makeClient({
  pool: getPool(),
  schema: 'public',
  restUrl,
  serviceKey,
  anonKey: process.env.SUPABASE_ANON_KEY,
});

export default dbServer;
