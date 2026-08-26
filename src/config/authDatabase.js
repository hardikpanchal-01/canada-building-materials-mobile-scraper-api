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

const AUTH_REST_URL = process.env.AUTH_SUPABASE_URL;
const AUTH_SERVICE_KEY = process.env.AUTH_SUPABASE_SERVICE_KEY;
const AUTH_ANON_KEY = process.env.AUTH_SUPABASE_ANON_KEY;

// Table access for auth_tenant goes through the auth GATEWAY over PostgREST
// (dataBackend: 'rest'): the gateway holds the JWT-scoped role that has
// auth_tenant grants, whereas a direct pool would need those grants granted on
// the shared central-auth DB. This preserves the exact pre-migration behaviour
// while using no `@supabase/*` SDK (thin fetch client, see db/restFetch.js).
function getAuthDbAdmin() {
  return makeClient({
    dataBackend: 'rest',
    schema: 'auth_tenant',
    restUrl: AUTH_REST_URL,
    serviceKey: AUTH_SERVICE_KEY,
    anonKey: AUTH_ANON_KEY,
  });
}

module.exports = {
  getAuthDbAdmin,
};
