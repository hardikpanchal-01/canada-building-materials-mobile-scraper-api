/**
 * Main tenant data client.
 *
 * Table CRUD runs on DIRECT Postgres (the tenant's own database via the shared
 * pool in services/database/postgresClient.js). Database functions (.rpc), the
 * GoTrue auth admin surface (.auth) and object storage (.storage) are served by
 * thin fetch clients against the tenant's self-hosted gateway. No hosted
 * data-API SDK is involved.
 *
 * getDb() / getDbAdmin() keep their names and `{ data, error }`
 * return contract so the 24 call sites are unchanged.
 */

const { makeClient } = require('../db/client');
const { getPool } = require('../services/database/postgresClient');

// Gateway base URL + keys (self-hosted REST/auth/storage gateway).
// SUPABASE_URL / *_KEY names are kept because they are also part of the frozen
// mobile-app config contract (see mobileAuthService.js) and the deployment
// secret sets them — renaming the env keys would orphan the live values.
const REST_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!REST_URL) {
  console.warn('⚠️  Data gateway URL (SUPABASE_URL) not configured. RPC/auth/storage calls will be unavailable.');
}

function client() {
  return makeClient({
    pool: getPool(),
    schema: 'public',
    restUrl: REST_URL,
    serviceKey: SERVICE_KEY,
    anonKey: ANON_KEY,
  });
}

// Regular client (formerly anon key). Direct pg has no RLS layer — matches the
// service-gateway behaviour already in use across this API.
function getDb() {
  return client();
}

// Admin client (service role — full access).
function getDbAdmin() {
  return client();
}

module.exports = {
  getDb,
  getDbAdmin,
};
