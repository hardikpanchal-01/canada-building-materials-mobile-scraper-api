/**
 * Central-auth data client (schema `auth_tenant`).
 *
 * The `auth_tenant` tables (tenants, users, tenant_users, auth_codes, …) live in
 * the SHARED central-auth database — a different cluster from the tenant's own
 * database. Table CRUD runs on DIRECT Postgres via a dedicated central-auth pool
 * (CENTRAL_AUTH_DATABASE_URL). Database functions (.rpc) are served by the thin
 * fetch client against the auth gateway (AUTH_SUPABASE_URL).
 *
 * getAuthDbAdmin() keeps its name, its default `auth_tenant` schema and
 * its `{ data, error }` contract, so the 8 call sites are unchanged. Callers
 * still write `.schema('auth_tenant').from(...)`, which is a no-op re-selection
 * of the already-default schema.
 */

const { makeClient } = require('../db/client');
const { getCentralAuthPool } = require('../db/centralAuthPool');

const AUTH_REST_URL = process.env.AUTH_SUPABASE_URL;
const AUTH_SERVICE_KEY = process.env.AUTH_SUPABASE_SERVICE_KEY;
const AUTH_ANON_KEY = process.env.AUTH_SUPABASE_ANON_KEY;

function getAuthDbAdmin() {
  const pool = getCentralAuthPool();
  if (!pool) {
    console.error('[AuthDB] CENTRAL_AUTH_DATABASE_URL is not set — auth_tenant table access is unavailable.');
    // Still return a client so .rpc (fetch to the auth gateway) works; table
    // access will surface a clear error via `{ data, error }`.
  }
  return makeClient({
    pool,
    schema: 'auth_tenant',
    restUrl: AUTH_REST_URL,
    serviceKey: AUTH_SERVICE_KEY,
    anonKey: AUTH_ANON_KEY,
  });
}

module.exports = {
  getAuthDbAdmin,
};
